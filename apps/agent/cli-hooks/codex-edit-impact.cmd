@echo off
rem Codex's PreToolUse hook on Windows: the tree-sitter impact check before
rem an edit. Codex calls this from PowerShell by its path in
rem ATELIER_EDIT_HOOK; the script runs on the app's own runtime.
set ELECTRON_RUN_AS_NODE=1
"%ATELIER_HOOK_NODE%" "%~dp0edit-impact.mjs" codex
