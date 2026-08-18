---
feature: main chat panel
slug: main-chat-panel
status: stale
updated: 2026-08-08T14:38:23.509Z
aliases:
  - chat transcript
  - composer
  - process rail
  - activity feed
  - live plan
sources:
  - "apps/web/src/views/chat/ChatPanel.tsx @ 1786197465868 @ c0dd467bf85c"
  - "apps/web/src/views/chat/Composer.tsx @ 1786195819078 @ 3952b468de09"
  - "apps/web/src/hooks/useChatViewModel.ts @ 1786197000263 @ 2f3b4fb9a41e"
  - "apps/web/src/hooks/useComposerViewModel.ts @ 1786195812632 @ c0b6a9bfbfd7"
  - "apps/web/src/state/sessions.store.ts @ 1786085794155 @ de627dfe16c2"
  - "apps/web/src/services/event-dispatcher.ts @ 1786197841115 @ 00ddcf5a94da"
  - "apps/web/src/services/bridge-client.ts @ 1785430180622 @ cbd3be047ed2"
  - "apps/web/src/types/index.ts @ 1785340893192 @ 7d853fee9412"
  - "packages/protocol/src/models/conversation.ts @ 1786085603078 @ 3c7b18d51605"
  - "apps/web/src/views/chat/NoProviderModal.tsx @ 1785399268549 @ d673409b22bf"
  - "apps/web/src/lib/mention-tree.ts @ 1785064080314 @ e433b5904066"
  - "apps/web/src/hooks/useMentionBrowser.ts @ 1785064504590 @ 4d4cac95f604"
  - "apps/web/src/views/shell/AppShell.tsx @ 1786199865618 @ 1bd443680fe1"
  - "apps/web/src/state/preferences.store.ts @ 1786196928517 @ da3c3454cf81"
  - "apps/web/src/state/connection.store.ts @ 1784779976012 @ 4794244a0719"
  - "apps/web/src/state/markdown.store.ts @ 1785266010822 @ 301850f8e478"
  - "apps/web/src/lib/cn.ts @ 1784779927692 @ edf351d874d6"
  - "apps/web/src/hooks/useChangesRailViewModel.ts @ 1786196146273 @ 5cbee93fb372"
  - "apps/web/src/views/chat/ProcessCard.tsx @ 1786195498216 @ 75ebf6522ace"
  - "apps/web/src/views/chat/ChangesRail.tsx @ 1786197472059 @ 8c7919c282e0"
  - "apps/web/src/views/chat/UnifiedDiffView.tsx @ 1786196935142 @ 0cef85ca7a5f"
---

# main chat panel

The main chat panel is the central conversation interface where users send prompts to the agent and receive streamed responses. It displays the full transcript of user messages and assistant replies, renders thinking text and agent actions in real time while tasks run, and shows a live activity feed (process rail) on the right with the plan checklist, tool calls, and file diffs as they happen. Users compose messages at the bottom with model/effort selection, attach files and images, and can use slash commands and file mentions for richer context.

## Entry points

- `apps/web/src/views/shell/AppShell.tsx:227` — ChatPanel rendered as a memoized component with shellError prop
- `apps/web/src/views/chat/Composer.tsx:163` — send() wrapper validates providers and calls view model
- `apps/web/src/views/chat/Composer.tsx:168` — Composer.send() invokes vm.send() when user clicks send button
- `apps/web/src/hooks/useComposerViewModel.ts:283` — send() function processes user input and submits task to agent

## Flow

