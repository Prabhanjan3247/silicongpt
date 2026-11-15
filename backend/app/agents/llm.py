"""Claude client used by every SiliconGPT engineering agent.

One entry point, :meth:`LLMClient.structured`, sends a system prompt plus one user message to
the Messages API and returns the JSON object Claude produced under a strict JSON schema
(``output_config.format``). Streaming is always used (long outputs, no HTTP timeouts) and the
final message is read with ``get_final_message()``.

Rules implemented here (CONTRACTS.md section 3.5):
* model from ``settings.sgpt_model``; effort is explicit on every call (Opus 5.5 defaults to
  ``medium`` otherwise); no ``thinking``/``temperature``/``top_p``/prefill (400 on this model).
* ``settings.sgpt_ai_fallbacks`` -> beta server-side refusal fallbacks (``fallbacks="default"``);
  a 400 that mentions fallbacks is retried once on the plain endpoint (and the beta is not
  sent again by this client).
* only ``text`` blocks are read (thinking / fallback marker blocks are ignored). On a streaming
  request a mid-output fallback model *continues* the declined model's partial text, so the
  answer is the concatenation of all text blocks; the text after the last ``fallback`` marker
  is tried as well in case the fallback model restarted the answer.
* ``refusal`` / ``max_tokens`` stop reasons, invalid JSON and API failures become
  :class:`AIResponseError`; missing or rejected credentials become :class:`AIUnavailableError`.
* the API key is read from settings/env only and is never logged or put in an error message.

The second half of the module holds small helpers shared by the agent modules (schema
validation of answers, file normalisation, safe file names, module-name extraction, the
agent call wrapper).
"""
from __future__ import annotations

import copy
import json
import logging
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterable

import anthropic

try:  # anthropic >= 1.0 is built on httpx2; older releases on httpx
    import httpx2 as _http
except ImportError:  # pragma: no cover
    import httpx as _http  # type: ignore[no-redef]

from ..core.config import get_settings

log = logging.getLogger(__name__)

FALLBACK_BETA = "server-side-fallback-2026-07-01"
EFFORTS = ("low", "medium", "high", "xhigh", "max")
DEFAULT_MAX_TOKENS = 32000
MISSING_CREDENTIALS_MESSAGE = ("Claude API credentials not configured. Set ANTHROPIC_API_KEY in "
                               "backend/.env and restart the backend.")


# ---------------------------------------------------------------------------------------------
# Errors and result types
# ---------------------------------------------------------------------------------------------
class AIUnavailableError(Exception):
    """No credentials, or the credentials were rejected (the API maps this to HTTP 503)."""


class AIResponseError(Exception):
    """Claude did not produce a usable answer: refusal, truncation, invalid JSON, API/network
    failure or an answer that failed post-validation (the API maps this to HTTP 502).
    ``meta`` carries agent/model/token usage when a response was received."""

    def __init__(self, message: str, *, meta: dict | None = None) -> None:
        super().__init__(message)
        self.meta = dict(meta or {})


class AIInputError(ValueError):
    """The request handed to an agent is invalid (empty spec, unknown goal/language/mode,
    oversized design, duplicate files...). Caller error: map to HTTP 400."""


@dataclass
class LLMResult:
    data: dict
    model: str
    input_tokens: int
    output_tokens: int
    duration_ms: int
    stop_reason: str


@dataclass
class AgentOutput:
    data: dict  # agent-specific shape (CONTRACTS.md section 3.5)
    meta: dict = field(default_factory=dict)  # agent, model, input_tokens, output_tokens, duration_ms, stop_reason


# ---------------------------------------------------------------------------------------------
# Strict JSON schema
# ---------------------------------------------------------------------------------------------
# Constraint keywords the structured-output grammar does not support. Dropping them keeps the
# request valid; agents re-check anything that matters after the response arrives.
_UNSUPPORTED_KEYWORDS = frozenset({
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "minItems", "maxItems", "uniqueItems",
    "minProperties", "maxProperties", "patternProperties",
})
_SCHEMA_MAPS = ("properties", "$defs", "definitions")
_SCHEMA_LISTS = ("anyOf", "allOf", "oneOf", "prefixItems")
_SCHEMA_SINGLE = ("items", "not", "contains")


def strict_schema(schema: dict) -> dict:
    """Return a strict deep copy of ``schema``: every object gets ``additionalProperties: false``
    and ``required`` = all of its property keys (recursively, including array items, anyOf
    branches and $defs). Literal values (enum/const/default) are copied untouched."""
    if not isinstance(schema, dict):
        raise TypeError("schema must be a dict")
    return _strict(schema)


