---
name: impact-check
description: Prevent regressions when changing code. Before each edit Atelier adds a tree-sitter impact list of every place that uses the code being changed; keep those working, then run the --diff check and the related tests after the fix.
---

# Impact Check

Every fix can break the code that depends on what it changes. This skill
makes that visible before the edit and checks it after.

## Before every edit (automatic)

Atelier runs a tree-sitter impact check before each file edit, by itself:
nobody has to ask for it, and it never blocks the edit. It finds the
functions, components, or classes the edit lands in, and every place in the
repo that calls, imports, or references them. A name that only appears in a
comment, a string, or prose is not counted. The result arrives as context
headed `Atelier impact check (tree-sitter)`.

When it arrives:

1. Read it before writing the change. For each listed site that the change
   could affect (a changed signature, return value, thrown error, side
   effect, or behaviour), read that site.
2. Keep each affected site working: keep the change compatible, or update
   the site in the same fix. Do not change a site the fix does not need.
3. If the list says "more not listed", search for the remaining uses before
   changing a signature.

Only TypeScript and JavaScript files are analysed. For any other file, find
the users by reading the code yourself.

## After every edit (automatic)

Once the edit is written, the check runs again on the code just written and
arrives headed `Atelier impact check (tree-sitter) after editing`. Re-check
each listed site against what you just wrote, and update any site that no
longer fits before moving on.

## After the fix

1. Optionally, sweep everything the fix changed in one go. Skip this if the
   CLI asks the user for permission to run it: the after-edit reports above
   already cover each edit.

   - Bash or zsh (Claude Code on any platform, Codex on macOS or Linux):

         ELECTRON_RUN_AS_NODE=1 "$ATELIER_HOOK_NODE" "$ATELIER_IMPACT_SCRIPT" --diff

   - Windows PowerShell (Codex on Windows):

         $env:ELECTRON_RUN_AS_NODE=1; & $env:ATELIER_HOOK_NODE $env:ATELIER_IMPACT_SCRIPT --diff

   It lists each changed function in the working tree, every place that uses
   it, and the test files among them. If the variables are not set, the
   session was not started from Atelier: find the users by search instead.
2. Re-read every listed site the fix could affect, and confirm it still
   works with the new code.
3. Run the tests it lists, and the project's own check (type check, lint)
   when the fix changed a signature or a type. If no test covers a changed
   function, say so.
4. Report: the sites checked, the tests run and their result, and any site
   left unverified and why. Never say "nothing is broken" without having
   run the check and the tests.
