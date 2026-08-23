# FAQ — how Atelier works, and what happens to your data

Written by reading the code, not the intentions. Where something is a
weakness, it says so.

- [What Atelier is](#what-atelier-is)
- [Does Atelier collect telemetry?](#does-atelier-collect-telemetry)
- [What leaves my machine?](#what-leaves-my-machine)
- [What exactly is sent to the model?](#what-exactly-is-sent-to-the-model)
- [What is stored on my machine, and where?](#what-is-stored-on-my-machine-and-where)
- [How are API keys stored?](#how-are-api-keys-stored)
- [How does the index work?](#how-does-the-index-work)
- [Does Atelier remember across sessions and projects?](#does-atelier-remember-across-sessions-and-projects)
- [What can the agent do without asking?](#what-can-the-agent-do-without-asking)
- [Can I run it with no knowledge engine at all?](#can-i-run-it-with-no-knowledge-engine-at-all)
- [What does the update check send?](#what-does-the-update-check-send)
- [How do I delete everything?](#how-do-i-delete-everything)
- [Is my code used to train anything?](#is-my-code-used-to-train-anything)

---

## What Atelier is

A desktop app (Electron) with three parts:

- **The renderer** — the UI you see.
- **The agent host** — a background process per machine, holding one
  *workspace* per project you open. It owns the index, the tools, the hooks
  and the conversation history. The UI talks to it over an in-process
  MessagePort, not a network socket.
- **A model provider** — Claude, Codex, Ollama or Grok. This is the only
  part that is not on your machine, unless you use local Ollama, in which
  case none of it is.

Opening a folder parses it with tree-sitter into a SQLite symbol graph and a
vector store, both local. Agent turns then run against that index.

## Does Atelier collect telemetry?

**No.** There is no analytics SDK, no crash reporter, no usage ping, no
install beacon. Searching the whole source for `telemetry`, `analytics`,
`posthog`, `sentry`, `mixpanel`, `amplitude`, `segment`, `datadog` and
`gtag` returns two hits, and neither leaves the machine:

- `CodexTelemetry` in `providers/codex/client.ts` — an in-process event bus
  that drives the timeline UI.
- `AnalyticsCard` in the route scanner — a component name in a comment.

Nobody is counting installs. The download counter on the GitHub release page
is GitHub's, not ours.

## What leaves my machine?

Four hosts, all of them things you asked for:

| Host | When | What |
|---|---|---|
| Your model provider | every agent turn | the assembled prompt (below) |
| `ollama.com` | only with an Ollama Cloud key configured | prompts + the model roster |
| `api.x.ai` | only with a Grok key configured | prompts |
| `api.github.com` | update check, at launch and every 6h | nothing but a `User-Agent` |

Claude runs through the Claude Agent SDK on your existing Claude Code login;
Codex runs through the `codex` CLI on your ChatGPT login. Atelier does not
hold or proxy those credentials.

With **local Ollama** as the provider, nothing leaves the machine at all
except the update check — and that can be ignored.

## What exactly is sent to the model?

An agent turn sends one prompt, assembled from named blocks. You can see
every block and its token cost for any turn in the timeline's *"sent to
model"* row — that row is generated from the same structure that builds the
request, so it cannot drift from what was actually sent.

The blocks are:

- **Your message**, and images you attached.
- **The workspace layout** — the project's directory map, with file names.
- **The rules** — Atelier's execution contract, plus your own `.atelier/rules`.
- **Retrieved chunks** — source excerpts the index scored as relevant.
- **The scope lock** — the folders this conversation is working in.
- **Session memory and working memory** — summaries of earlier turns and
  what they read.
- **The impact radius** — callers, flows and tests around the edit targets.
- **The feature wiki** — compiled pages about features the turn touches.

So: **your code goes to the model, in excerpts, when a turn needs it.** That
is what an AI code editor is. What Atelier controls is *how much* — the
assembler works to a token budget, and the scope lock keeps other projects
in the workspace out of it.

Tool calls then read more files as the turn runs. Those results are also
part of the conversation with the provider.

## What is stored on my machine, and where?

Two places, both plain files you can inspect or delete.

**1. The agent data root** — `%LOCALAPPDATA%\atelier` on Windows,
`~/.local/share/atelier` elsewhere (override with `ATELIER_DATA_DIR`):

```
atelier.db            machine-level database
projects/<slug>/      one SQLite database per project you have opened
  atelier.db          the index, the history, the memory for that project
  models/             the local embedding model, cached after first download
providers.json        provider settings and API keys  (see below)
projects.json         the projects you have added
updates.json          the last version that ran, for the changelog modal
logs/agent.log        the agent's log
attachments/          images you pasted into a conversation
```

Each project's `atelier.db` holds: conversations and every chat message,
tasks and their timelines, terminal scrollback (`terminal_history`), the
parsed symbol graph (`files`, `symbols`, `imports`, `call_edges`,
`symbol_refs`), chunk text and its embeddings, inferred features, saved
lessons, task summaries and session memory.

**In plain terms: your prompts, the model's replies, your terminal output
and excerpts of your source are all on disk, unencrypted, in SQLite.** They
are as private as the machine is.

**2. `.atelier/` inside each project** — notes, prompt files, plans and
review output. It is added to that project's `.gitignore` automatically, so
it is not committed by accident.

## How are API keys stored?

`providers.json` in the data root, as **plain JSON, unencrypted**. Anything
that can read your user profile can read your Ollama Cloud or Grok key.

This is the weakest part of the data story and worth being blunt about: the
OS keychain (Electron's `safeStorage`) is the right home for these and is
not used yet. Claude and Codex are unaffected — those authenticate through
their own CLIs and Atelier never sees a token.

## How does the index work?

On opening a folder, a background pass walks it (honouring `.gitignore`
plus built-in ignores like `node_modules`, `dist`, `.next`), parses each
source file with tree-sitter, and writes symbols, imports, call edges and
references into SQLite. Text chunks are embedded into a local vector store.

**Embeddings are computed locally** — `all-MiniLM-L6-v2` quantized, running
in-process through ONNX. The model downloads once (~25 MB) into
`<data root>/models` and works offline afterwards. If it cannot load,
indexing continues without embeddings and retrieval falls back to keyword +
graph search. **No text is sent anywhere to be embedded.**

The watcher keeps the index current as files change.

## Does Atelier remember across sessions and projects?

Across **sessions in a project**: yes. Task summaries and session memory are
written per project and retrieved on later turns — that is what makes a
follow-up cheaper than starting over.

Across **projects**: only if you switch it on. `globalSessionKnowledge`
defaults to **false** (`runtime.ts`). While it is off, retrieval never
reaches another project's memory. Each project also has its own database
file, so there is no shared index to leak through.

Within a turn, a **scope lock** binds the conversation to the folders it is
working in, and a guard refuses reads and edits outside it.

## What can the agent do without asking?

It reads, searches, and edits files inside the workspace freely — that is
the job. Several blocking hooks sit in front of the destructive or
surprising things, and they are listed with their matchers in the Hooks
panel, where you can switch any of them off:

- **git flow** — the agent may not commit, push or open a PR. It stages and
  reports; you run the wizard.
- **database approval** — a migration or DB command pauses in a modal for
  you to approve or cancel.
- **dev server** — the same, for starting long-running servers.
- **targeted edits** — refuses a whole-file rewrite that is really a patch.
- **flex layout / modularity** — convention guards on UI and file structure.
- **grounded search** — refuses a search for an identifier that appears
  nowhere in the request, the context, or anything already read.

Nothing outside the workspace directory is readable or writable, and paths
are workspace-relative throughout.

## Can I run it with no knowledge engine at all?

Yes — untick **System knowledge** in the composer. That turn is a plain
agent loop: no retrieval, no graph, no impact analysis, no plan tracking,
and nothing written to session memory. The knowledge tools are not just
discouraged, they are **absent from the tool list** for that turn, which is
what makes "no retrieval" a fact rather than a request.

The consent gates (git, database, dev server) still apply.

## What does the update check send?

A `GET` to `api.github.com/repos/lamji/atelier/releases/latest`, at launch
and every six hours, with a `User-Agent` of `Atelier/<version>`. No
identifier, no machine fingerprint, no project data. GitHub sees an IP
address and a version string, as it would for any download.

The result is compared to the running version, and a button appears if a
newer one exists. **Nothing downloads or installs by itself** — clicking it
opens the installer in your browser.

To switch it off entirely, block the host; the check fails silently and the
app is unaffected.

## How do I delete everything?

Uninstall Atelier, then delete:

- `%LOCALAPPDATA%\atelier` — every project database, keys, logs, attachments
- `.atelier/` in any project you opened — notes, plans, reviews

For a single project, delete just its folder under
`%LOCALAPPDATA%\atelier\projects\`. Removing a project from the app's list
does not delete its database; that is deliberate, so a re-added project
keeps its history, but it means the data outlives the list entry.

## Is my code used to train anything?

Not by Atelier — there is nowhere for it to go, because there is no server.

What the **provider** does with the prompts is their policy, not ours. If
that matters for your code, the answer is local Ollama: the whole turn then
runs on your machine.

---

*Something here inaccurate or out of date? It is a bug — please
[open an issue](https://github.com/lamji/atelier/issues). This file is meant
to be checkable against the source, and every claim in it was.*