def _strict(node: Any) -> Any:
    if not isinstance(node, dict):
        return copy.deepcopy(node)
    out: dict = {}
    for key, value in node.items():
        if key in _UNSUPPORTED_KEYWORDS:
            continue
        if key in _SCHEMA_MAPS and isinstance(value, dict):
            out[key] = {name: _strict(sub) for name, sub in value.items()}
        elif key in _SCHEMA_LISTS and isinstance(value, list):
            out[key] = [_strict(sub) for sub in value]
        elif key in _SCHEMA_SINGLE and isinstance(value, dict):
            out[key] = _strict(value)
        else:
            out[key] = copy.deepcopy(value)
    types = out.get("type")
    if types == "object" or (isinstance(types, list) and "object" in types) or "properties" in out:
        props = out.setdefault("properties", {})
        out["required"] = list(props.keys())
        out["additionalProperties"] = False
    return out


# ---------------------------------------------------------------------------------------------
# Answer validation against a (strict) schema
# ---------------------------------------------------------------------------------------------
def _type_ok(value: Any, json_type: str) -> bool:
    if json_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if json_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if json_type == "boolean":
        return isinstance(value, bool)
    if json_type == "null":
        return value is None
    expected = {"string": str, "array": list, "object": dict}.get(json_type)
    return expected is None or isinstance(value, expected)


def _type_name(value: Any) -> str:
    return {bool: "boolean", int: "integer", float: "number", str: "string", list: "array",
            dict: "object", type(None): "null"}.get(type(value), type(value).__name__)


def schema_errors(data: Any, schema: dict, *, limit: int = 5) -> list[str]:
    """Problems found when checking ``data`` against ``schema`` (type, enum, required,
    additionalProperties, items, anyOf, local $ref). Empty list when the data conforms."""
    errors: list[str] = []
    defs = dict(schema.get("$defs") or {}, **(schema.get("definitions") or {}))
    _check_node(data, schema, "$", errors, limit, defs)
    return errors


def _check_node(value: Any, node: Any, path: str, errors: list[str], limit: int, defs: dict) -> None:
    if len(errors) >= limit or not isinstance(node, dict):
        return
    ref = node.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/"):
        node = defs.get(ref.rsplit("/", 1)[-1], {})
    branches = node.get("anyOf") or node.get("oneOf")
    if isinstance(branches, list) and branches:
        if not any(not _probe(value, b, defs) for b in branches):
            errors.append(f"{path}: value matches none of the allowed alternatives")
        return
    json_type = node.get("type")
    if json_type is not None:
        types = json_type if isinstance(json_type, list) else [json_type]
        if not any(_type_ok(value, t) for t in types):
            errors.append(f"{path}: expected {'/'.join(map(str, types))}, got {_type_name(value)}")
            return
    if "enum" in node and value not in node["enum"]:
        errors.append(f"{path}: {str(value)[:60]!r} is not one of {node['enum']}")
        return
    if "const" in node and value != node["const"]:
        errors.append(f"{path}: expected the constant {node['const']!r}")
        return
    if isinstance(value, dict) and ("properties" in node or "required" in node):
        props = node.get("properties") or {}
        for key in node.get("required") or []:
            if key not in value:
                errors.append(f"{path}: missing field '{key}'")
        if node.get("additionalProperties") is False:
            extra = [k for k in value if k not in props]
            if extra:
                errors.append(f"{path}: unexpected field(s) {', '.join(map(str, extra))}")
        for key, sub in props.items():
            if key in value:
                _check_node(value[key], sub, f"{path}.{key}", errors, limit, defs)
    if isinstance(value, list) and isinstance(node.get("items"), dict):
        for i, item in enumerate(value):
            _check_node(item, node["items"], f"{path}[{i}]", errors, limit, defs)


def _probe(value: Any, node: Any, defs: dict) -> list[str]:
    errs: list[str] = []
    _check_node(value, node, "$", errs, 1, defs)
    return errs


# ---------------------------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------------------------
_KEY_PATTERN = re.compile(r"sk-ant-[A-Za-z0-9_\-]+")


