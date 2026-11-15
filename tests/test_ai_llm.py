"""Tests for app.agents.llm: strict schemas, request shape, response handling, error mapping.

The Anthropic client is replaced by an in-memory fake; no network call is ever made.
"""
import json
import logging
from types import SimpleNamespace

import anthropic
import httpx2
import pytest

from app.agents import llm
from app.core.config import Settings

KEY = "sk-ant-test-SECRET-0123456789"
REQ = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}}


# --------------------------------------------------------------------------------- fakes
class FakeStream:
    def __init__(self, outcome):
        self.outcome = outcome

    def __enter__(self):
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self.outcome


class FakeEndpoint:
    def __init__(self, owner, kind):
        self.owner, self.kind = owner, kind

    def stream(self, **kwargs):
        self.owner.calls.append((self.kind, kwargs))
        return FakeStream(self.owner.outcomes.pop(0))


class FakeAnthropic:
    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = []
        self.messages = FakeEndpoint(self, "messages")
        self.beta = SimpleNamespace(messages=FakeEndpoint(self, "beta"))


def block(kind, **kw):
    return SimpleNamespace(type=kind, **kw)


def message(content=None, *, stop="end_turn", model="claude-opus-5-5", category=None, data=None):
    if content is None:
        content = [block("text", text=json.dumps({"ok": True} if data is None else data))]
    details = SimpleNamespace(type="refusal", category=category) if stop == "refusal" else None
    return SimpleNamespace(content=content, stop_reason=stop, stop_details=details, model=model,
                           usage=SimpleNamespace(input_tokens=123, output_tokens=45))


def settings(**over):
    base = dict(anthropic_api_key=KEY, sgpt_model="claude-opus-5-5", sgpt_ai_fallbacks=True,
                sgpt_ai_timeout_s=30.0, ai_configured=True)
    base.update(over)
    return SimpleNamespace(**base)


def status_error(cls, code, message="boom", body_extra=None):
    body = {"type": "error", "error": {"type": "x", "message": message}}
    if body_extra:
        body["error"].update(body_extra)
    return cls(f"Error code: {code} - {body}", response=httpx2.Response(code, request=REQ), body=body)


def call(client, s=None, **kw):
    c = llm.LLMClient(settings=s or settings(), client=client)
    return c.structured(system=kw.pop("system", "SYS"), user=kw.pop("user", "USER"),
                        schema=kw.pop("schema", SCHEMA), **kw)


# --------------------------------------------------------------------------------- strict schema
def _walk_objects(node, found):
    if isinstance(node, dict):
        if node.get("type") == "object":
            found.append(node)
        for key, value in node.items():
            if key in ("enum", "const", "default"):
                continue
            _walk_objects(value, found)
    elif isinstance(node, list):
        for item in node:
            _walk_objects(item, found)
    return found


def test_strict_schema_walks_every_object():
    schema = {
        "type": "object",
        "properties": {
            "files": {"type": "array", "minItems": 1, "items": {"type": "object", "properties": {
                "path": {"type": "string", "maxLength": 100}, "content": {"type": "string"}}}},
            "choice": {"anyOf": [{"type": "object", "properties": {"a": {"type": "integer", "minimum": 0}}},
                                 {"type": "null"}]},
            "ref": {"$ref": "#/$defs/thing"},
            "mode": {"type": "string", "enum": [{"literal": "dict stays"}, "x"]},
        },
        "$defs": {"thing": {"type": "object", "properties": {"inner": {"type": "object", "properties": {
            "z": {"type": "string"}}}}}},
    }
    original = json.loads(json.dumps(schema))
    out = llm.strict_schema(schema)
    assert schema == original  # input not mutated
    objects = _walk_objects(out, [])
    assert len(objects) == 5
    for obj in objects:
        assert obj["additionalProperties"] is False
        assert obj["required"] == list(obj["properties"].keys())
    text = json.dumps(out)
    for kw in ("minItems", "maxLength", "minimum"):
        assert kw not in text
    assert out["properties"]["mode"]["enum"][0] == {"literal": "dict stays"}
    assert llm.strict_schema(out) == out  # idempotent


