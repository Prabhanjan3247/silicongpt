"""Assistant agent: answer engineering questions using the project context it is given."""
from __future__ import annotations

from typing import Any

from . import llm as _llm
from . import prompts as P

AGENT = "assistant"
EFFORT = "medium"
MAX_QUESTION_CHARS = 20_000
MAX_CONTEXT_CODE_CHARS = 200_000

SCHEMA = _llm.strict_schema({
    "type": "object",
    "properties": {
        "answer_markdown": {"type": "string"},
        "references": {"type": "array", "items": {"type": "object", "properties": {
            "file": {"type": "string", "description": "a file name from the provided context"},
            "line": {"type": "integer", "description": "1-based line number, 0 for the whole file"}}}},
    },
})

_KNOWN = ("project", "file", "files", "run", "synth", "synthesis", "hierarchy")


def _context_files(context: dict) -> tuple[list[dict], list[str]]:
    """(files with content, names of listed files that carry no content)."""
    raw: list[Any] = ([context["file"]] if context.get("file") else []) + list(context.get("files") or [])
    with_content, names_only, seen = [], [], set()
    for item in raw:
        content = item.get("content") if isinstance(item, dict) else getattr(item, "content", None)
        if content is None:
            path = item.get("path") if isinstance(item, dict) else getattr(item, "path", None)
            if isinstance(path, str) and path and path not in seen:
                seen.add(path)
                names_only.append(path)
            continue
        f = _llm.normalize_files([item], what="context files")[0]
        if f["path"] not in seen:
            seen.add(f["path"])
            with_content.append(f)
    return with_content, names_only


def ask(question: str, context: dict | None = None) -> _llm.AgentOutput:
    if not isinstance(question, str) or not question.strip():
        raise _llm.AIInputError("the question is empty")
    if len(question) > MAX_QUESTION_CHARS:
        raise _llm.AIInputError(f"the question is too long ({len(question)} characters, limit {MAX_QUESTION_CHARS})")
    context = dict(context or {})
    parts: list[str] = []
    if context.get("project"):
        parts.append(f"Project:\n{P.to_json(context['project'], 8000, 'project')}")
    if context.get("hierarchy"):
        parts.append(f"Module hierarchy (parser):\n{P.to_json(context['hierarchy'], 12_000, 'hierarchy')}")

    files, names_only = _context_files(context)
    included, omitted, budget = [], [], MAX_CONTEXT_CODE_CHARS
    for f in files:
        if len(f["content"]) <= budget:
            included.append(f)
            budget -= len(f["content"])
        else:
            omitted.append(f["path"])
    if included:
        parts.append(f"Project files (numbered):\n{P.render_files(included, numbered=True)}")
    if omitted:
        parts.append(f"Files not included because of the size limit: {', '.join(omitted)}")
    if names_only:
        parts.append(f"Other project files (content not provided): {', '.join(names_only)}")
    run = context.get("run")
    if isinstance(run, dict) and run:
        parts.append(f"Simulation run:\n{P.render_run(run, max_fail=40, max_pass=10, log_chars=6000)}")
    synth = context.get("synth") or context.get("synthesis")
    if synth:
        parts.append(f"Synthesis result (Yosys):\n{P.to_json(synth, 12_000, 'synthesis result')}")
    for key, value in context.items():
        if key not in _KNOWN and value:
            parts.append(f"{key}:\n{P.to_json(value, 8000, key)}")

    ctx_txt = "\n\n".join(parts) if parts else "(no project context was provided)"
    user = f"Context:\n{ctx_txt}\n\nQuestion:\n<<<\n{question.strip()}\n>>>"
    data, meta = _llm.call_agent(AGENT, system=P.ASSISTANT_SYSTEM, user=user, schema=SCHEMA,
                                 effort=EFFORT, max_tokens=64000)

    line_counts = {f["path"]: P.line_count(f["content"]) for f in included}
    refs, seen = [], set()
    for r in data["references"]:
        name, line = r["file"], r["line"]
        if name in line_counts and 0 <= line <= line_counts[name] and (name, line) not in seen:
            seen.add((name, line))
            refs.append({"file": name, "line": line})
    data["references"] = refs
    return _llm.AgentOutput(data=data, meta=meta)