def _build_client(settings: Any) -> Any:
    timeout = float(settings.sgpt_ai_timeout_s)
    if settings.anthropic_api_key:
        return anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=timeout)
    if os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"):
        return anthropic.Anthropic(timeout=timeout)  # the SDK reads the env credentials itself
    raise AIUnavailableError(MISSING_CREDENTIALS_MESSAGE)


def _safe_text(text: Any, key: str | None = None, limit: int = 300) -> str:
    """Short, single-line, secret-free rendering of an API-provided message."""
    s = " ".join(str(text or "").split())
    if key:
        s = s.replace(key, "***")
    s = _KEY_PATTERN.sub("sk-ant-***", s)
    return s if len(s) <= limit else s[: limit - 3] + "..."


def _mentions_fallback(exc: Exception) -> bool:
    parts = [str(exc), str(getattr(exc, "api_message", "") or ""), str(getattr(exc, "body", "") or "")]
    return "fallback" in " ".join(parts).lower()


def _map_api_error(exc: Exception, settings: Any) -> Exception:
    """Translate an SDK exception into a safe, user-facing error (most specific first)."""
    key = getattr(settings, "anthropic_api_key", None)
    rid = getattr(exc, "request_id", None)
    rid_txt = f" (request id {rid})" if isinstance(rid, str) and rid else ""
    if isinstance(exc, anthropic.AuthenticationError):
        return AIUnavailableError("Claude API authentication failed (HTTP 401). Check ANTHROPIC_API_KEY "
                                  "in backend/.env and restart the backend.")
    if isinstance(exc, anthropic.PermissionDeniedError):
        return AIUnavailableError(f"Claude API permission denied (HTTP 403): the configured credentials "
                                  f"cannot use model '{settings.sgpt_model}'.")
    if isinstance(exc, anthropic.RateLimitError):
        return AIResponseError(f"Claude API rate limit reached (HTTP 429); retry in a moment{rid_txt}.")
    if isinstance(exc, anthropic.APIStatusError):
        detail = _safe_text(getattr(exc, "api_message", None), key)
        status = getattr(exc, "status_code", "?")
        return AIResponseError(f"Claude API error (HTTP {status}){': ' + detail if detail else ''}{rid_txt}.")
    if isinstance(exc, anthropic.APITimeoutError):
        return AIResponseError(f"Claude API request timed out (limit {float(settings.sgpt_ai_timeout_s):g} s).")
    if isinstance(exc, anthropic.APIConnectionError):
        return AIResponseError("Could not reach the Claude API (network connection error).")
    if isinstance(exc, anthropic.CredentialsError):
        return AIUnavailableError(MISSING_CREDENTIALS_MESSAGE)
    # Raised while the SSE stream is being read: the SDK re-raises transport errors unwrapped.
    if isinstance(exc, _http.TimeoutException):
        return AIResponseError(f"Claude API stream timed out (limit {float(settings.sgpt_ai_timeout_s):g} s).")
    if isinstance(exc, _http.HTTPError):
        return AIResponseError("The connection to the Claude API was interrupted while the answer was streaming; "
                               "retry.")
    return AIResponseError(f"Claude API client error ({type(exc).__name__}).")


def _response_texts(msg: Any) -> tuple[str, str]:
    """(all text, text after the last ``fallback`` marker) of the final message.

    Thinking and other non-text blocks are ignored. With server-side fallbacks on a stream,
    the fallback model continues the declined model's partial text (only text blocks are
    passed on as context), so the complete answer is the concatenation of every text block.
    The second value covers a fallback model that restarted its answer instead."""
    blocks = list(getattr(msg, "content", None) or [])
    last_marker = -1
    for i, block in enumerate(blocks):
        if getattr(block, "type", None) == "fallback":
            last_marker = i

    def join(items: list) -> str:
        return "".join(getattr(b, "text", "") or "" for b in items if getattr(b, "type", None) == "text")

    return join(blocks), join(blocks[last_marker + 1:])


def _log_fallbacks(msg: Any) -> None:
    for block in getattr(msg, "content", None) or []:
        if getattr(block, "type", None) == "fallback":
            src = getattr(getattr(block, "from_", None), "model", "?")
            dst = getattr(getattr(block, "to", None), "model", "?")
            category = getattr(getattr(block, "trigger", None), "category", None)
            log.info("Claude server-side fallback %s -> %s (refusal category %s)", src, dst, category)


