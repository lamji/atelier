---
feature: app boot
slug: app-boot
status: ready
updated: 2026-08-08T15:29:13.915Z
aliases:
  - app initialization
  - boot sequence
  - startup
  - Electron launch
  - agent fork
  - workspace open
  - cold start
sources:
  - "apps/desktop/src/main/main.ts @ 1786202301676 @ b36706194ccc"
  - "apps/desktop/src/main/window.ts @ 1785367330680 @ 43375c05b9e7"
  - "apps/desktop/src/main/window-state.ts @ 1785331614630 @ e1cb4bb26b68"
  - "apps/desktop/src/main/project-manager.ts @ 1786200181991 @ dd847206c342"
  - "apps/desktop/src/main/ipc-app.ts @ 1786202301675 @ 009dae67e23d"
  - "apps/desktop/src/main/ipc.ts @ 1785408039198 @ e502fc0f734e"
  - "apps/desktop/src/main/menu.ts @ 1785331625596 @ 0a0f767ccb78"
  - "apps/desktop/src/preload/preload.ts @ 1786202301673 @ 4128c96e8dc2"
  - "apps/agent/src/utility-main.ts @ 1785408965167 @ 0e4af4673714"
  - "apps/agent/src/workspace-host.ts @ 1785408949388 @ e8959fd84539"
  - "apps/web/src/App.tsx @ 1786202843267 @ 72454bd1fa50"
  - "apps/web/src/services/event-dispatcher.ts @ 1786197841115 @ 00ddcf5a94da"
  - "apps/web/src/services/project-switch.ts @ 1786197847008 @ 46fa98c369ff"
  - "packages/protocol/src/native.ts @ 1785408915395 @ ff429098408e"
  - "apps/desktop/src/shared/ipc-contract.ts @ 1786202301674 @ c031a4449455"
  - "apps/agent/src/bridge/ipc-server.ts @ 1785340530538 @ 0c12beed232e"
  - "apps/web/src/services/desktop-port.ts @ 1785340751301 @ 76e3c6c6f96b"
  - "apps/web/src/services/bridge-client.ts @ 1785430180622 @ cbd3be047ed2"
  - "apps/web/src/state/projects.store.ts @ 1785364555822 @ 822a63cda9eb"
  - "apps/web/src/state/connection.store.ts @ 1784779976012 @ 4794244a0719"
  - "apps/desktop/src/main/boot-trace.ts @ 1786199986954 @ d05bdb2dcaaf"
  - "apps/desktop/src/main/resolve-url.ts @ 1785340150172 @ 14d487db90d2"
---

# app boot

When the user launches Atelier, the app boots through a multi-stage orchestration: the Electron main process creates a window, loads the web renderer, which then initializes its service layer and automatically resumes the most recently opened project. The desktop main process forks a single shared agent utility process to handle all workspaces, sends an init message, and waits for the agent to signal readiness. Once ready, when a workspace is opened, a fresh MessagePort is created and handed off to the renderer over IPC, establishing the two-way RPC channel between the renderer and the agent. The app is fully functional once the workspace screen renders and the port is live.

## Entry points

- `apps/desktop/src/main/main.ts:39` — `app.whenReady()` fires and begins the boot sequence
- `apps/agent/src/utility-main.ts:76` — Message handler on parentPort receives the `init` message from desktop main

## Flow

