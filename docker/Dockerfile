# syntax=docker/dockerfile:1
# Multi-stage image for SiliconGPT.
#   target "sim"     : HDL toolchain only. Used by SGPT_SANDBOX_MODE=docker, one throw-away
#                      container per tool invocation (--network none, --read-only, --cap-drop ALL).
#   target "backend" : FastAPI backend + the same toolchain (local restricted executor inside
#                      a hardened container; see docker-compose.yml).
# NOTE: built and tested only on hosts with Docker; the development host used for this MVP
# had no Docker, so these images are provided as configuration, not as verified artefacts.

FROM ubuntu:24.04 AS toolchain
ARG OSS_CAD_SUITE_DATE=2026-11-15
ARG OSS_CAD_SUITE_TAG=20261115
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl g++ make perl python3 \
 && rm -rf /var/lib/apt/lists/*
RUN set -e; \
    if [ "$TARGETARCH" = "arm64" ] || [ "$(uname -m)" = "aarch64" ]; then \
      ARCH="arm64"; \
    else \
      ARCH="x64"; \
    fi; \
    curl -fsSL -o /tmp/oss.tgz \
      "https://github.com/YosysHQ/oss-cad-suite-build/releases/download/${OSS_CAD_SUITE_DATE}/oss-cad-suite-linux-${ARCH}-${OSS_CAD_SUITE_TAG}.tgz" \
 && tar -xzf /tmp/oss.tgz -C /opt \
 && rm /tmp/oss.tgz
ENV PATH=/opt/oss-cad-suite/bin:$PATH

FROM toolchain AS sim
RUN useradd --uid 10001 --create-home sim
USER 10001
WORKDIR /work

FROM toolchain AS backend
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r backend/requirements.txt
COPY backend/app backend/app
COPY examples examples
COPY docs docs
RUN useradd --uid 10001 --create-home sgpt && mkdir -p /app/backend/data && chown -R 10001 /app/backend/data
USER 10001
ENV SGPT_TOOLCHAIN_DIR=/opt/oss-cad-suite \
    SGPT_CXX_DIR=/usr/bin \
    SGPT_DATA_DIR=/app/backend/data \
    SGPT_SANDBOX_MODE=local \
    PYTHONUNBUFFERED=1
WORKDIR /app/backend
EXPOSE 8000
CMD ["/opt/venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
