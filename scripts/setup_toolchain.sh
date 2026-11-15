#!/usr/bin/env bash
# Downloads the HDL toolchain used by SiliconGPT into ../eda-toolchain (next to the repo).
#   * YosysHQ OSS CAD Suite (Icarus Verilog, Verilator, Yosys, GTKWave)
#   * Windows only: w64devkit (g++ 16 + make) so Verilator can build simulation binaries
# Usage (Git Bash on Windows, or bash on Linux):  bash scripts/setup_toolchain.sh
set -euo pipefail
DATE="${OSS_CAD_SUITE_DATE:-2026-11-15}"
TAG="${DATE//-/}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$(cd "$ROOT/.." && pwd)/eda-toolchain"
mkdir -p "$DEST"
cd "$DEST"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM=windows-x64 ;;
  Linux*)               PLATFORM=linux-x64 ;;
  Darwin*)              PLATFORM=darwin-$( [ "$(uname -m)" = arm64 ] && echo arm64 || echo x64 ) ;;
  *) echo "unsupported platform"; exit 1 ;;
esac

if [ ! -d oss-cad-suite ]; then
  URL="https://github.com/YosysHQ/oss-cad-suite-build/releases/download/${DATE}/oss-cad-suite-${PLATFORM}-${TAG}.tgz"
  echo "Downloading $URL"
  curl -fL -o oss-cad-suite.tgz "$URL"
  tar -xzf oss-cad-suite.tgz
  rm -f oss-cad-suite.tgz
fi

if [ "$PLATFORM" = windows-x64 ] && [ ! -d w64devkit ]; then
  VER="${W64DEVKIT_VERSION:-2.11.0}"
  URL="https://github.com/skeeto/w64devkit/releases/download/v${VER}/w64devkit-x64-${VER}.7z.exe"
  echo "Downloading $URL"
  mkdir -p w64dl
  curl -fL -o w64dl/w64devkit.7z.exe "$URL"
  ./w64dl/w64devkit.7z.exe -y -o"$(cygpath -w "$DEST")" > /dev/null
fi

echo "Toolchain ready in $DEST"
ls "$DEST"
