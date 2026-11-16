@echo off
title SiliconGPT Public Web Tunnel
echo ===================================================
echo       SiliconGPT Instant Public Tunnel
echo ===================================================
echo.
echo Make sure SiliconGPT is running (via run.bat).
echo Starting public tunnel on port 5173...
echo.
echo (If prompted on the webpage for a password, enter your IP from: https://loca.lt/mytunnelpassword)
echo.
npx -y localtunnel --port 5173