1. `apps/web/src/views/shell/AppShell.tsx:227` — AppShell renders ChatPanel as a memoized component with shellError prop
2. `apps/web/src/views/chat/ChatPanel.tsx:55` — ChatPanel memo wrapper mounts and calls useChatViewModel()
3. `apps/web/src/hooks/useChatViewModel.ts:41` — useChatViewModel reads current session's items, thinking, plan, actions, stage via narrow Zustand selectors
4. `apps/web/src/hooks/useChangesRailViewModel.ts` — useChangesRailViewModel computes file changes view model (active file, width, resize state) from items and liveDiffs
5. `apps/web/src/views/chat/ChatPanel.tsx:49` — useStickToBottom hook follows transcript and process card as new messages arrive
6. `apps/web/src/views/chat/ChatPanel.tsx:116` — Renders transcript from vm.items, skipping diff items and streaming assistant messages while run is live; maps non-diff items to ChatMessage component
7. `apps/web/src/views/chat/ChatPanel.tsx:122` — ProcessCard rendered inline in transcript when vm.busy or hasPlan is true; shows plan checklist and last 6 actions
8. `apps/web/src/views/chat/ChatPanel.tsx:133` — ThinkingBlock appears when agent is thinking, shows thinking text or current pipeline stage; only assistant messages while run is live are hidden
9. `apps/web/src/views/chat/ChatPanel.tsx:171` — ChangesRail rendered on right side when vm.busy or changes exist; receives status prop (computed at line 66-68 from vm.actions, vm.stage, vm.cancelling) to display current pipeline step in EmptyState while awaiting first edit; shows tabbed view of file diffs
10. `apps/web/src/views/chat/ChatPanel.tsx:164` — Composer component rendered at bottom for user input
11. `apps/web/src/views/chat/Composer.tsx:1` — Composer mounts, calls useComposerViewModel()
12. `apps/web/src/hooks/useComposerViewModel.ts:166` — useComposerViewModel reads connected, busy, model roster, slash commands, prompt files
13. `apps/web/src/views/chat/Composer.tsx:554` — User types and clicks send button, invokes send() wrapper
14. `apps/web/src/views/chat/Composer.tsx:163` — send() checks vm.noProvidersEnabled; shows modal if all providers disabled
15. `apps/web/src/views/chat/Composer.tsx:168` — Calls vm.send() from useComposerViewModel
16. `apps/web/src/hooks/useComposerViewModel.ts:286` — send() validates text, images, promptFile; returns early if empty
17. `apps/web/src/hooks/useComposerViewModel.ts:287` — Gets selectedId and session from sessions.store; returns if none selected
18. `apps/web/src/hooks/useComposerViewModel.ts:306` — If promptFile set, reads file via bridge.rpc('fs.readFile', {path})
19. `apps/web/src/hooks/useComposerViewModel.ts:319` — Composes full prompt text, combining user input, prompt file, and attachments
20. `apps/web/src/hooks/useComposerViewModel.ts:334` — Optimistically adds user message to transcript via store.addUserMessage(id, text, images)
21. `apps/web/src/state/sessions.store.ts:276` — addUserMessage() creates ChatItemVm with role='user' and appends to items array
22. `apps/web/src/hooks/useComposerViewModel.ts:343` — Calls bridge.rpc('task.start', {conversationId, prompt, model, effort, planMode, systemKnowledge, vibe, autoReview, images, promptFile})
23. `apps/web/src/services/bridge-client.ts:144` — rpc() creates QueuedCall with method, params, resolve, reject callbacks
24. `apps/web/src/services/bridge-client.ts:157` — If port exists, calls send() immediately; otherwise queues with CONNECT_GRACE_MS timeout
25. `apps/web/src/services/bridge-client.ts:178` — send() assigns RPC id, registers pending promise in Map, sends PortClientFrame over MessagePort
26. `[agent-side]` — Agent receives task.start RPC call, starts pipeline (planning, tool loop, LLM turns), emits events over port
27. `apps/web/src/services/bridge-client.ts:218` — onFrame() receives PortServerFrame from agent
28. `apps/web/src/services/bridge-client.ts:221` — If kind='result', resolves the task.start RPC promise with {taskId, queued}
29. `apps/web/src/hooks/useComposerViewModel.ts:366` — RPC .then() receives taskId and queued flag
30. `apps/web/src/hooks/useComposerViewModel.ts:370` — If queued=true, calls store.taskQueued(id, taskId) and returns
31. `apps/web/src/hooks/useComposerViewModel.ts:380` — If queued=false, calls store.taskStarted(id, taskId, title) to start live feed
32. `apps/web/src/state/sessions.store.ts:136` — taskStarted() sets activeTaskId, status='working', taskStartedAt timestamp, clears queuedTaskIds of the sent task
33. `apps/web/src/services/bridge-client.ts:237` — onFrame() receives kind='event' frames for chat.message.delta, agent.thinking.delta, tool.*, plan.*, task.* events
34. `apps/web/src/services/bridge-client.ts:250` — Creates EventFrame with topic, seq, ts, taskId, payload
35. `apps/web/src/services/bridge-client.ts:251` — Queues EventFrame to handlers whose topic pattern matches
36. `apps/web/src/services/bridge-client.ts:256` — Calls scheduleFlush() to coalesce events into one React render
37. `apps/web/src/services/bridge-client.ts:268` — scheduleFlush() uses requestAnimationFrame + setTimeout(100ms) to batch updates
38. `apps/web/src/services/bridge-client.ts:272` — flushEvents() delivers all queued EventFrames to their handlers
39. `apps/web/src/services/event-dispatcher.ts:304` — bridge.subscribe('*', dispatch) routes all events to dispatch function
40. `apps/web/src/services/event-dispatcher.ts:307` — dispatch() resolves conversationId from payload.conversationId or taskId->convId map
41. `apps/web/src/services/event-dispatcher.ts:319` — 'chat.message.delta' calls sessions.appendAssistantDelta(convId, messageId, delta)
42. `apps/web/src/state/sessions.store.ts:316` — appendAssistantDelta() finds or creates assistant message, appends delta to text
43. `apps/web/src/services/event-dispatcher.ts:328` — 'chat.message.completed' calls sessions.completeAssistantMessage(convId, messageId, text)
44. `apps/web/src/state/sessions.store.ts:373` — completeAssistantMessage() marks message not streaming, moves to end of items array
45. `apps/web/src/services/event-dispatcher.ts:337` — 'agent.thinking.delta' calls sessions.appendThinking(convId, delta)
46. `apps/web/src/services/event-dispatcher.ts:366` — 'pipeline.stage.started' calls sessions.setStage(convId, stage) for progress display
47. `apps/web/src/services/event-dispatcher.ts:370` — 'tool.started' calls sessions.actionStarted(convId, toolCallId, label) for activity feed
48. `apps/web/src/services/event-dispatcher.ts:379` — 'tool.completed' calls sessions.actionFinished(convId, toolCallId, 'done')
49. `apps/web/src/services/event-dispatcher.ts:384` — 'tool.failed' calls sessions.actionFinished(convId, toolCallId, 'failed', reason)
50. `apps/web/src/services/event-dispatcher.ts:44` — Replayed events from plan.created, plan.step.updated rebuild process card on resume
51. `apps/web/src/services/event-dispatcher.ts:404` — 'task.completed/cancelled/error' calls sessions.taskEnded(convId, outcome, error, taskId)
52. `apps/web/src/state/sessions.store.ts:150` — taskEnded() clears activeTaskId, status, actions, liveDiffs, plan; clears queue if task was cancelled
53. `apps/web/src/state/sessions.store.ts` — Store mutation triggers all Zustand subscribers to re-render
54. `apps/web/src/hooks/useChatViewModel.ts:48` — useChatViewModel selector fires with new items, thinking, actions, stage
55. `apps/web/src/views/chat/ChatPanel.tsx:42` — ChatPanel re-renders with updated vm, skips re-render of shell due to memoization
56. `apps/web/src/views/chat/ChatPanel.tsx:116` — Transcript re-renders AnimatePresence with updated vm.items
57. `apps/web/src/views/chat/ChatPanel.tsx:175` — ChatMessage renders each item: user message with avatar/text, or assistant message with markdown
58. `apps/web/src/views/chat/ProcessCard.tsx:30` — ProcessCard renders plan checklist with done/in-progress/failed step icons and last 6 actions
59. `apps/web/src/views/chat/ChangesRail.tsx:28` — ChangesRail renders file diffs in tabs on the right side; width is fixed chrome (never dragged)
60. `apps/web/src/views/chat/ChatPanel.tsx:158` — Composer remains at bottom, ready for next user input or follow-up