1. `apps/desktop/src/main/main.ts:18` — Register atelier:// protocol handler
2. `apps/desktop/src/main/main.ts:20` — Create ProjectManager instance with agent entry path
3. `apps/desktop/src/main/main.ts:24` — Request single-instance lock to prevent multiple app windows
4. `apps/desktop/src/main/main.ts:42` — Install application menu with standard accelerators and quit handler
5. `apps/desktop/src/main/ipc.ts:15` — Register IPC handlers for file dialogs, external links, and window controls
6. `apps/desktop/src/main/ipc-app.ts:44` — Register IPC handlers for projects: list, add, start, attach, remove
7. `apps/desktop/src/main/main.ts:49` — Fork agent host process early via prewarmHost()
8. `apps/desktop/src/main/main.ts:50` — Start session warm-up to enable workspace preloading
9. `apps/desktop/src/main/main.ts:51` — Call start() to create and display the main window
8. `apps/desktop/src/main/window-state.ts:23` — Load persisted window bounds from desktop-window.json
9. `apps/desktop/src/main/window-state.ts:34` — Validate cached bounds are still on-screen
10. `apps/desktop/src/main/window.ts:31` — Create BrowserWindow with sandbox, contextIsolation, and preload
11. `apps/desktop/src/main/window.ts:51` — Restore maximized state if window was previously maximized
12. `apps/desktop/src/main/window-state.ts:46` — Set up listeners to track and persist window state changes
13. `apps/desktop/src/main/window.ts:57` — Wait for ready-to-show event; fall back to show() after 4s
16. `apps/desktop/src/main/main.ts:87` — Clear Vite cache (dev mode only)
17. `apps/desktop/src/main/main.ts:91` — Load dev URL or packaged HTML file into renderer
16. `apps/desktop/src/preload/preload.ts:1` — Preload script runs in renderer context and exposes atelierDesktop API
17. `apps/web/src/App.tsx:43` — React App component mounts
18. `apps/web/src/App.tsx:48` — useEffect() on mount calls startEventDispatcher() and startProjectSync()
19. `apps/web/src/services/event-dispatcher.ts:293` — startEventDispatcher() subscribes to bridge status and all event topics
20. `apps/web/src/services/project-switch.ts:17` — startProjectSync() sets up listener for project list changes
21. `apps/web/src/services/project-switch.ts:24` — desktop.projects.list() IPC call fetches project registry
24. `apps/desktop/src/main/ipc-app.ts:77` — Main process IPC handler returns list of projects from registry
23. `apps/web/src/services/project-switch.ts:21` — Renderer updates projects store with initial list
24. `apps/web/src/App.tsx:67` — useLayoutEffect() checks if most recent project should be auto-resumed
25. `apps/web/src/services/project-switch.ts:45` — openWorkspace() begins workspace attachment
26. `apps/web/src/services/project-switch.ts:61` — attach() checks if this is a cold open (no active workspace yet)
27. `apps/web/src/services/project-switch.ts:81` — For cold open, call expectPort() and apply workspace state without waiting for port
28. `apps/desktop/src/main/ipc-app.ts:105` — projects.attach() IPC handler called
29. `apps/desktop/src/main/project-manager.ts:273` — ProjectManager.attach() calls start(id) then creates MessageChannel
30. `apps/desktop/src/main/project-manager.ts:214` — start(id) calls ensureHost() to fork agent if not running
31. `apps/desktop/src/main/project-manager.ts:103` — ensureHost() forks child process via utilityProcess.fork()
32. `apps/desktop/src/main/project-manager.ts:106` — Create log directory at atelierDataRoot()/logs
33. `apps/desktop/src/main/project-manager.ts:111` — Copy process.env and strip ELECTRON_RUN_AS_NODE
34. `apps/desktop/src/main/project-manager.ts:117` — Fork agent with serviceName "atelier-agent", stdio "pipe"
35. `apps/desktop/src/main/project-manager.ts:124` — Create write stream to agent.log
36. `apps/desktop/src/main/project-manager.ts:127` — Pipe child stdout to agent.log
37. `apps/desktop/src/main/project-manager.ts:130` — Register message handler for agent-to-desktop messages
38. `apps/desktop/src/main/project-manager.ts:135` — Set 30s boot timeout
39. `apps/desktop/src/main/project-manager.ts:151` — Create AgentInitMessage with logLevel from environment
40. `apps/desktop/src/main/project-manager.ts:155` — Send init message to agent process
41. `apps/agent/src/utility-main.ts:31` — Agent validates parentPort exists; exits if missing
42. `apps/agent/src/utility-main.ts:76` — Set up message handler on parentPort
43. `apps/agent/src/utility-main.ts:78` — Check if message type is "init"
44. `apps/agent/src/utility-main.ts:79` — Call boot(message)
45. `apps/agent/src/utility-main.ts:44` — Create pino logger with logLevel from init message
46. `apps/agent/src/utility-main.ts:46` — Create WorkspaceHost with onOpened and onStatus callbacks
47. `apps/agent/src/utility-main.ts:51` — Send "ready" message to desktop main
48. `apps/desktop/src/main/project-manager.ts:142` — Desktop receives "ready" message
49. `apps/desktop/src/main/project-manager.ts:143` — Clear boot timeout
50. `apps/desktop/src/main/project-manager.ts:144` — Resolve hostReady promise
51. `apps/desktop/src/main/project-manager.ts:223` — start(id) continues after ensureHost completes
52. `apps/desktop/src/main/project-manager.ts:258` — Send "open" message to agent: {type:"open", projectId, workspaceRoot, dataDir}
53. `apps/agent/src/utility-main.ts:89` — Agent receives "open" message
54. `apps/agent/src/utility-main.ts:90` — Call host.open(message) wrapped in guard()
55. `apps/agent/src/workspace-host.ts:49` — WorkspaceHost.open() creates the workspace and prepares it
56. `apps/agent/src/utility-main.ts:47` — WorkspaceHost calls onOpened callback when ready
57. `apps/desktop/src/main/project-manager.ts:160` — Desktop receives "opened" message
58. `apps/desktop/src/main/project-manager.ts:166` — Resolve workspace's pending open promise
59. `apps/desktop/src/main/project-manager.ts:279` — Create MessageChannelMain pair
60. `apps/desktop/src/main/project-manager.ts:280` — Send "attach" message to agent with port1
61. `apps/agent/src/utility-main.ts:83` — Agent receives "attach" message with port
62. `apps/agent/src/utility-main.ts:87` — Call host.attach(message, port) to wire the workspace to the port
63. `apps/agent/src/workspace-host.ts:76` — Store port end and begin serving RPC over the MessagePort
64. `apps/desktop/src/main/ipc-app.ts:109` — Desktop posts port2 to renderer via ipcRenderer.postMessage()
65. `apps/desktop/src/preload/preload.ts:15` — Preload receives port on ipcRenderer.on(atelier:workspace-port)
66. `apps/desktop/src/preload/preload.ts:16` — Preload re-posts port to main world via window.postMessage()
67. `apps/web/src/services/desktop-port.ts` — Renderer receives port in main world, pairs it with attachId
68. `apps/web/src/services/project-switch.ts:85` — attachProject() returns the resolved port
69. `apps/web/src/services/project-switch.ts:90` — bridge.setPort(port) connects renderer to agent over port
70. `apps/web/src/services/project-switch.ts:88` — applyWorkspace(id) resets workspace state, publishes root
71. `apps/web/src/services/project-switch.ts:91` — store.setActive(id) updates activeId in projects store
72. `apps/web/src/services/project-switch.ts:107` — store.setSwitching(false) marks switch complete
73. `apps/web/src/App.tsx:82` — If activeId is null, render opening or welcome screen
74. `apps/web/src/App.tsx:91` — Suspense boundary renders with WorkspaceSkeleton fallback
75. `apps/web/src/App.tsx:55` — useEffect() calls warmWorkspaceChunk() to prefetch the workspace chunk
76. `apps/web/src/App.tsx:92` — WorkspaceScreen renders; app is now fully functional

