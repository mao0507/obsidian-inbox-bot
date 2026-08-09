@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies, first run only...
    call npm install
)

echo Starting obsidian-inbox-bot...
echo Close this window to stop the program.
echo.
call npm start

echo.
echo Program has stopped ^(possibly due to an error^), press any key to close this window.
pause >nul