# --------------------------------------------------------------------------------- credentials / client
def test_missing_credentials_fail_before_any_network_call(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(llm.anthropic, "Anthropic", lambda **kw: pytest.fail("client must not be built"))
    s = Settings(_env_file=None, anthropic_api_key=None)
    assert s.ai_configured is False
    with pytest.raises(llm.AIUnavailableError) as exc:
        llm.LLMClient(settings=s).structured(system="s", user="u", schema=SCHEMA)
    assert str(exc.value) == ("Claude API credentials not configured. Set ANTHROPIC_API_KEY in backend/.env "
                              "and restart the backend.")
    fake = FakeAnthropic(message())
    with pytest.raises(llm.AIUnavailableError):
        llm.LLMClient(settings=s, client=fake).structured(system="s", user="u", schema=SCHEMA)
    assert fake.calls == []


def test_client_built_from_settings_key_or_env(monkeypatch):
    built = []
    monkeypatch.setattr(llm.anthropic, "Anthropic", lambda **kw: built.append(kw) or FakeAnthropic())
    llm.LLMClient(settings=settings())._anthropic()
    assert built[-1] == {"api_key": KEY, "timeout": 30.0}
    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-env")
    llm.LLMClient(settings=settings(anthropic_api_key=None))._anthropic()
    assert built[-1] == {"timeout": 30.0}  # SDK reads the env credential itself
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    with pytest.raises(llm.AIUnavailableError):
        llm.LLMClient(settings=settings(anthropic_api_key=None))._anthropic()


def test_get_llm_and_override():
    fake = object()
    try:
        llm.set_llm_for_tests(fake)
        assert llm.get_llm() is fake
    finally:
        llm.set_llm_for_tests(None)
    assert isinstance(llm.get_llm(), llm.LLMClient)
    assert llm.get_llm() is llm.get_llm()


# --------------------------------------------------------------------------------- request shape
FORBIDDEN = ("thinking", "temperature", "top_p", "top_k", "budget_tokens", "output_format")


def test_request_shape_with_server_side_fallbacks():
    fake = FakeAnthropic(message())
    res = call(fake, system="SYSTEM PROMPT", user="USER MSG", effort="medium", max_tokens=1234)
    assert res == llm.LLMResult(data={"ok": True}, model="claude-opus-5-5", input_tokens=123,
                                output_tokens=45, duration_ms=res.duration_ms, stop_reason="end_turn")
    assert isinstance(res.duration_ms, int) and res.duration_ms >= 0
    (kind, kw), = fake.calls
    assert kind == "beta"
    assert kw["model"] == "claude-opus-5-5" and kw["max_tokens"] == 1234 and kw["system"] == "SYSTEM PROMPT"
    assert kw["messages"] == [{"role": "user", "content": "USER MSG"}]  # no assistant prefill
    assert kw["betas"] == ["server-side-fallback-2026-07-01"] and kw["fallbacks"] == "default"
    assert kw["output_config"] == {"effort": "medium", "format": {"type": "json_schema",
                                                                "schema": llm.strict_schema(SCHEMA)}}
    assert not [k for k in FORBIDDEN if k in kw]


def test_request_shape_without_fallbacks():
    fake = FakeAnthropic(message())
    call(fake, s=settings(sgpt_ai_fallbacks=False), effort="high")
    (kind, kw), = fake.calls
    assert kind == "messages"
    assert "betas" not in kw and "fallbacks" not in kw
    assert kw["output_config"]["effort"] == "high"
    assert not [k for k in FORBIDDEN if k in kw]


def test_invalid_effort_and_max_tokens_rejected():
    with pytest.raises(ValueError):
        call(FakeAnthropic(message()), effort="extreme")
    with pytest.raises(ValueError):
        call(FakeAnthropic(message()), max_tokens=0)


# --------------------------------------------------------------------------------- response handling
def _fallback_marker():
    return block("fallback", **{"from_": SimpleNamespace(model="claude-opus-5-5"),
                                "to": SimpleNamespace(model="claude-opus-4-8"),
                                "trigger": SimpleNamespace(type="refusal", category="cyber")})


def test_mid_stream_fallback_continuation_is_joined():
    # Streaming mid-output fallback: the fallback model CONTINUES the declined partial text.
    content = [block("thinking", thinking="", signature="sig"), block("text", text='{"ok": tr'),
               _fallback_marker(), block("thinking", thinking=""), block("text", text="ue}")]
    res = call(FakeAnthropic(message(content, model="claude-opus-4-8")))
    assert res.data == {"ok": True} and res.model == "claude-opus-4-8"


def test_fallback_that_restarts_the_answer_is_also_parsed():
    content = [block("thinking", thinking="", signature="sig"),
               block("text", text='{"ok": fal'),  # partial output of the model that declined
               _fallback_marker(), block("thinking", thinking=""),
               block("text", text='{"ok": '), block("text", text="true}")]
    res = call(FakeAnthropic(message(content, model="claude-opus-4-8")))
    assert res.data == {"ok": True} and res.model == "claude-opus-4-8"


def test_thinking_blocks_are_never_parsed():
    content = [block("thinking", thinking='{"ok": false}', signature="s"), block("text", text='{"ok": true}')]
    assert call(FakeAnthropic(message(content))).data == {"ok": True}


def test_refusal_reports_category():
    with pytest.raises(llm.AIResponseError) as exc:
        call(FakeAnthropic(message([], stop="refusal", category="cyber")))
    assert "refusal" in str(exc.value) and "cyber" in str(exc.value)
    assert exc.value.meta["input_tokens"] == 123
    with pytest.raises(llm.AIResponseError, match="refusal"):
        call(FakeAnthropic(message([], stop="refusal", category=None)))


def test_refusal_partial_text_is_discarded_and_explanation_shown():
    msg = message([block("text", text='{"ok": true}')], stop="refusal", category="bio")
    msg.stop_details.explanation = "This request was declined\n because it could enable biological harm."
    with pytest.raises(llm.AIResponseError) as exc:
        call(FakeAnthropic(msg))
    text = str(exc.value)
    assert "category: bio" in text and "could enable biological harm." in text and "\n" not in text


def test_max_tokens_is_reported_as_truncated():
    msg = message([block("text", text='{"ok": tr')], stop="max_tokens")
    with pytest.raises(llm.AIResponseError, match="response truncated") as exc:
        call(FakeAnthropic(msg), max_tokens=777)
    assert "777 tokens" in str(exc.value)
    with pytest.raises(llm.AIResponseError, match="response truncated"):
        call(FakeAnthropic(message([block("text", text='{"ok"')], stop="model_context_window_exceeded")))


@pytest.mark.parametrize("text, match", [("not json", "invalid JSON"), ("[1, 2]", "not an object"),
                                         ("", "no text content")])
def test_bad_json_is_a_response_error(text, match):
    with pytest.raises(llm.AIResponseError, match=match):
        call(FakeAnthropic(message([block("text", text=text)])))


# --------------------------------------------------------------------------------- error mapping
def test_auth_and_permission_errors_are_unavailable_and_never_leak_the_key(caplog):
    caplog.set_level(logging.DEBUG)
    auth = status_error(anthropic.AuthenticationError, 401, f"invalid x-api-key {KEY}")
    with pytest.raises(llm.AIUnavailableError) as exc:
        call(FakeAnthropic(auth))
    assert "401" in str(exc.value) and KEY not in str(exc.value)
    with pytest.raises(llm.AIUnavailableError, match="403"):
        call(FakeAnthropic(status_error(anthropic.PermissionDeniedError, 403)))
    assert exc.value.__cause__ is None and exc.value.__suppress_context__
    assert KEY not in caplog.text


@pytest.mark.parametrize("error, match", [
    (status_error(anthropic.RateLimitError, 429), "rate limit"),
    (status_error(anthropic.InternalServerError, 500, f"overloaded {KEY}"), "HTTP 500"),
    (status_error(anthropic.BadRequestError, 400, "max_tokens: too large"), r"\(HTTP 400\): max_tokens: too large"),
    (anthropic.APIConnectionError(request=REQ), "network"),
    (anthropic.APITimeoutError(request=REQ), "timed out"),
])
def test_api_failures_are_response_errors(error, match, caplog):
    caplog.set_level(logging.DEBUG)
    fake = FakeAnthropic(error)
    with pytest.raises(llm.AIResponseError, match=match) as exc:
        call(fake)
    assert KEY not in str(exc.value) and KEY not in caplog.text
    assert len(fake.calls) == 1  # only a 400 that mentions fallbacks is retried


def test_fallback_400_is_retried_once_without_the_beta():
    rejected = status_error(anthropic.BadRequestError, 400, "fallbacks: not available for this organization")
    fake = FakeAnthropic(rejected, message(), message())
    client = llm.LLMClient(settings=settings(), client=fake)
    assert client.structured(system="s", user="u", schema=SCHEMA).data == {"ok": True}
    assert [k for k, _ in fake.calls] == ["beta", "messages"]
    retry = fake.calls[1][1]
    assert "betas" not in retry and "fallbacks" not in retry
    assert retry["output_config"] == fake.calls[0][1]["output_config"]
    client.structured(system="s", user="u", schema=SCHEMA)  # rejection is remembered
    assert [k for k, _ in fake.calls] == ["beta", "messages", "messages"]


def test_fallback_retry_failure_is_mapped():
    rejected = status_error(anthropic.BadRequestError, 400, "unknown parameter: fallbacks")
    fake = FakeAnthropic(rejected, status_error(anthropic.RateLimitError, 429))
    with pytest.raises(llm.AIResponseError, match="rate limit"):
        call(fake)
    assert len(fake.calls) == 2


def test_success_logs_usage_without_key(caplog):
    caplog.set_level(logging.DEBUG, logger="app.agents.llm")
    call(FakeAnthropic(message()))
    assert "in=123 out=45" in caplog.text and KEY not in caplog.text


def test_sdk_errors_while_building_the_client_are_mapped(monkeypatch):
    def boom(**kw):
        raise anthropic.CredentialsError("no usable credential profile")
    monkeypatch.setattr(llm.anthropic, "Anthropic", boom)
    with pytest.raises(llm.AIUnavailableError, match="credentials not configured"):
        llm.LLMClient(settings=settings()).structured(system="s", user="u", schema=SCHEMA)


# --------------------------------------------------------------------------------- answer validation
def test_schema_errors():
    schema = llm.strict_schema({"type": "object", "properties": {
        "name": {"type": "string"}, "n": {"type": "integer"}, "mode": {"type": "string", "enum": ["a", "b"]},
        "items": {"type": "array", "items": {"type": "object", "properties": {"x": {"type": "boolean"}}}},
        "opt": {"anyOf": [{"type": "string"}, {"type": "null"}]}}})
    good = {"name": "x", "n": 3, "mode": "a", "items": [{"x": True}], "opt": None}
    assert llm.schema_errors(good, schema) == []
    assert llm.schema_errors(dict(good, n=True), schema) == ["$.n: expected integer, got boolean"]
    assert llm.schema_errors(dict(good, n="3"), schema) == ["$.n: expected integer, got string"]
    assert "not one of" in llm.schema_errors(dict(good, mode="c"), schema)[0]
    assert llm.schema_errors(dict(good, items=[{"x": 1}]), schema) == ["$.items[0].x: expected boolean, got integer"]
    assert llm.schema_errors({k: v for k, v in good.items() if k != "name"}, schema) == ["$: missing field 'name'"]
    assert llm.schema_errors(dict(good, extra=1), schema) == ["$: unexpected field(s) extra"]
    assert "alternatives" in llm.schema_errors(dict(good, opt=5), schema)[0]
    assert llm.schema_errors([], schema) == ["$: expected object, got array"]


# --------------------------------------------------------------------------------- helpers
def test_helpers():
    assert llm.hdl_filename_error("alu8.v") is None and llm.hdl_filename_error("x.svh") is None
    for bad in ("../a.v", "dir/a.v", "a.txt", "", ".v.", "a b.v", "C:\\x.v", "con.v", "NUL.sv", "com1.v",
                "sgpt_wave_dump.v", "SGPT_SIM_TOP.v"):
        assert llm.hdl_filename_error(bad), bad
    assert llm.declared_modules("// module fake;\nmodule a(); endmodule\n/* module b */ module c #(1) ();") \
        == ["a", "c"]
    assert llm.declared_modules('module t; initial $display("module ghost"); endmodule') == ["t"]
    assert llm.strip_comments('x = "// not a comment"; // gone\n/* a\nb */y') == 'x = "// not a comment"; \n\ny'
    src = 'a = "x // y"; /* c */ b = "q\\"r";\nc = "open\nd'
    plain, blank = llm.strip_comments(src), llm.strip_comments(src, strings=True)
    assert len(plain) == len(blank) and plain.count("\n") == blank.count("\n") == src.count("\n")
    assert blank == 'a = "      ";  b = "    ";\nc = "    \nd'
    assert llm.string_literals('$display("[SGPT] DONE"); // "not this"\n$display("a\\"b");') == \
        ["[SGPT] DONE", 'a\\"b']
    assert [llm.infer_kind(p) for p in ("tb_alu.sv", "alu_tb.v", "defs.vh", "prog.hex", "alu.v", "x.MEM")] == \
        ["tb", "tb", "include", "data", "rtl", "data"]
    assert llm.is_legal_module_name("alu8") and not llm.is_legal_module_name("sgpt_sim_top")
    numbered = "   1 | module m;\n   2 |\n   3 |   wire a;\n"
    assert llm.strip_line_number_prefixes(numbered) == "module m;\n\n  wire a;\n"
    assert llm.strip_line_number_prefixes("a | b\n") == "a | b\n"
    files = llm.normalize_files([{"path": "a.v", "content": "x"}, ("b.v", "y"),
                                 SimpleNamespace(path="c.v", content="z", kind="tb"), ("tb_d.sv", "w")])
    assert [f["path"] for f in files] == ["a.v", "b.v", "c.v", "tb_d.sv"]
    assert [f["kind"] for f in files] == ["rtl", "rtl", "tb", "tb"]
    with pytest.raises(llm.AIInputError):
        llm.normalize_files([("a.v", "x"), ("a.v", "y")])
    assert llm.normalize_language("SV") == "systemverilog" and llm.normalize_language(None) == "verilog"
    with pytest.raises(llm.AIInputError):
        llm.normalize_language("vhdl")
    assert llm.is_legal_module_name("alu8") and not llm.is_legal_module_name("module")


# --------------------------------------------------------------------------------- unittest.mock client
@pytest.mark.parametrize("final, error, match", [
    (message([], stop="refusal", category="bio"), llm.AIResponseError, "category: bio"),
    (message([block("text", text='{"ok"')], stop="max_tokens"), llm.AIResponseError, "response truncated"),
    (message([block("text", text="{oops")]), llm.AIResponseError, "invalid JSON"),
])
def test_mocked_stream_stop_reasons(final, error, match):
    from unittest import mock
    client = mock.MagicMock()
    client.beta.messages.stream.return_value.__enter__.return_value.get_final_message.return_value = final
    with pytest.raises(error, match=match):
        call(client)
    client.beta.messages.stream.assert_called_once()
    assert client.beta.messages.stream.call_args.kwargs["fallbacks"] == "default"
    client.messages.stream.assert_not_called()


def test_mocked_client_is_never_called_without_credentials(monkeypatch):
    from unittest import mock
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    client = mock.MagicMock()
    with pytest.raises(llm.AIUnavailableError, match="credentials not configured"):
        call(client, s=settings(anthropic_api_key=None, ai_configured=False))
    client.beta.messages.stream.assert_not_called()
    client.messages.stream.assert_not_called()


def test_mocked_stream_auth_error_and_fallback_retry():
    from unittest import mock
    client = mock.MagicMock()
    client.beta.messages.stream.side_effect = status_error(anthropic.AuthenticationError, 401)
    with pytest.raises(llm.AIUnavailableError):
        call(client)
    client = mock.MagicMock()
    client.beta.messages.stream.side_effect = status_error(anthropic.BadRequestError, 400, "fallbacks rejected")
    client.messages.stream.return_value.__enter__.return_value.get_final_message.return_value = message()
    assert call(client).data == {"ok": True}
    retry_kwargs = client.messages.stream.call_args.kwargs
    assert "betas" not in retry_kwargs and "fallbacks" not in retry_kwargs


# --------------------------------------------------------------------------------- real SDK, mocked HTTP
def _sse(text):
    events = [
        {"type": "message_start", "message": {"id": "msg_1", "type": "message", "role": "assistant",
                                              "model": "claude-opus-5-5", "content": [], "stop_reason": None,
                                              "stop_sequence": None, "usage": {"input_tokens": 12, "output_tokens": 1}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
         "usage": {"output_tokens": 9}},
        {"type": "message_stop"},
    ]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def _sdk_client(responses):
    seen = []

    def handler(request):
        seen.append((request.headers.get("anthropic-beta"), json.loads(request.content)))
        status, payload = responses.pop(0)
        if status == 200:
            return httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=_sse(payload))
        return httpx2.Response(status, json={"type": "error", "error": {"type": "x", "message": payload}})

    client = anthropic.Anthropic(api_key=KEY, base_url="http://mock.local", max_retries=0,
                                 http_client=httpx2.Client(transport=httpx2.MockTransport(handler)))
    return client, seen


def test_real_sdk_request_body_and_stream_parsing():
    client, seen = _sdk_client([(200, '{"ok": true}')])
    res = call(client, effort="xhigh", max_tokens=2048)
    assert (res.data, res.input_tokens, res.output_tokens, res.stop_reason) == ({"ok": True}, 12, 9, "end_turn")
    (beta, body), = seen
    assert beta == "server-side-fallback-2026-07-01"
    assert sorted(body) == ["fallbacks", "max_tokens", "messages", "model", "output_config", "stream", "system"]
    assert body["fallbacks"] == "default" and body["stream"] is True and body["max_tokens"] == 2048
    assert body["output_config"]["effort"] == "xhigh"
    assert body["output_config"]["format"]["schema"]["additionalProperties"] is False


def test_real_sdk_mid_stream_fallback_continuation():
    # Wire shape from the refusals-and-fallback docs: the open text block closes, a `fallback`
    # block (start/stop, no deltas) marks the boundary, the fallback model continues the text.
    events = [
        {"type": "message_start", "message": {"id": "msg_2", "type": "message", "role": "assistant",
                                              "model": "claude-opus-5-5", "content": [], "stop_reason": None,
                                              "stop_sequence": None, "usage": {"input_tokens": 30, "output_tokens": 1}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": '{"ok": tr'}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {
            "type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"},
            "trigger": {"type": "refusal", "category": "cyber"}}},
        {"type": "content_block_stop", "index": 1},
        {"type": "content_block_start", "index": 2, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "text_delta", "text": "ue}"}},
        {"type": "content_block_stop", "index": 2},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None},
         "usage": {"output_tokens": 7}},
        {"type": "message_stop"},
    ]
    body = "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()
    transport = httpx2.MockTransport(
        lambda request: httpx2.Response(200, headers={"content-type": "text/event-stream"}, content=body))
    client = anthropic.Anthropic(api_key=KEY, base_url="http://mock.local", max_retries=0,
                                 http_client=httpx2.Client(transport=transport))
    res = call(client)
    assert res.data == {"ok": True} and res.model == "claude-opus-4-8" and res.stop_reason == "end_turn"