## Files

- `apps/desktop/src/main/main.ts` — Electron main entry point; orchestrates boot flow, calls app.whenReady(), installs menu, registers IPC, creates window
- `apps/desktop/src/main/window.ts` — Creates BrowserWindow with sandbox, preload, frame options, and shows on ready
- `apps/desktop/src/main/window-state.ts` — Loads/validates/persists window bounds and maximized state
- `apps/desktop/src/main/project-manager.ts` — Manages project registry, forks agent process, handles boot handshake and timeouts, creates MessageChannels
- `apps/desktop/src/main/ipc.ts` — Registers handlers for file dialogs, window controls, external links
- `apps/desktop/src/main/ipc-app.ts` — Registers handlers for project operations (list, add, start, attach, remove)
- `apps/desktop/src/main/boot-trace.ts` — Diagnostic timing marks for boot stages
- `apps/desktop/src/main/resolve-url.ts` — Resolves dev URL and packaged SPA entry point
- `apps/desktop/src/main/menu.ts` — Installs application menu with standard accelerators
- `apps/desktop/src/main/protocol.ts` — Registers atelier:// protocol handler and handles deep links
- `apps/desktop/src/preload/preload.ts` — Preload script that bridges IPC to main world and exposes atelierDesktop API
- `apps/desktop/src/shared/ipc-contract.ts` — Defines IPC channel names and types
- `apps/agent/src/utility-main.ts` — Agent entry point; validates parentPort, receives init message, creates WorkspaceHost, routes messages
- `apps/agent/src/workspace-host.ts` — Manages all open workspaces in the host, creates workspaces and attaches ports
- `apps/agent/src/bridge/ipc-server.ts` — Serves RPC over MessagePort
- `apps/web/src/App.tsx` — React root component; renders screen based on auth/project state, triggers startup services
- `apps/web/src/services/event-dispatcher.ts` — Subscribes to bridge status and event topics, dispatches to store
- `apps/web/src/services/project-switch.ts` — Syncs project list from desktop, handles workspace open/close/attach
- `apps/web/src/services/desktop-port.ts` — Receives MessagePort from preload, pairs with attachId, hands to bridge
- `apps/web/src/services/bridge-client.ts` — Establishes RPC connection over MessagePort
- `apps/web/src/state/projects.store.ts` — Stores project list, active project, switching state
- `apps/web/src/state/auth.store.ts` — Stores auth state (configured, user)
- `apps/web/src/state/connection.store.ts` — Stores connection state (connecting, connected, etc.)
- `packages/protocol/src/native.ts` — Defines message contracts: AgentInitMessage, AgentControlMessage, AgentParentMessage, PortClientFrame, PortServerFrame

