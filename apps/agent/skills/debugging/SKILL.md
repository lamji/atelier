---
name: debugging
description: Diagnose and fix a reproducible defect with evidence, a narrow plan, and focused verification.
---

# Debugging

Use this skill for a reported bug, broken UI behavior, runtime error, regression, or unexpected output.

## Investigate before editing

1. Treat screenshots, logs, and prior summaries as leads, not proof of the current implementation.
2. Locate the visible trigger or concrete entry point, read its owner, and trace the handler, data, and rendered result through the divergence.
3. Read every file you will change before editing. Keep the fix limited to the confirmed path.
4. For a change task, create a file-specific execution plan before the first edit and complete its steps in order.

## Fix and verify

1. State the observed behavior, expected behavior, and the smallest confirmed cause.
2. Change the live owner rather than adding a workaround elsewhere.
3. Re-read the connected caller and render path after the edit.
4. Run the narrowest relevant check, test, or preview. Report the evidence and any remaining limitation.

## Provider-neutral rules

- Use only Atelier's workspace tools; never rely on an external skill-file path.
- The same workflow applies to Ollama, Claude, and Codex. Their tool mechanics differ, but the evidence, plan, edit, and verification requirements do not.
- Do not ask whether to proceed once the defect and safe default are clear.
