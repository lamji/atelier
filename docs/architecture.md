# Atelier Architecture

Two independent systems joined by a token-authenticated local WebSocket bridge.

```
Web UI (React/Vite)  <-- ws://127.0.0.1:43110 -->  Local Agent (Node 20)
  presentation only                                  all privileged operations
                                                       └─ Claude Agent SDK
```

## The contract: `packages/protocol`

Everything on the wire is defined once, in zod, and imported by both apps:

- **Envelope** (`envelope.ts`) — `req` / `res` / `progress` / `cancel` /
  `sub` / `unsub` / `event` frames. Close code 4401 = auth failure.
- **Methods** (`methods/`) — every RPC with typed params/result. Unimplemented
  methods answer `NOT_IMPLEMENTED` so the full surface exists from day one.
- **Events** (`events.ts`) — the observable taxonomy (`pipeline.*`, `tool.*`,
  `diff.*`, `terminal.*`, `knowledge.*`, …). Payloads are schema-validated in
  `EventBus.publish` before leaving the agent.

## Local Agent (`apps/agent`)

- `events/event-bus.ts` — every service publishes here; the bridge event hub
  and the SQLite timeline store are subscribers. Observability is one line
  per feature, never a special case.
- `bridge/` — ws server (127.0.0.1 only, Origin-checked), handshake
  (`session.hello` with the token from `%LOCALAPPDATA%\atelier\bridge.json`),
  router with zod validation, per-topic seq + replay-from-`since`.
- `orchestrator/` — wraps `@anthropic-ai/claude-agent-sdk` `query()`.
  Built-in SDK tools are disabled; the model only ever gets Atelier's own
  tools (via `createSdkMcpServer`, Phase 2+) so hooks/diffs/events are never
  bypassed. Phase 6 replaces the direct call with the 9-stage
  `pipeline-executor`.
- `storage/schema.sql` — runtime tables (conversations, tasks, timeline,
  hooks, terminal history) + the full knowledge-engine schema (files,
  symbols, imports/exports, call_edges, features, chunks, embeddings,
  index_jobs, test_runs).
- Native modules: `better-sqlite3` (v11, prebuilt) and `@lydell/node-pty`
  (prebuilt ConPTY fork — no VS Build Tools needed). Verify with
  `pnpm --filter @atelier/agent smoke:native`.

## Web UI (`apps/web`)

MVVM discipline: `views/` are dumb (props in, callbacks out), `hooks/` are
the view-models, `state/` are zustand stores, `types/` central types.
`services/bridge-client.ts` owns the single WebSocket (handshake, typed
`rpc()`, subscriptions, reconnect + seq replay); `services/event-dispatcher.ts`
routes pushed events into stores.

## Phase plan

| # | Phase | Status |
|---|-------|--------|
| 1 | Walking skeleton + chat | **done** — handshake, streamed chat, cancel, timeline |
| 2 | Workspace, files, diffs | **done** — fs RPCs + SDK tools, watcher, explorer, Monaco editor/diff, dark/light toggle |
| 3 | Terminal | **done** — node-pty (ConPTY) sessions, xterm dock tab, run_terminal tool, history |
| 4 | Git | scaffolded (`git/`, git methods) |
| 5 | Knowledge engine v1 + RAG | scaffolded (`knowledge/`, `rag/`, schema) |
| 6 | Pipeline + hooks + validation | scaffolded (`pipeline-executor`, `hooks/`) |
| 7 | Feature models + monitor | monitor **done early** (multi-session UI, parallel tasks); features scaffolded |
| 8 | Hardening + settings + polish | — |

Porting sources for later phases (approved plan): `myai/src/indexer` +
`src/engine` (clean TS tree-sitter indexer + agent loop) and `agent-deck`'s
`codegraph-*.js` / `vectors*.js` / `walker.js` as references.

## Verification

- `pnpm -r typecheck` — all packages strict-clean.
- `pnpm --filter @atelier/agent smoke:native` — native modules load.
- `apps/agent/scripts/bridge-smoke.ts` — end-to-end: bad-token 4401, hello,
  real Claude round-trip, timeline persistence, stub-method behavior.