class LLMClient:
    """Structured-output client. ``settings`` / ``client`` can be injected (tests); by default
    the application settings are used and the Anthropic client is created lazily."""

    def __init__(self, settings: Any | None = None, client: Any | None = None) -> None:
        self._settings = settings
        self._client = client
        self._lock = threading.Lock()
        self._fallbacks_rejected = False  # set once the API refused the fallback beta (400)

    @property
    def settings(self) -> Any:
        return self._settings if self._settings is not None else get_settings()

    def _anthropic(self) -> Any:
        with self._lock:
            if self._client is None:
                self._client = _build_client(self.settings)
            return self._client

    def _send(self, client: Any, request: dict, *, use_fallbacks: bool) -> Any:
        if use_fallbacks:
            try:
                with client.beta.messages.stream(**request, betas=[FALLBACK_BETA], fallbacks="default") as stream:
                    return stream.get_final_message()
            except anthropic.BadRequestError as exc:
                if not _mentions_fallback(exc):
                    raise
                log.warning("Claude API rejected server-side fallbacks (HTTP 400%s); retrying without them",
                            f", request id {exc.request_id}" if getattr(exc, "request_id", None) else "")
                self._fallbacks_rejected = True
        with client.messages.stream(**request) as stream:
            return stream.get_final_message()

    def structured(self, *, system: str, user: str, schema: dict, effort: str = "high",
                   max_tokens: int = DEFAULT_MAX_TOKENS) -> LLMResult:
        if effort not in EFFORTS:
            raise ValueError(f"invalid effort {effort!r}; expected one of {', '.join(EFFORTS)}")
        if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens <= 0:
            raise ValueError("max_tokens must be a positive integer")
        settings = self.settings
        if not settings.ai_configured:
            raise AIUnavailableError(MISSING_CREDENTIALS_MESSAGE)
        request = {
            "model": settings.sgpt_model,
            "max_tokens": max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "output_config": {"effort": effort,
                              "format": {"type": "json_schema", "schema": strict_schema(schema)}},
        }
        use_fallbacks = bool(settings.sgpt_ai_fallbacks) and not self._fallbacks_rejected
        started = time.monotonic()
        try:
            client = self._anthropic()
            msg = self._send(client, request, use_fallbacks=use_fallbacks)
        except (AIUnavailableError, AIResponseError):
            raise
        except Exception as exc:  # SDK errors, and transport/decoding errors surfacing mid-stream
            mapped = _map_api_error(exc, settings)
            log.warning("Claude API call failed: %s -> %s", type(exc).__name__, mapped)
            raise mapped from None
        duration_ms = int((time.monotonic() - started) * 1000)

        usage = getattr(msg, "usage", None)
        meta = {
            "model": str(getattr(msg, "model", None) or settings.sgpt_model),
            "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
            "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
            "duration_ms": duration_ms,
            "stop_reason": str(getattr(msg, "stop_reason", None) or ""),
        }
        log.info("Claude call model=%s effort=%s stop=%s in=%d out=%d ms=%d", meta["model"], effort,
                 meta["stop_reason"], meta["input_tokens"], meta["output_tokens"], duration_ms)
        _log_fallbacks(msg)
        return LLMResult(data=_parse_message(msg, meta, max_tokens=max_tokens,
                                             key=getattr(settings, "anthropic_api_key", None)), **meta)


def _parse_message(msg: Any, meta: dict, *, max_tokens: int | None = None, key: str | None = None) -> dict:
    stop = meta["stop_reason"]
    if stop == "refusal":
        details = getattr(msg, "stop_details", None)
        category = getattr(details, "category", None) if details is not None else None
        explanation = _safe_text(getattr(details, "explanation", None) if details is not None else None, key, 200)
        cat_txt = f", category: {category}" if category else ""
        why = f" {explanation.rstrip('.')}." if explanation else ""
        raise AIResponseError(f"Claude declined this request (refusal{cat_txt}).{why} Remove content unrelated "
                              "to the hardware task or rephrase it, then retry.", meta=meta)
    if stop in ("max_tokens", "model_context_window_exceeded"):
        limit = f" of {max_tokens} tokens" if stop == "max_tokens" and max_tokens else ""
        raise AIResponseError(f"Claude response truncated (stop_reason={stop}): the answer exceeded the output "
                              f"limit{limit} before the JSON was complete; narrow the request (fewer or smaller "
                              "files) and retry.", meta=meta)
    full, tail = _response_texts(msg)
    candidates = [t for t in dict.fromkeys((full, tail)) if t.strip()]
    if not candidates:
        raise AIResponseError(f"Claude returned no text content (stop_reason={stop or 'unknown'}).", meta=meta)
    first_error: json.JSONDecodeError | None = None
    for text in candidates:
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            first_error = first_error or exc
            continue
        if not isinstance(data, dict):
            raise AIResponseError("Claude returned JSON that is not an object.", meta=meta)
        return data
    where = f" ({first_error.msg} at character {first_error.pos})" if first_error else ""
    raise AIResponseError(f"Claude returned invalid JSON{where}.", meta=meta)


