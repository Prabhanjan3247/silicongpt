"""AI service: runs the AI workflows for the REST API, records every interaction, maps errors.

* Each workflow run is stored as one ``AIInteraction`` row: agent, action, run_id, a request
  summary (clipped user text; API keys are never stored), the response data, the model(s), the
  summed token usage and the model time. The per-call breakdown and the tool time are stored
  in ``response.usage``.
* A workflow that fails after model tokens were spent is stored too (``response.error``), so the
  usage accounting stays complete; its ``AIRecord.status`` is ``"error"``.
* Errors: ``AIUnavailableError`` -> 503, ``AIResponseError`` -> 502, ``AIInputError`` -> 400, with
  the message as ``detail``. Missing credentials are detected before any tool runs, so a request
  that cannot reach Claude leaves no compile / synthesis / simulation records behind.
* The DB transaction is ended before every model call and tool run (``Trace.release``), so a
  request does not hold a pooled connection for the minutes a Claude call can take.
* Applying patches (debug / optimize sessions) writes exactly the stored contents (FileRevision
  reason ``ai_patch``) after checking that every file still holds the content the patch was
  computed against (409 otherwise). The apply is recorded in the session's response
  (``applied``, ``applied_at``) instead of creating a new AI record (no model call happens).
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Callable

from fastapi import HTTPException
from sqlalchemy.orm import Session, load_only
from sqlalchemy.orm.attributes import flag_modified

from ..agents import llm as _llm
from ..agents import workflows as wf
from ..core.config import get_settings
from ..models.entities import AIInteraction, Project, SourceFile, utcnow
from ..schemas.ai import (AskRequest, ExplainRequest, GenerateRtlRequest, GenerateTestbenchRequest,
                          OptimizeRequest, RunRequest)
from ..schemas.common import iso_utc
from . import project_service as ps
from . import simulation_service as ss

log = logging.getLogger(__name__)

REQUEST_TEXT_CHARS = 4000
PATCH_REASON = "ai_patch"
TB_SAVE_REASON = "ai_testbench"
_KEY_RE = re.compile(r"sk-ant-[A-Za-z0-9_\-]+")
_FROM_RESPONSE = object()
#: apply kind -> (agent, action) of the sessions whose patches may be applied
_APPLY_KINDS = {"debug": ("debugger", "debug"), "optimize": ("optimizer", "optimize")}


# ---------------------------------------------------------------------------------------------
# Records
# ---------------------------------------------------------------------------------------------
def record_dict(i: AIInteraction, error: Any = _FROM_RESPONSE) -> dict:
    """AIRecord {id, project_id, agent, action, run_id, model, input_tokens, output_tokens,
    duration_ms, created_at} + {status: "ok" | "error", error}."""
    if error is _FROM_RESPONSE:
        error = (i.response or {}).get("error") if isinstance(i.response, dict) else None
    return {
        "id": i.id, "project_id": i.project_id, "agent": i.agent, "action": i.action, "run_id": i.run_id,
        "model": i.model or "", "input_tokens": int(i.input_tokens or 0), "output_tokens": int(i.output_tokens or 0),
        "duration_ms": int(i.duration_ms or 0), "created_at": iso_utc(i.created_at),
        "status": "error" if error else "ok", "error": str(error) if error else None,
    }


def interaction_detail(i: AIInteraction) -> dict:
    """AIRecord + {request, response} as stored."""
    return {**record_dict(i), "request": i.request if isinstance(i.request, dict) else {},
            "response": i.response if isinstance(i.response, dict) else {}}


def get_interaction_or_404(db: Session, iid: int) -> AIInteraction:
    i = db.get(AIInteraction, iid)
    if i is None:
        raise HTTPException(status_code=404, detail=f"AI interaction {iid} not found")
    return i


def history(db: Session, pid: int, limit: int = 100) -> list[dict]:
    """AIRecord[] of a project, newest first (stored request/response bodies are not loaded)."""
    p = ps.get_project_or_404(db, pid)
    err = AIInteraction.response["error"].as_string()
    cols = (AIInteraction.id, AIInteraction.project_id, AIInteraction.agent, AIInteraction.action,
            AIInteraction.run_id, AIInteraction.model, AIInteraction.input_tokens, AIInteraction.output_tokens,
            AIInteraction.duration_ms, AIInteraction.created_at)
    rows = (db.query(AIInteraction, err).options(load_only(*cols)).filter(AIInteraction.project_id == p.id)
            .order_by(AIInteraction.id.desc()).limit(limit).all())
    return [record_dict(i, error=e) for i, e in rows]


# ---------------------------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------------------------
def _clip(text: str | None, limit: int = REQUEST_TEXT_CHARS) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + f" ... [{len(text) - limit} more characters]"


def scrub(obj: Any) -> Any:
    """Copy of ``obj`` with anything that looks like an Anthropic API key (or a configured
    credential: settings key, ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN env values) masked in
    every string."""
    secrets = [s for s in {get_settings().anthropic_api_key, os.environ.get("ANTHROPIC_API_KEY"),
                           os.environ.get("ANTHROPIC_AUTH_TOKEN")} if s and len(s.strip()) >= 8]
    secrets.sort(key=len, reverse=True)

    def walk(x: Any) -> Any:
        if isinstance(x, str):
            for secret in secrets:
                x = x.replace(secret, "***")
            return _KEY_RE.sub("sk-ant-***", x)
        if isinstance(x, dict):
            return {str(k): walk(v) for k, v in x.items()}
        if isinstance(x, (list, tuple)):
            return [walk(v) for v in x]
        return x

    return walk(obj)


def _json_safe(obj: Any) -> Any:
    return json.loads(json.dumps(obj, default=str))


def _store(db: Session, *, agent: str, action: str, project_id: int | None, run_id: int | None,
           request: dict, response: dict, trace: wf.Trace) -> AIInteraction:
    totals = trace.totals()
    body = {**response, "usage": {"calls": trace.calls, "tools": trace.tools, "timing": totals}}
    # The response is scrubbed too: a model answer can quote a key the user pasted into a question.
    row = AIInteraction(project_id=project_id, agent=agent, action=action, run_id=run_id,
                        request=_json_safe(scrub(request)), response=_json_safe(scrub(body)),
                        model=", ".join(trace.models())[:64], input_tokens=totals["input_tokens"],
                        output_tokens=totals["output_tokens"], duration_ms=totals["ai_ms"])
    db.add(row)
    db.commit()
    return row


def http_error(exc: Exception) -> HTTPException | None:
    """HTTP mapping of the AI errors (None for unexpected exceptions)."""
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, _llm.AIUnavailableError):
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, _llm.AIResponseError):
        return HTTPException(status_code=502, detail=str(exc))
    if isinstance(exc, _llm.AIInputError):
        return HTTPException(status_code=400, detail=str(exc))
    return None


def ensure_ai_available() -> None:
    """AIUnavailableError when the real Claude client has no credentials (a test fake installed
    with ``set_llm_for_tests`` is always available). Checked before any tool runs."""
    client = _llm.get_llm()
    if isinstance(client, _llm.LLMClient) and not client.settings.ai_configured:
        raise _llm.AIUnavailableError(_llm.MISSING_CREDENTIALS_MESSAGE)


def _execute(db: Session, *, agent: str, action: str, project_id: int | None, run_id: int | None,
             request: dict, work: Callable[[wf.Trace], dict],
             compact: Callable[[dict], dict] | None = None) -> dict:
    """Run ``work`` with a fresh Trace, store the interaction and return data + interaction."""
    trace = wf.Trace(release=lambda: ss.release_connection(db))
    try:
        ensure_ai_available()
        data = work(trace)
    except Exception as exc:
        mapped = http_error(exc)
        if trace.calls:  # tokens were spent: keep the record of the failed attempt
            message = str(exc) if mapped is not None else f"internal error ({type(exc).__name__})"
            try:
                db.rollback()
                _store(db, agent=agent, action=action, project_id=project_id, run_id=run_id, request=request,
                       response={"error": message[:2000]}, trace=trace)
            except Exception:  # never hide the original error
                log.exception("could not record the failed AI interaction %s/%s", agent, action)
                db.rollback()
        if mapped is None:
            raise
        raise mapped from None
    row = _store(db, agent=agent, action=action, project_id=project_id, run_id=run_id, request=request,
                 response=compact(data) if compact else data, trace=trace)
    return {**data, "interaction": record_dict(row)}


# ---------------------------------------------------------------------------------------------
# Endpoint services
# ---------------------------------------------------------------------------------------------
def _file_anywhere(db: Session, fid: int) -> SourceFile:
    f = db.get(SourceFile, fid)
    if f is None:
        raise HTTPException(status_code=404, detail=f"File {fid} not found")
    return f


def explain(db: Session, body: ExplainRequest) -> dict:
    p = ps.get_project_or_404(db, body.project_id) if body.project_id is not None else None
    f = None
    if body.file_id is not None:
        f = ps.get_file_or_404(db, p, body.file_id) if p is not None else _file_anywhere(db, body.file_id)
        p = p or f.project
        code, path = f.content or "", f.path
    elif body.code is not None and body.code.strip():
        code, path = body.code, (body.path or "").strip() or None
    else:
        raise HTTPException(status_code=400, detail="Provide file_id (a project file) or code to explain")
    request = {"source": "file" if f is not None else "inline", "file_id": f.id if f is not None else None,
               "path": path, "mode": body.mode, "code_chars": len(code),
               "code": None if f is not None else _clip(code)}
    return _execute(db, agent="developer", action="explain", project_id=p.id if p else None, run_id=None,
                    request=request, work=lambda t: wf.explain_workflow(code, path, body.mode, trace=t))


def generate_rtl(db: Session, body: GenerateRtlRequest) -> dict:
    p = ps.get_project_or_404(db, body.project_id) if body.project_id is not None else None
    request = {"spec": _clip(body.spec), "spec_chars": len(body.spec), "language": body.language,
               "project_id": p.id if p else None}
    return _execute(db, agent="developer", action="generate_rtl", project_id=p.id if p else None, run_id=None,
                    request=request, work=lambda t: wf.generate_rtl_workflow(body.spec, body.language, trace=t))


def save_testbench(db: Session, p: Project, tb: dict, compile_ok: bool) -> tuple[dict | None, str]:
    """Write a generated testbench into the project (kind tb) and set ``project.tb_top``.

    Only a testbench that compiled is saved. The target is the project file with the same name,
    else an existing testbench file that declares the same top module (both would be compiled
    together and clash); otherwise a new file is created. Returns (File | None, note)."""
    if not compile_ok:
        return None, ("Not saved: the generated testbench does not compile (see the compiler log); the project "
                      "was left unchanged.")
    path, content, tb_top = tb["path"], tb["content"], tb["tb_top"]
    files = list(p.files)
    new_modules = set(_llm.declared_modules(content))
    target = next((f for f in files if f.path.lower() == path.lower()), None)
    if target is not None and target.kind != "tb":
        return None, f"Not saved: '{target.path}' already exists as a {target.kind} file."
    if target is None:
        target = next((f for f in files if f.kind == "tb" and tb_top in _llm.declared_modules(f.content or "")),
                      None)
    clash = sorted({m for f in files if f is not target for m in _llm.declared_modules(f.content or "")
                    if m in new_modules})
    if clash:
        return None, (f"Not saved: module(s) {', '.join(clash)} are already declared in other project files; "
                      "rename or remove them first.")
    try:
        if target is None:
            saved = ps.create_file(db, p, path, content, kind="tb")
            note = f"Saved as new testbench file '{saved.path}'."
        else:
            saved = ps.update_file_content(db, target, content, TB_SAVE_REASON)
            note = (f"Saved into the existing testbench file '{saved.path}'"
                    + ("" if saved.path.lower() == path.lower() else f" (it declared module {tb_top})")
                    + "; the previous content is kept as a file revision.")
    except HTTPException as exc:
        db.rollback()
        return None, f"Not saved: {exc.detail}"
    p.tb_top = tb_top
    ps.touch(p)
    db.commit()
    return ps.file_dict(saved), note + f" Project testbench top set to '{tb_top}'."


def generate_testbench(db: Session, body: GenerateTestbenchRequest) -> dict:
    p = ps.get_project_or_404(db, body.project_id)
    items = ss.project_items(p)
    top, _tb = ss.resolve_tops(p, items)
    dut = body.dut_module or top
    sim = body.simulator or p.simulator or "icarus"
    spec = p.spec if body.spec is None else body.spec
    request = {"project_id": p.id, "dut_module": dut, "simulator": sim, "save": body.save,
               "spec": _clip(spec), "spec_source": "project" if body.spec is None else "request"}

    def work(trace: wf.Trace) -> dict:
        data = wf.generate_testbench_workflow(items, spec, dut, sim, trace=trace, project_name=p.name)
        data["saved_file"], data["save_note"] = None, None
        if body.save:
            data["saved_file"], data["save_note"] = save_testbench(db, p, data["testbench"], data["compile"]["ok"])
        return data

    return _execute(db, agent="verification", action="generate_testbench", project_id=p.id, run_id=None,
                    request=request, work=work)


def analyze_run(db: Session, body: RunRequest) -> dict:
    run = ss.get_run_or_404(db, body.run_id)
    return _execute(db, agent="analyst", action="analyze_run", project_id=run.project_id, run_id=run.id,
                    request={"run_id": run.id, "run_status": run.status},
                    work=lambda t: wf.analyze_run_workflow(run, trace=t))


def debug(db: Session, body: RunRequest) -> dict:
    run = ss.get_run_or_404(db, body.run_id)
    return _execute(db, agent="debugger", action="debug", project_id=run.project_id, run_id=run.id,
                    request={"run_id": run.id, "run_status": run.status, "simulator": run.simulator},
                    work=lambda t: wf.debug_workflow(db, run, trace=t))


def _compact_synth(data: dict) -> dict:
    """Stored copy of an optimize result without the (large) Yosys logs, which stay available on
    the persisted synthesis runs."""
    out = dict(data)
    for key in ("baseline", "optimized"):
        s = out.get(key)
        if isinstance(s, dict) and s.get("log"):
            out[key] = {**s, "log": "", "log_omitted": f"full Yosys log stored with synthesis run {s.get('id')}"}
    return out


def optimize(db: Session, body: OptimizeRequest) -> dict:
    p = ps.get_project_or_404(db, body.project_id)
    request = {"project_id": p.id, "goal": body.goal, "notes": _clip(body.notes)}
    return _execute(db, agent="optimizer", action="optimize", project_id=p.id, run_id=None, request=request,
                    work=lambda t: wf.optimize_workflow(db, p, body.goal, body.notes, trace=t),
                    compact=_compact_synth)


def ask(db: Session, body: AskRequest) -> dict:
    p = ps.get_project_or_404(db, body.project_id) if body.project_id is not None else None
    f = run = None
    if body.file_id is not None:
        f = ps.get_file_or_404(db, p, body.file_id) if p is not None else _file_anywhere(db, body.file_id)
        p = p or f.project
    if body.run_id is not None:
        run = ss.get_run_or_404(db, body.run_id)
        if p is None:
            p = run.project
        elif run.project_id != p.id:
            raise HTTPException(status_code=400, detail=f"Run {run.id} does not belong to project {p.id}")
    context = wf.ask_context(db, p, f, run)
    request = {"question": _clip(body.question), "question_chars": len(body.question),
               "project_id": p.id if p else None, "file_id": f.id if f else None, "run_id": run.id if run else None}
    return _execute(db, agent="assistant", action="ask", project_id=p.id if p else None,
                    run_id=run.id if run else None, request=request,
                    work=lambda t: wf.ask_workflow(body.question, context, trace=t))


# ---------------------------------------------------------------------------------------------
# Applying stored patches
# ---------------------------------------------------------------------------------------------
def apply_patches(db: Session, iid: int, paths: list[str] | None, *, kind: str) -> dict:
    """Write the patch contents stored in an AI debug/optimize session -> {applied: File[]}.

    All selected patches are checked before anything is written: each target file must still
    hold the patch's original content (or already hold the patched content, which is reported as
    applied without a new revision)."""
    agent, action = _APPLY_KINDS[kind]
    i = get_interaction_or_404(db, iid)
    if i.agent != agent or i.action != action:
        raise HTTPException(status_code=400, detail=(
            f"AI interaction {iid} is not an AI {kind} session (agent '{i.agent}', action '{i.action}')"))
    resp = dict(i.response) if isinstance(i.response, dict) else {}
    if resp.get("error"):
        raise HTTPException(status_code=400, detail=f"AI interaction {iid} failed, so it has no patches to apply")
    patches = [x for x in resp.get("patches") or [] if isinstance(x, dict) and isinstance(x.get("modified"), str)
               and isinstance(x.get("path"), str)]
    if not patches:
        raise HTTPException(status_code=400, detail=f"AI interaction {iid} proposed no patches")
    if i.project_id is None:
        raise HTTPException(status_code=400, detail=f"AI interaction {iid} is not linked to a project")
    project = ps.get_project_or_404(db, i.project_id)
    if paths is not None:
        if not paths:  # an explicit empty selection must not fall back to "apply everything"
            raise HTTPException(status_code=400, detail="No patch paths selected; omit 'paths' to apply every patch")
        wanted = list(dict.fromkeys(paths))
        known = [x["path"] for x in patches]
        unknown = [x for x in wanted if x not in known]
        if unknown:
            raise HTTPException(status_code=400, detail=(
                f"Unknown patch path(s) {', '.join(unknown)}; this session patches {', '.join(known)}"))
        patches = [x for x in patches if x["path"] in wanted]

    plan: list[tuple[SourceFile, str | None]] = []
    for patch in patches:
        fid = patch.get("file_id")
        f = db.get(SourceFile, fid) if isinstance(fid, int) else None
        if f is None or f.project_id != project.id:
            f = next((x for x in project.files if x.path == patch["path"]), None)
        if f is None:
            raise HTTPException(status_code=409, detail=(
                f"'{patch['path']}' no longer exists in project {project.id}; the patch cannot be applied"))
        current = f.content or ""
        if current == patch["modified"]:
            plan.append((f, None))
            continue
        if current != patch.get("original"):
            raise HTTPException(status_code=409, detail=(
                f"'{f.path}' changed after the AI proposed this patch; re-run the AI {kind} on the current "
                "sources to get a patch for them"))
        ps.check_content(patch["modified"], f.path)  # size + NUL: the same checks update_file_content makes
        plan.append((f, patch["modified"]))

    applied, record = [], []
    now = iso_utc(utcnow())
    for f, content in plan:
        if content is not None:
            ps.update_file_content(db, f, content, PATCH_REASON)
        applied.append(ps.file_dict(f))
        record.append({"path": f.path, "file_id": f.id, "applied_at": now, "already_applied": content is None})
    resp["applied"] = list(resp.get("applied") or []) + record
    resp["applied_at"] = now
    i.response = resp
    flag_modified(i, "response")
    db.commit()
    return {"applied": applied}