## Files

- `apps/web/src/views/chat/ChatPanel.tsx` — Main chat panel UI: renders transcript, process card inline, changes rail sidebar, and composer layout; manages scroll-to-bottom
- `apps/web/src/views/chat/Composer.tsx` — Message composer UI: text input, model/effort picker, slash command menu, "@" file mention browser, image/file attachments, send button
- `apps/web/src/views/chat/ProcessCard.tsx` — Process card UI shown inline in transcript: renders plan checklist and last 6 actions with status icons; diffs shown separately in rail
- `apps/web/src/views/chat/ChangesRail.tsx` — Changes rail UI shown on right side: renders tabbed view of file diffs; one tab per changed file; EmptyState displays current pipeline step (via status prop) when no edits yet
- `apps/web/src/views/chat/UnifiedDiffView.tsx` — Unified diff view: renders before/after content with line numbers and change markers; mounts inside DiffPane
- `apps/web/src/hooks/useChatViewModel.ts` — ViewModel for chat transcript: reads items, thinking, plan, actions, stage, and busyness state via narrow selectors
- `apps/web/src/hooks/useChangesRailViewModel.ts` — ViewModel for changes rail: reads file changes view model (active file, width, resize state) from items and liveDiffs
- `apps/web/src/hooks/useComposerViewModel.ts` — ViewModel for composer: manages draft text, attachments, images, preferences, and send() logic; validates input and calls task.start RPC
- `apps/web/src/state/sessions.store.ts` — Zustand store for all session/chat state: items array, thinking text, plan, actions, diffs, task status, error messages; provides mutations for incoming events
- `apps/web/src/services/bridge-client.ts` — RPC client over MessagePort to agent: sends task.start and receives chat.message.delta/completed, agent.thinking.delta, tool.*, plan.*, task.* events; queues and coalesces events
- `apps/web/src/services/event-dispatcher.ts` — Routes all events from bridge to sessions.store: routes chat.message.*, agent.thinking.*, tool.*, plan.*, task.* events to appropriate store mutations
- `apps/web/src/types/index.ts` — UI type definitions: ChatItemVm (transcript item), ChatRole, ConnectionState
- `packages/protocol/src/models/conversation.ts` — Protocol types: Conversation, ChatMessage, ChatRole, TaskStatus, TaskInfo
- `apps/web/src/views/chat/NoProviderModal.tsx` — Modal shown when no LLM providers are enabled
- `apps/web/src/lib/mention-tree.ts` — Utilities for "@" mention browser: splitMentionPath, rankMentionEntries, searchMentionFiles
- `apps/web/src/hooks/useMentionBrowser.ts` — ViewModel for "@" mention browser: loads folders and files for mention completion
- `apps/web/src/state/preferences.store.ts` — Stores per-session model/effort/planMode/systemKnowledge/promptFile choices
- `apps/web/src/state/markdown.store.ts` — Loads and caches markdown prompt files for the promptFile picker
- `apps/web/src/state/connection.store.ts` — Tracks bridge connection state (disconnected/connecting/connected)
- `apps/web/src/views/shell/AppShell.tsx` — Shell layout that mounts ChatPanel in the main console area

