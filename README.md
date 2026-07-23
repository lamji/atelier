# Atelier

Local-first agentic AI software engineering platform.

Two independent systems connected by a token-authenticated WebSocket bridge:

- **`apps/agent`** — the Local Agent (Node 20). Owns every privileged
  operation: Claude Agent SDK, filesystem, terminal, git, tree-sitter
  knowledge engine, RAG, hooks, validation.
- **`apps/web`** — the Web UI (React + Vite). A pure presentation and
  orchestration layer; it never touches the filesystem, terminal, or Claude.
- **`packages/protocol`** — the zod-typed wire contract (envelope, RPC
  methods, event taxonomy) both sides compile against.

## Prerequisites

- Node 20 LTS (pinned via `engines`)
- pnpm 10
- A Claude subscription logged in via Claude Code (`claude` → `/login`)

## Getting started

```sh
pnpm install
pnpm --filter @atelier/agent smoke:native   # verify native modules build
pnpm dev:agent                              # start the Local Agent first
pnpm dev:web                                # then the Web UI (reads bridge.json)
```

The agent writes `%LOCALAPPDATA%\atelier\bridge.json` (port + auth token) at
startup; the web dev server injects it so the UI auto-connects. Set
`ATELIER_WORKSPACE=<path>` to point the agent at a project directory.

## Layout

```
apps/agent       Local Agent: bridge, orchestrator, tools, knowledge engine
apps/web         Web UI: views (dumb) / hooks (view-models) / state / services
packages/protocol  Wire contract: envelope, methods, events, models
packages/shared    Runtime-agnostic utilities
docs             Architecture notes and ADRs
```

## Status

Phase 1 (walking skeleton + chat) — see `docs/architecture.md` for the full
phase plan.

## Author

- jick
