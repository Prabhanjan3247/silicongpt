@echo off
title SiliconGPT Public Web Tunnel
echo ===================================================
echo       SiliconGPT Clean Public Tunnel (Zero Splash Screen)
echo ===================================================
echo.
echo Connecting to Cloudflare edge network...
echo No passwords, no splash screens, direct access!
echo.
cloudflared.exe tunnel --no-prechecks --protocol http2 --edge-ip-version 4 --url http://localhost:5173

