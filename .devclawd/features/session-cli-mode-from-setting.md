---
feature: session cli mode from setting
slug: session-cli-mode-from-setting
status: stale
updated: 2026-08-09T04:22:19.918Z
aliases:
  - CLI mode toggle
  - terminal CLI sessions
  - CLI console pane
  - Codex/Claude CLI switching
sources:
  - "apps/web/src/views/settings/SettingsPanel.tsx @ 1786202301671 @ ee64e802350d"
  - "apps/web/src/state/preferences.store.ts @ 1786196928517 @ da3c3454cf81"
  - "apps/web/src/views/shell/AppShell.tsx @ 1786199865618 @ 1bd443680fe1"
  - "apps/web/src/views/cli/CliConsolePane.tsx @ 1786249250674 @ f61c4b1bd298"
  - "apps/web/src/views/cli/CliSessionListPanel.tsx @ 1786248280840 @ ce0e5cdeda36"
  - "apps/web/src/services/cli-console.ts @ 1786248274714 @ 9250e15e71a2"
  - "apps/web/src/views/cli/CliProviderModal.tsx @ 1786199834793 @ 9694f9fd72ee"
  - "apps/web/src/services/cli-baseline.ts @ 1786199137650 @ 97f984df94c2"
  - "apps/web/src/hooks/useGitChangesRailViewModel.ts @ 1786199154759 @ 4393945636f0"
  - "apps/web/src/services/terminal-registry.ts @ 1786249206325 @ 48c4b1db888c"
  - "apps/web/src/services/bridge-client.ts @ 1785430180622 @ cbd3be047ed2"
---

# session cli mode from setting

CLI mode is an opt-in setting that swaps the main chat interface for a real provider CLI (Codex or Claude) running in a pseudo-terminal. When enabled, the chat transcript and composer disappear, and users interact directly with the CLI's own session flow with no Atelier pipeline—no retrieval, plan, review, or memory. Chat sessions remain untouched and switch back when CLI mode is disabled. The left rail's agent list becomes a CLI session switcher, grouped by provider, showing both running sessions and the provider's historical ones available to resume.

## Entry points

- `apps/web/src/views/settings/SettingsPanel.tsx:152` — CliModeCheck: A themed checkbox in the Settings panel that reads and toggles the cliMode preference.
- `apps/web/src/views/shell/AppShell.tsx:80` — AppShell reads cliMode on init and subscribes to changes, driving layout conditionals.
- `apps/web/src/views/shell/AppShell.tsx:238` — "Create Session" command: branches on cliMode to open CliProviderModal (CLI) or create a chat session.

## Flow