## Contracts

**Requests (task.start RPC)**
```typescript
{
  conversationId: string;
  prompt: string;                    // Full user prompt + attachments
  model?: string;                    // e.g. "claude-opus-5"; absent = default
  effort?: string;                   // e.g. "high"; absent = default
  planMode?: boolean;                // Force plan-first mode
  systemKnowledge?: false;           // Omitted or true = use full pipeline; false = Claude-only
  vibe?: boolean;                    // Vibe coding mode
  autoReview?: false;                // Omitted or true = review stage active; false = skip review
  images?: Array<{mediaType, data}>;// Base64-encoded images
  promptFile?: string;               // Path to prompt file, for agent's records
}
```

**Response (task.start RPC)**
```typescript
{
  taskId: string;                    // Unique task identifier
  queued: boolean;                   // true if behind another running task; false if starts immediately
}
```

**Events (streamed over MessagePort)**
- `chat.message.delta: {messageId, delta}` — One token of assistant message
- `chat.message.completed: {messageId, text}` — Full assistant message ready
- `agent.thinking.delta: {delta}` — One token of thinking
- `task.started: {taskId, conversationId}` — Task begun (for queued tasks)
- `pipeline.stage.started: {stage}` — Pipeline stage changed (plan, retrieve, write, review, etc.)
- `tool.started: {toolCallId, name, input}` — Tool invocation started
- `tool.completed: {toolCallId}` — Tool succeeded
- `tool.failed: {toolCallId, name, error}` — Tool failed with reason
- `plan.created: {plan}` — Plan checklist created
- `plan.step.updated: {stepId, status}` — Plan step status changed
- `task.completed | task.cancelled | task.error: {taskId, conversationId, error?}` — Task ended
- `chat.message.delta`, `chat.message.completed`, `agent.thinking.delta` are not rendered as timeline cards (see NON_TIMELINE_TOPICS)

