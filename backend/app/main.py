"""SiliconGPT FastAPI application (REST API only, everything under /api).

Run: ``uvicorn app.main:app --port 8000`` from ``backend/``. Endpoints are plain ``def``
functions (executed in FastAPI's thread pool) because the HDL tools block.

Errors are always ``{"detail": "<message>"}``: HTTPException details as raised, request
validation errors flattened into one readable string (the structured list is in ``errors``),
and unexpected exceptions as a generic 500 with a reference id - the exception text, which can
contain file contents, SQL or configuration values, only goes to the server log. The 500 is
produced inside the CORS middleware (``CatchUnexpectedErrors``), so a cross-origin frontend can
read it; Starlette's own last-resort handler sits outside CORS.
"""
from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .api import ai, dashboard, examples, files, projects, reports, simulation, synthesis, system, waveform
from .core.config import get_settings
from .database.session import init_db
from .services.project_service import APP_VERSION

log = logging.getLogger("silicongpt")

API_PREFIX = "/api"
ROUTERS = (system.router, examples.router, projects.router, files.router, simulation.router,
           waveform.router, synthesis.router, reports.router, dashboard.router, ai.router)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


def cors_origins(raw: str | None) -> list[str]:
    return [o.strip().rstrip("/") for o in (raw or "").split(",") if o.strip()]


async def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    parts: list[str] = []
    errors: list[dict] = []
    for e in exc.errors():
        loc = [str(x) for x in e.get("loc", ()) if x != "body"]
        msg = str(e.get("msg") or "invalid value")
        parts.append(f"{'.'.join(loc)}: {msg}" if loc else msg)
        # "input"/"ctx" are left out: they echo request data (possibly whole files).
        errors.append({"loc": [str(x) for x in e.get("loc", ())], "msg": msg, "type": e.get("type")})
    return JSONResponse(status_code=422, content={"detail": "; ".join(parts) or "Invalid request",
                                                  "errors": jsonable_encoder(errors)})


def _internal_error(method: str, path: str, exc: BaseException) -> JSONResponse:
    ref = uuid.uuid4().hex[:12]
    log.error("unhandled error (ref %s) on %s %s", ref, method, path, exc_info=exc)
    return JSONResponse(status_code=500, content={
        "detail": f"Internal server error ({type(exc).__name__}, reference {ref}); details are in the server log."})


async def unexpected_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Last resort (Starlette's ServerErrorMiddleware): errors raised by the middleware itself."""
    return _internal_error(request.method, request.url.path, exc)


class CatchUnexpectedErrors:
    """Pure ASGI middleware, installed inside CORS/GZip: turns an exception that escapes the
    routes into the generic JSON 500 so the response still passes through CORSMiddleware.
    If the response had already started, the exception is re-raised (nothing can be sent)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except Exception as exc:  # noqa: BLE001 - converted to the generic 500 below
            if started:
                raise
            response = _internal_error(scope.get("method", ""), scope.get("path", ""), exc)
            await response(scope, receive, send)


def create_app() -> FastAPI:
    settings = get_settings()
    init_db()  # idempotent; also done on startup (lifespan) - tables exist even without lifespan
    app = FastAPI(title="SiliconGPT API", version=APP_VERSION, lifespan=lifespan,
                  docs_url=f"{API_PREFIX}/docs", redoc_url=None, openapi_url=f"{API_PREFIX}/openapi.json")
    # add_middleware() wraps: the middleware added last is the outermost. Order (outside in):
    # CORS -> GZip -> CatchUnexpectedErrors -> routes.
    app.add_middleware(CatchUnexpectedErrors)
    # Run logs, waveform windows and VCD downloads compress well; level 6 keeps CPU cost low.
    app.add_middleware(GZipMiddleware, minimum_size=4096, compresslevel=6)
    origins = cors_origins(settings.sgpt_cors_origins)
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=False,
                           allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                           allow_headers=["*"], expose_headers=["Content-Disposition"])
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(Exception, unexpected_error_handler)
    for router in ROUTERS:
        app.include_router(router, prefix=API_PREFIX)
    return app


app = create_app()
