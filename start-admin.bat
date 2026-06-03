@echo off
title 9Router MITM Admin Server
cd /d "%~dp0"
echo ============================================
echo   9Router MITM Admin Server
echo   Starting on http://127.0.0.1:3000
echo ============================================
echo.

:: Kiểm tra Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js not found! Please install Node.js first.
    pause
    exit /b 1
)

:: Kiểm tra node_modules
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    npm install
    if %ERRORLEVEL% NEQ 0 (
        echo [ERROR] npm install failed!
        pause
        exit /b 1
    )
    echo.
)

echo [INFO] Starting Admin UI Server...
node index.js
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Server exited with code %ERRORLEVEL%
    pause
    exit /b 1
)
