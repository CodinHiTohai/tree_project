@echo off
title TreeGuard Server
cd /d "%~dp0"
echo.
echo  =========================================
echo   TreeGuard - Smart Tree Monitoring System
echo  =========================================
echo.
echo  Starting server...
echo  Open browser: http://localhost:3000
echo.
node server.js
pause
