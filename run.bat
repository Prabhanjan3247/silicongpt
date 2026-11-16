@echo off
setlocal
cd /d "%~dp0"

echo ===================================================
echo           SiliconGPT Workstation Launcher
echo ===================================================
echo.

if not exist "backend\.venv\Scripts\python.exe" (
    echo [ERROR] Python virtual environment not found in backend\.venv
    pause
    exit /b 1
)

echo [1/2] Starting SiliconGPT Backend on http://127.0.0.1:8000 ...
start "SiliconGPT Backend (:8000)" cmd /k "backend\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000"

echo [2/2] Starting SiliconGPT Frontend on http://localhost:5173 ...
start "SiliconGPT Frontend (:5173)" cmd /k "npm --prefix frontend run dev"

echo.
echo Waiting for servers to initialize...
timeout /t 3 >nul

echo Opening SiliconGPT in your browser...
start http://localhost:5173

echo.
echo ===================================================
echo SiliconGPT is running!
echo Both backend (:8000) and frontend (:5173) are active.
echo To stop, simply close the two terminal windows.
echo ===================================================
