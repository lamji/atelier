---
name: reference-doc
description: Read back the flow reports saved under .atelier/doc-agent so their findings are in context again. Use after a compact, a cleared or new session, or to build on a trace another session wrote.
---

# Reference Doc

Bring the saved flow reports back into this conversation. The `document`
skill writes them; a compact, a cleared session, or a new session loses
what they said.

This skill only reads. Do not change source code.
Do not edit, rewrite, or delete a report.

Everything after the command says which reports are wanted. It may be
empty.

## Which reports to read

The reports are markdown files under the directory this session was
started in:

    .atelier/doc-agent/<YYYYMMDD-HHMMSS>-<flow-slug>.md

Each opens with a frontmatter block: `id`, `session`, `title`, and
`updated` once it has been brought up to date.

1. List the folder and read only the frontmatter of every report. If the
   folder is missing or empty, say so and stop. List and read with your
   file tools, not a shell command: a shell command stops to ask the user
   for permission.
2. Work out this session's id: when the request carries `Session: <id>`,
   use that id. Otherwise use `${CLAUDE_SESSION_ID}`.
3. Pick the reports:
   - **Nothing was asked for** (the request is empty, or says it was not
     given): do not ask what to load. Take every report whose `session` is
     this session's id. If none match, take the three newest reports.
   - **A report id or file name was given**: take that report.
   - **A topic or task was given**: take this session's reports that bear
     on it, then any other report whose title bears on it. Leave the rest
     unread.
4. Read each picked report in full, newest first.

## Using what they say

A report describes the code as it was when the report was written. Treat
it as a map of where to look, not as the code itself.

- Before relying on a claim, re-read the `file:line` it cites. If the code
  no longer matches, trust the code and say which report is out of date.
- A report whose `session` is not this session's id was written by other
  work: nothing in this conversation has checked it.
- An `Inferred Or Unresolved` entry is still unresolved. Do not present it
  as a finding.

## Reply

Keep it short:

1. One line per report read: its path, its title, and when it was written
   or last updated.
2. What the reports establish that matters for the request, in a few lines,
   with the `file:line` each point rests on.
3. Any report found out of date, and the claim that no longer holds.

If the request also asked for work, carry on with it now, using the
reports as the starting point.