_default_llm: LLMClient | None = None
_override: Any | None = None
_factory_lock = threading.Lock()


def get_llm() -> Any:
    """Return the process-wide client (or the test override installed by set_llm_for_tests)."""
    global _default_llm
    if _override is not None:
        return _override
    with _factory_lock:
        if _default_llm is None:
            _default_llm = LLMClient()
        return _default_llm


def set_llm_for_tests(client: Any) -> None:
    """Install a fake client (anything with a compatible ``structured`` method); None resets."""
    global _override
    _override = client


# ---------------------------------------------------------------------------------------------
# Helpers shared by the agent modules
# ---------------------------------------------------------------------------------------------
HDL_EXTENSIONS = (".v", ".sv", ".vh", ".svh")
# Names the simulation engine generates inside every run directory (app/simulation/engine.py,
# policy.RESERVED_NAMES): model-written files and modules must never shadow them.
ENGINE_RESERVED_FILES = frozenset({"sgpt_wave_dump.v", "sgpt_sim_top.v", "sgpt_preprocessed.v"})
ENGINE_RESERVED_MODULES = frozenset({"sgpt_wave_dump", "sgpt_sim_top"})
_WIN_DEVICES = frozenset({"con", "prn", "aux", "nul", "conin$", "conout$", "clock$"}
                         | {f"com{i}" for i in range(10)} | {f"lpt{i}" for i in range(10)})
_FILENAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$")
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
_MODULE_RE = re.compile(r"\b(?:module|macromodule)\s+(?:automatic\s+|static\s+)?([A-Za-z_][A-Za-z0-9_$]*)")
_NUMBERED_LINE_RE = re.compile(r"^\s*\d+ \|(?: |$)")
_STRING_RE = re.compile(r'"((?:[^"\\\n]|\\.)*)"')


def call_agent(agent: str, *, system: str, user: str, schema: dict, effort: str,
               max_tokens: int = DEFAULT_MAX_TOKENS) -> tuple[dict, dict]:
    """Run one structured call through get_llm(), check the answer against ``schema`` and
    return (data, meta). Errors carry the agent name in ``meta``."""
    try:
        result = get_llm().structured(system=system, user=user, schema=schema, effort=effort,
                                      max_tokens=max_tokens)
    except AIResponseError as exc:
        exc.meta.setdefault("agent", agent)
        raise
    meta = {"agent": agent, "model": result.model, "input_tokens": result.input_tokens,
            "output_tokens": result.output_tokens, "duration_ms": result.duration_ms,
            "stop_reason": result.stop_reason}
    if not isinstance(result.data, dict):
        raise AIResponseError(f"{agent}: response is not a JSON object", meta=meta)
    problems = schema_errors(result.data, strict_schema(schema))
    if problems:
        raise AIResponseError(f"{agent}: response does not match the expected schema ({'; '.join(problems)})",
                              meta=meta)
    return result.data, meta


def require_keys(data: dict, keys: Iterable[str], agent: str, meta: dict | None = None) -> None:
    missing = [k for k in keys if k not in data]
    if missing:
        raise AIResponseError(f"{agent}: response is missing field(s) {', '.join(missing)}", meta=meta)


def infer_kind(path: str) -> str:
    """File kind from its name (CONTRACTS.md section 4): tb | include | data | rtl."""
    name = path.replace("\\", "/").rsplit("/", 1)[-1].lower()
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    if stem.startswith("tb_") or stem.endswith("_tb"):
        return "tb"
    if ext in ("vh", "svh"):
        return "include"
    if ext in ("hex", "mem"):
        return "data"
    return "rtl"