1. User clicks the CliModeCheck checkbox in Settings (`apps/web/src/views/settings/SettingsPanel.tsx:161`).
2. onClick handler calls `setCliMode(!cliMode)` (`apps/web/src/views/settings/SettingsPanel.tsx:161`).
3. setCliMode saves the new value to localStorage via `scoped(CLI_MODE_KEY)` as "1" or "0" (`apps/web/src/state/preferences.store.ts:184-185`).
4. Zustand store updates with `set({ cliMode: value })`, triggering all subscribers (`apps/web/src/state/preferences.store.ts:186`).
5. AppShell re-renders because it reads `cliMode` from usePreferencesStore (`apps/web/src/views/shell/AppShell.tsx:80`).
6. Left rail renders CliSessionListPanel (CLI mode) instead of SessionListPanel (chat mode) (`apps/web/src/views/shell/AppShell.tsx:175-192`).
7. Main chat pane renders CliConsolePane (CLI mode) instead of ChatPanel (chat mode), memoized to preserve xterm state (`apps/web/src/views/shell/AppShell.tsx:225-229`).
8. CliConsolePane mounts and checks if connected and not yet bootstrapped (`apps/web/src/views/cli/CliConsolePane.tsx:50-62`).
9. CliConsolePane calls `ensureCliSessions()` to acquire or reattach to running CLI ptys (`apps/web/src/views/cli/CliConsolePane.tsx:54`).
10. ensureCliSessions RPC-calls `terminal.list` to fetch existing sessions (`apps/web/src/services/cli-console.ts:380`).
11. Sessions are filtered: only those with names matching `isCliConsoleSession()` (prefix "cli:" or legacy "codex-cli") are kept (`apps/web/src/services/cli-console.ts:381`).
12. Store is updated: `setSessions(live)` and `setBootstrapped()` (`apps/web/src/services/cli-console.ts:383-384`).
13. For each live session: topic watcher and baseline snapshot are set up (`apps/web/src/services/cli-console.ts:390-393`).
14. Provider history is fetched via `refreshCliHistory()` for the resume list (`apps/web/src/services/cli-console.ts:397`).
16. createCliSession gets the provider and calls `spawnCliSession(provider, provider.command)` (`apps/web/src/services/cli-console.ts:448-450`).
17. spawnCliSession calculates the next ordinal for that provider, RPC-calls `terminal.create` with a name encoding provider and ordinal (`apps/web/src/services/cli-console.ts:429-432`).
18. The CLI command is written to the new pty via `terminal.write` (`apps/web/src/services/cli-console.ts:433-436`).
19. New session is added to store via `store.add(toVm(session))` (`apps/web/src/services/cli-console.ts:437`).
20. Baseline is captured to track git changes the session makes (`apps/web/src/services/cli-console.ts:440`).
21. CliConsolePane mounts xterm instances into DOM containers via `terminalRegistry.mount()` for each session (`apps/web/src/views/cli/CliConsolePane.tsx:67-80`).
22. terminalRegistry.mount() fetches terminal history via `terminal.getHistory` RPC and replays it into the terminal, scrolling to the end (`apps/web/src/services/terminal-registry.ts:202-209`).
22. CliSessionListPanel renders provider groups, live sessions, and historical resumable sessions (`apps/web/src/views/cli/CliSessionListPanel.tsx:41-115`).
23. When user clicks "Create Session" button (or command), if in CLI mode, `openProviderPicker()` is called to let user choose which CLI to start (`apps/web/src/views/shell/AppShell.tsx:239`).
24. CliProviderModal opens and user selects a CLI provider (`apps/web/src/views/cli/CliProviderModal.tsx:12-114`).
25. Modal calls `createCliSession(providerId)` with the chosen provider (`apps/web/src/views/cli/CliProviderModal.tsx:31`).
26. When user switches projects, `setProjectScope()` reloads all preferences including cliMode from the new project's scope in localStorage (`apps/web/src/state/preferences.store.ts:192-203`).

## Files

- `apps/web/src/views/settings/SettingsPanel.tsx` — UI control: CliModeCheck checkbox rendered above settings tabs.
- `apps/web/src/state/preferences.store.ts` — State & persistence: readCliMode reads from localStorage; setCliMode updates store and saves with project scoping.
- `apps/web/src/views/shell/AppShell.tsx` — Layout orchestration: reads cliMode and conditionally renders left rail (CliSessionListPanel vs SessionListPanel) and chat pane (CliConsolePane vs ChatPanel); routes "Create Session" command to provider picker or chat creation.
- `apps/web/src/views/cli/CliConsolePane.tsx` — Main CLI view: mounts xterm containers for live sessions, displays loading/empty states, shows changes rail, triggers ensureCliSessions on connect.
- `apps/web/src/views/cli/CliSessionListPanel.tsx` — Session list: renders provider groups, live sessions, and resumable history; supports renaming, selection, and resumption.
- `apps/web/src/services/cli-console.ts` — Core orchestration: manages CLI sessions store (Zustand), controls session lifecycle (create, spawn, resume, close), watches session topics, interfaces with bridge for terminal RPC.
- `apps/web/src/views/cli/CliProviderModal.tsx` — Provider picker: modal dialog for user to choose Codex or Claude when creating a new session.
- `apps/web/src/services/cli-baseline.ts` — Git baseline tracking: captures the working tree state when a session starts, used by the changes rail to show only what that session changed.
- `apps/web/src/services/terminal-registry.ts` — Xterm management: mounts and manages xterm instances by terminal id; keeps scrollback alive across unmounts.
- `apps/web/src/hooks/useGitChangesRailViewModel.ts` — Changes rail: observes git diff for a selected CLI session, displaying only the files that session touched.
- `apps/web/src/services/bridge-client.ts` — RPC client: sends terminal.list, terminal.create, and terminal.write calls to the agent.