## Contracts

### AgentInitMessage
```
{ type: "init"; logLevel?: string }
```
Sent from desktop main to agent on process fork. Signals the agent to boot.

### AgentParentMessage
```
{ type: "ready" }
{ type: "opened"; projectId: string }
{ type: "status"; projectId: string; working: boolean }
{ type: "fatal"; projectId?: string; message: string }
```
Messages from agent to desktop main. "ready" completes the agent boot handshake.

### AgentControlMessage
```
{ type: "attach" | "open"; projectId: string; workspaceRoot: string; dataDir: string }
{ type: "close"; projectId: string }
{ type: "shutdown" }
```
Messages from desktop main to agent for workspace lifecycle.

### WindowState (persisted at `~/.local/share/atelier/desktop-window.json`)
```
{ bounds?: { x, y, width, height }; maximized?: boolean }
```
Restores window position and maximized state across sessions.

### Project Registry (persisted at `~/.local/share/atelier/projects.json`)
Project list with path, name, id, dataDir, lastOpenedAt.

## Edge cases

- **Agent boot timeout (30s):** If agent does not send "ready" within 30s, the desktop main kills the child and rejects the boot promise. The next workspace open will retry the fork.
- **Agent fork failure:** utilityProcess.fork() can fail if the agent bundle is missing or corrupted. Desktop main receives an exit event and marks all open workspaces as "error".
- **Corrupted window state:** If desktop-window.json contains invalid JSON or out-of-range bounds, loadWindowState() catches the error and returns empty state, allowing the window to open with defaults.
- **Port forwarding race:** If the renderer reloads before the port lands, the attachId will not match and the port is dropped. The workspace will remain disconnected until a fresh attach.
- **Dev cache stale modules:** In dev mode, Vite HTTP cache can serve old modules across hot reloads. The renderer explicitly clears the cache on window load to prevent 404s for removed dependencies.
- **Preload failure:** If the preload script fails to load, contextIsolation prevents atelierDesktop from being exposed and the app cannot make IPC calls. The window shows but the app is non-functional; requires app restart.
- **Missing agent entry path:** If resolveAgentEntry() returns a path that does not exist, utilityProcess.fork() fails with ENOENT. Desktop main must be packaged correctly for this not to happen.
- **MessagePort already transferred:** A MessagePort can only be transferred once. If attach() is called twice for the same port, the second transfer will silently fail and the port will not reach the renderer.
- **Workspace open timeout (30s):** If a workspace does not send "opened" within 30s, the pending open is rejected and the workspace state is marked "error". This can happen if the agent fails during workspace initialization.