def normalize_files(files: Any, *, what: str = "files") -> list[dict]:
    """Accept SourceItem objects, {"path","content"[,"kind"]} dicts or (path, content) tuples.
    A missing kind is inferred from the file name."""
    out: list[dict] = []
    seen: set[str] = set()
    for item in files or []:
        if isinstance(item, dict):
            path, content, kind = item.get("path"), item.get("content"), item.get("kind")
        elif isinstance(item, (tuple, list)) and len(item) >= 2:
            path, content, kind = item[0], item[1], (item[2] if len(item) > 2 else None)
        else:
            path, content, kind = getattr(item, "path", None), getattr(item, "content", None), getattr(item, "kind", None)
        if not isinstance(path, str) or not path or not isinstance(content, str):
            raise AIInputError(f"{what}: every file needs a string path and string content")
        if path in seen:
            raise AIInputError(f"{what}: duplicate file path '{path}'")
        seen.add(path)
        out.append({"path": path, "content": content, "kind": str(kind) if kind else infer_kind(path)})
    return out


def hdl_filename_error(path: Any, extensions: tuple[str, ...] = HDL_EXTENSIONS) -> str | None:
    """Error text when ``path`` is not a safe HDL basename, else None."""
    if not isinstance(path, str) or not _FILENAME_RE.match(path) or ".." in path:
        return f"'{path}' is not a safe file basename (letters, digits, _ . - only, no directories)"
    if not path.lower().endswith(extensions):
        return f"'{path}' must use one of the extensions {', '.join(extensions)}"
    if path.split(".", 1)[0].lower() in _WIN_DEVICES:
        return f"'{path}' is a reserved device name"
    if path.lower() in ENGINE_RESERVED_FILES:
        return f"'{path}' is reserved for files generated by the simulation engine"
    return None


def is_identifier(name: Any) -> bool:
    return isinstance(name, str) and bool(_IDENT_RE.match(name))


def strip_comments(text: str, *, strings: bool = False) -> str:
    """Remove // and /* */ comments (string-literal aware); newlines are kept so line numbers
    hold. ``strings=True`` also blanks the contents of string literals (quotes and newlines are
    kept, every other character becomes a space, so offsets match the ``strings=False`` text)."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"' and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            literal = text[i:j + 1]
            if strings:
                closed = j < n and text[j] == '"'
                inner = literal[1:-1] if closed else literal[1:]
                literal = '"' + re.sub(r"[^\n]", " ", inner) + ('"' if closed else "")
            out.append(literal)
            i = j + 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            chunk = text[i:] if j < 0 else text[i:j + 2]
            out.append("\n" * chunk.count("\n"))
            i = n if j < 0 else j + 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def string_literals(text: str) -> list[str]:
    """Contents of the string literals in ``text`` (comments ignored), in source order."""
    return _STRING_RE.findall(strip_comments(text))


def declared_modules(text: str) -> list[str]:
    """Names of the modules declared in ``text`` (comments and string literals ignored)."""
    return _MODULE_RE.findall(strip_comments(text, strings=True))


_VERILOG_KEYWORDS = frozenset(
    "always and assign begin buf case casex casez default defparam disable else end endcase "
    "endfunction endmodule endtask for forever function if initial inout input integer module "
    "nand negedge nor not or output parameter posedge reg repeat signed task time tri wait while "
    "wire xnor xor logic bit byte int always_ff always_comb always_latch enum typedef struct "
    "interface package class program generate endgenerate genvar localparam".split())

_LANGUAGES = {
    "verilog": "verilog", "v": "verilog", "verilog-2005": "verilog", "verilog2005": "verilog",
    "verilog-2001": "verilog", "systemverilog": "systemverilog", "system verilog": "systemverilog",
    "system-verilog": "systemverilog", "sv": "systemverilog",
}


def normalize_language(language: Any) -> str:
    """'verilog' or 'systemverilog' (None/empty -> verilog); anything else is a caller error."""
    key = str(language or "verilog").strip().lower()
    if key not in _LANGUAGES:
        raise AIInputError(f"unsupported HDL language '{language}': use verilog or systemverilog")
    return _LANGUAGES[key]


def is_legal_module_name(name: Any) -> bool:
    return is_identifier(name) and name not in _VERILOG_KEYWORDS and name not in ENGINE_RESERVED_MODULES


def strip_line_number_prefixes(content: str) -> str:
    """Undo the ``'  12 | '`` numbering used in prompts if a model copied it into a file.
    Only applied when every non-empty line carries the prefix."""
    lines = content.split("\n")
    body = [ln for ln in lines if ln.strip()]
    if not body or not all(_NUMBERED_LINE_RE.match(ln) for ln in body):
        return content
    return "\n".join(_NUMBERED_LINE_RE.sub("", ln, count=1) if ln.strip() else ln for ln in lines)
