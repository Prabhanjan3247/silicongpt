#!/usr/bin/env bash
set -e

echo "==================================================="
echo "         SiliconGPT Cloud Linux Launcher"
echo "==================================================="

# 1. Download toolchain if not present
if [ ! -d "eda-toolchain/oss-cad-suite" ]; then
    echo "[1/4] Setting up OSS CAD Suite toolchain (Icarus, Verilator, Yosys)..."
    bash scripts/setup_toolchain.sh
fi

# 2. Check build tools (g++, make)
if ! command -v g++ &> /dev/null; then
    echo "[2/4] Installing g++ and make..."
    sudo apt-get update -qq && sudo apt-get install -y -qq g++ make python3-venv
fi

# 3. Setup Python backend
if [ ! -d "backend/.venv" ]; then
    echo "[3/4] Creating Python environment..."
    python3 -m venv backend/.venv
    backend/.venv/bin/pip install --quiet -r backend/requirements.txt
fi

# Detect Python binary (Linux bin/ vs Windows Scripts/)
if [ -f "backend/.venv/bin/python" ]; then
    PYTHON_BIN="backend/.venv/bin/python"
elif [ -f "backend/.venv/Scripts/python.exe" ]; then
    PYTHON_BIN="backend/.venv/Scripts/python.exe"
else
    PYTHON_BIN="python"
fi

# Setup backend .env with Gemini key if not present
if [ ! -f "backend/.env" ]; then
    KEY="${GEMINI_API_KEY:-AQ.Ab8RN6Ke0vV8sX4Z59nDVmvLrWE2JYjQFQn9rMN3l3ksypMs8Q}"
    echo "GEMINI_API_KEY=$KEY" > backend/.env
    echo "SGPT_GEMINI_MODEL=gemini-3.5-flash-lite" >> backend/.env
fi

# 4. Setup frontend
if [ ! -d "frontend/node_modules" ]; then
    echo "[4/4] Installing frontend dependencies..."
    npm --prefix frontend install --quiet
fi

# Ensure .env.local points to backend
echo "SGPT_BACKEND_URL=http://127.0.0.1:8000" > frontend/.env.local

echo ""
echo "Starting backend server on port 8000..."
$PYTHON_BIN -m uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

echo "Starting frontend dev server on port 5173..."
npm --prefix frontend run dev -- --host 0.0.0.0 --port 5173 &
FRONTEND_PID=$!

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT

echo ""
echo "==================================================="
echo " SiliconGPT is running!"
echo " Ports: 5173 (Frontend UI) | 8000 (FastAPI Backend)"
echo "==================================================="

wait