**State (SessionVm)**
```typescript
{
  conversation: Conversation;        // Title, id, created/updated timestamps
  items: ChatItemVm[];               // Transcript: user, assistant, log, diff messages
  thinking: string;                  // Current thinking text being streamed
  activeTaskId: string | null;       // Task id of running task, null if idle
  status: "idle" | "working" | "error";
  lastError: string | null;          // Error message from last failed task
  actions: AgentAction[];            // Live action feed (last 6 + diffs)
  liveDiffs: LiveDiff[];             // File diffs from current task
  plan: Plan | null;                 // Current plan with steps
  stage: PipelineStage | null;       // Current pipeline stage
  taskStartedAt: number | null;      // Epoch ms when current task started
  cancelling: boolean;               // Cancel was sent; task still running
  queuedTaskIds: string[];           // Follow-ups waiting to run
  hydrated: boolean;                 // Messages loaded from agent at least once
}
```

## Edge cases

**Validation**
- Empty input (no text, images, or prompt file) is rejected before send (line 292)
- Prompt file is read at send time, not cached; edit between pick and send is honored, but errors keep draft intact (line 312-316)
- Images are capped at 5 MB each; rejected images show reason (useComposerViewModel.ts:59-70)
- All providers disabled shows modal instead of sending (Composer.tsx:164-167)

**Error handling**
- RPC to task.start fails: taskEnded(id, "error", errText) stores failure, ChatPanel renders lastError (useComposerViewModel.ts:392-393)
- RPC to fs.readFile fails for prompt file: setError message, draft stays intact, user can re-pick (useComposerViewModel.ts:312-316)
- No session selected: send() returns early (useComposerViewModel.ts:299)
- Bridge disconnected: queued RPC calls wait CONNECT_GRACE_MS (45s), then reject with "bridge not connected" (bridge-client.ts:169-172)
- Agent dies while task running: port closes, no end event sent; shell handles via ConnectionGate reconnect
- Task queued behind running task: taskQueued() adds to queuedTaskIds; live feed not shown until task.started (useComposerViewModel.ts:372-374)

**Known gaps**
- No retry on transient RPC failures (tool failures are retried by agent, not UI)
- Wide diff content (>720px) not visible on narrow screens; user must drag rail wider
- Transcript does not persist locally; reload fetches from agent (hydrate on mount)
- Mention browser does not handle symlinks or very large folder trees efficiently

## Related

None of the pre-documented features touch the main chat panel flow.