## Contracts

**State: localStorage**
- Key: `scoped("atelier.cliMode")` or unscoped `"atelier.cliMode"` (fallback).
- Value: "1" (enabled) or "0" (disabled).
- Scoped per project via `projectId`, so each workspace can have different settings.

**Zustand store: usePreferencesStore**
- `cliMode: boolean` — Whether CLI mode is active.
- `setCliMode(value: boolean)` — Updates cliMode and persists to localStorage.
- `setProjectScope(projectId)` — Switches scope and reloads all preferences from localStorage.

**Zustand store: useCliConsoleStore**
- `sessions: CliSessionVm[]` — Live CLI ptys, sorted by ordinal.
- `selectedId: string | null` — Currently active session id.
- `bootstrapped: boolean` — True once ensureCliSessions completes.
- `titles: Record<string, CliTitle>` — Session names by term id.
- `history: CliHistoryEntry[]` — Provider-recorded sessions available to resume.
- `resumed: Record<string, string>` — Mapping of pty id to provider session id.
- `providerPickerOpen: boolean` — Whether the provider picker modal is open.

**RPC calls (to agent via bridge)**
- `terminal.list()` → `{ sessions: TerminalSession[] }` — List all ptys in this workspace.
- `terminal.create({ name: string })` → `{ session: TerminalSession }` — Create a new pty with the given name (encoding provider and ordinal).
- `terminal.write({ termId: string, data: string })` → void — Write command/input to a pty.
- `terminal.getHistory({ termId: string })` → `{ data: string }` — Fetch scrollback history for a terminal to restore on mount.

**localStorage (CLI metadata)**
- `"atelier.cli.titles"` — Session names by term id (Record<string, CliTitle>); capped at 100 entries.
- `"atelier.cli.resumed"` — Mapping of pty id → provider session id (Record<string, string>); used to track which provider session a resumed pty belongs to.

## Edge cases

**No sessions on first enable:**
If CLI mode is enabled and no sessions exist, ensureCliSessions just sets an empty sessions array. CliConsolePane then shows an empty state with a button to create a new CLI session (lines 134–151). The provider picker modal opens when the user clicks the button, so they choose Codex or Claude before the session is spawned. If ensureCliSessions fails or the agent is not yet connected, CliConsolePane displays a loading message or error state with a Retry button (lines 118–133).

**ensureCliSessions fails:**
If `terminal.list` or session creation RPC fails, the error is caught and displayed in CliConsolePane (lines 52–56, 118–133). User can click Retry to reset store and try again.

**Project switching:**
When user switches projects, `setProjectScope()` reloads cliMode from the new project's localStorage scope. If the setting is not found, it falls back to the unscoped key, preserving the install's previous choice on first open of a project.

**No live sessions:**
If a user quits all CLI sessions in bootstrapped mode (no sessions.length === 0), CliConsolePane shows an empty state with a "New CLI session" button rather than auto-respawning. This prevents respawn loops.

**Session name collisions:**
Ordinals are auto-assigned and gaps are closed to avoid collisions. If two sessions exist with ordinals 1 and 3, a new session gets ordinal 2.

**localStorage full or blocked:**
If localStorage is full or blocked (private mode, quota exceeded), writes fail silently. Names and session pairings still apply for the current window but do not persist.

**Session already named:**
If a resumed session has a title, it is set as pinned (not watched), so a subsequent prompt does not rename it. If unnamed, a topic watcher begins and the first thing asked becomes the session name.

## Related

- [[app-boot]] — Preferences store is initialized during app boot and project opening.

