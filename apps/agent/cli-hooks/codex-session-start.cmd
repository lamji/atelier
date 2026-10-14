@echo off
rem Codex's SessionStart hook on Windows. Codex calls this from PowerShell
rem by its path in ATELIER_SESSION_HOOK, which keeps quoted paths out of the
rem launch arguments; the script runs on the app's own runtime.
set ELECTRON_RUN_AS_NODE=1
"%ATELIER_HOOK_NODE%" "%~dp0session-start.mjs" codex
