/**
 * Conversation-alignment smoke. Keeps the regression independent of SQLite
 * so it can run even when the local native module was built for another Node.
 *
 *   pnpm --filter @atelier/agent smoke:context-alignment
 */
import assert from "node:assert/strict";
import { SharedSessionContextBuilder } from "../src/context/session/index.js";
import { ATELIER_EXECUTOR_CONTRACT } from "../src/providers/executor-contract.js";

const now = Date.now();
const messages = [
  {
    id: "m-eggs-user",
    conversationId: "conv-alignment",
    taskId: "task-eggs",
    role: "user" as const,
    text: "buy eggs at Harbor store",
    createdAt: now,
  },
  {
    id: "m-eggs-assistant",
    conversationId: "conv-alignment",
    taskId: "task-eggs",
    role: "assistant" as const,
    text: "Harbor store is the established location.",
    createdAt: now + 1,
  },
  {
    id: "m-sardines-user",
    conversationId: "conv-alignment",
    taskId: "task-sardines",
    role: "user" as const,
    text: "buy sardines",
    createdAt: now + 2,
  },
];

const builder = new SharedSessionContextBuilder({
  conversations: {
    getMessages: () => messages,
  } as never,
  summaries: {
    recent: () => [],
  } as never,
});

const aligned = builder.build({
  conversationId: "conv-alignment",
  currentTaskId: "task-sardines",
});

assert.match(ATELIER_EXECUTOR_CONTRACT, /CONVERSATION ALIGNMENT/);
assert.match(
  ATELIER_EXECUTOR_CONTRACT,
  /newest request is the only active instruction/
);
assert.match(ATELIER_EXECUTOR_CONTRACT, /prior turns resolve omitted context/);
assert.match(aligned.text, /ALIGNED ATELIER CONVERSATION CONTEXT/);
assert.match(aligned.text, /buy eggs at Harbor store/);
assert.match(aligned.text, /Harbor store is the established location/);
assert.match(aligned.text, /latest user message is the only active instruction/);
assert.match(aligned.text, /project\/location/);
assert.match(aligned.text, /Prior requests are context, not queued work/);
assert.doesNotMatch(
  aligned.text,
  /buy sardines/,
  "the live prompt must remain the active user message, not be duplicated as memory"
);

console.log("ok  prior location survives while the newest request remains active");
