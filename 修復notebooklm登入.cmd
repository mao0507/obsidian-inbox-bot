@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Step 1: Reinstalling notebooklm-py with the browser extra (fixes missing rookiepy)...
uv tool install --reinstall "notebooklm-py[browser]"

echo.
echo Step 2: Logging in to NotebookLM. A browser window will open - sign in with Google.
notebooklm login

echo.
echo Step 3: Verifying login...
notebooklm auth check --test --json

echo.
echo Done. You can close this window and start the bot as usual.
pause >nul
