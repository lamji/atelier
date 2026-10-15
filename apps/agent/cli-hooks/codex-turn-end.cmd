@echo off
rem Codex's Stop hook on Windows: tells Atelier this terminal's turn ended.
rem Codex calls this from PowerShell by its path in ATELIER_TURN_HOOK; the
rem script runs on the app's own runtime.
set ELECTRON_RUN_AS_NODE=1
"%ATELIER_HOOK_NODE%" "%~dp0turn-end.mjs" codex
