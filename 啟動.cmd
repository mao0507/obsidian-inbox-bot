@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem One-time setup: install dependencies, then register the bot as a background service (pm2)
rem that starts automatically when you log in. Safe to run again (e.g. after updating the code).
rem Other systems (macOS / Linux): run "pnpm install" then "pnpm run service:install" in a terminal.

where pnpm >nul 2>nul
if errorlevel 1 (
    echo pnpm not found. Enabling it via corepack...
    call corepack enable pnpm
)

echo Installing dependencies...
call pnpm install
if errorlevel 1 goto failed

echo.
echo Registering background service...
call pnpm run service:install
if errorlevel 1 goto failed

echo.
echo Done. The bot now runs in the background - you can close this window.
echo View logs:  pnpm run service:logs
echo Restart:    pnpm run service:restart
pause >nul
exit /b 0

:failed
echo.
echo Setup failed, see the messages above. Press any key to close this window.
pause >nul
exit /b 1