def test_real_sdk_connection_drop_mid_stream_is_a_response_error():
    # The SDK re-raises transport errors that happen while the SSE body is read without wrapping
    # them (here httpx2.ReadError); they must still become a clean AIResponseError (HTTP 502).
    start = {"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant",
                                                   "model": "claude-opus-5-5", "content": [], "stop_reason": None,
                                                   "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}}

    class Broken(httpx2.SyncByteStream):
        def __iter__(self):
            yield f"event: message_start\ndata: {json.dumps(start)}\n\n".encode()
            raise httpx2.ReadError("connection reset by peer")

    transport = httpx2.MockTransport(
        lambda request: httpx2.Response(200, headers={"content-type": "text/event-stream"}, stream=Broken()))
    client = anthropic.Anthropic(api_key=KEY, base_url="http://mock.local", max_retries=0,
                                 http_client=httpx2.Client(transport=transport))
    with pytest.raises(llm.AIResponseError, match="interrupted while the answer was streaming") as exc:
        call(client)
    assert exc.value.__cause__ is None and exc.value.__suppress_context__


def test_real_sdk_fallback_rejection_and_auth_error():
    client, seen = _sdk_client([(400, "fallbacks: not enabled for this organization"), (200, '{"ok": true}')])
    assert call(client).data == {"ok": True}
    assert [b for b, _ in seen] == ["server-side-fallback-2026-07-01", None]
    assert "fallbacks" not in seen[1][1]
    client, _ = _sdk_client([(401, f"invalid x-api-key {KEY}")])
    with pytest.raises(llm.AIUnavailableError) as exc:
        call(client)
    assert KEY not in str(exc.value)
