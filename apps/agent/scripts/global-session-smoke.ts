import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newId } from "@atelier/shared";
import { openDb } from "../src/storage/db.js";
import { ConversationRepo } from "../src/storage/repositories/conversations.js";
import {
  GlobalSessionStore,
  isGlobalSessionCommand,
  parseGeneratedGlobalAlias,
} from "../src/context/global-session/index.js";
import { listSlashCommands } from "../src/orchestrator/command-catalog.js";
import { Retriever } from "../src/rag/retriever.js";

const dataDir = mkdtempSync(path.join(tmpdir(), "atelier-global-session-"));
const db = openDb(dataDir);

try {
  assert.equal(isGlobalSessionCommand("/global-session"), true);
  assert.equal(isGlobalSessionCommand("/global-session manual-name"), false);
  assert.equal(
    parseGeneratedGlobalAlias('{"alias":"Supabase Login Flow"}'),
    "supabase-login-flow"
  );
  assert.equal(
    listSlashCommands(dataDir).filter((command) => command.name === "global-session")
      .length,
    1
  );
  const conversations = new ConversationRepo(db);
  const firstId = newId("conv");
  conversations.create({
    id: firstId,
    title: "Authentication flow",
    sdkSessionId: null,
    createdAt: 1,
    updatedAt: 1,
  });
  addTurn(conversations, firstId, "Design alphaflowneedle login", "Use PKCE.");

  const store = new GlobalSessionStore(db, conversations);
  const initialAliasContext = store.aliasContext(firstId);
  assert.equal(initialAliasContext.existingAlias, undefined);
  assert.match(initialAliasContext.transcript, /alphaflowneedle/);
  const created = await store.promote(firstId, "auth-flow");
  assert.equal(store.aliasContext(firstId).existingAlias, "auth-flow");
  const originalChunks = chunkIds(created.id);
  assert.equal(created.updated, false);
  assert.equal(count("global_sessions"), 1);
  assert.ok(originalChunks.length >= 2);

  addTurn(conversations, firstId, "Add logout", "Revoke the refresh token.");
  const updated = await store.promote(firstId, "auth-flow");
  assert.equal(updated.id, created.id);
  assert.equal(updated.updated, true);
  assert.equal(count("global_sessions"), 1);
  assert.notDeepEqual(chunkIds(created.id), originalChunks);

  const secondId = newId("conv");
  conversations.create({
    id: secondId,
    title: "Authentication continuation",
    sdkSessionId: null,
    createdAt: 2,
    updatedAt: 2,
  });
  addTurn(conversations, secondId, "Continue alphaflowneedle", "Rotate keys.");
  const continued = await store.promote(secondId, "auth-flow");
  assert.equal(continued.id, created.id);
  assert.equal(count("global_sessions"), 1);
  assert.equal(count("global_session_sources"), 2);
  assert.equal(store.aliasContext(firstId).existingAlias, "auth-flow");
  assert.equal(store.aliasContext(secondId).existingAlias, "auth-flow");

  const retriever = new Retriever(
    db,
    { available: false } as never,
    { search: () => [] } as never,
    { search: () => [] } as never,
    {
      forSymbolNames: () => [],
      markUsed: () => undefined,
    } as never
  );
  const hidden = await retriever.retrieve("alphaflowneedle", 12, {
    conversationId: newId("conv"),
    includeGlobalSessions: false,
  });
  assert.equal(
    hidden.chunks.some((chunk) => chunk.kind === "global-session-memory"),
    false
  );
  const visible = await retriever.retrieve("alphaflowneedle", 12, {
    conversationId: newId("conv"),
    includeGlobalSessions: true,
  });
  assert.ok(
    visible.chunks.some(
      (chunk) =>
        chunk.kind === "global-session-memory" &&
        chunk.path === "global-session:auth-flow"
    )
  );

  console.log("global-session smoke passed");

  function count(table: string): number {
    return (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  }

  function chunkIds(globalId: string): number[] {
    return (
      db
        .prepare(
          "SELECT chunk_id FROM global_session_chunks " +
            "WHERE global_session_id = ? ORDER BY ord"
        )
        .all(globalId) as Array<{ chunk_id: number }>
    ).map((row) => row.chunk_id);
  }
} finally {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
}

function addTurn(
  conversations: ConversationRepo,
  conversationId: string,
  user: string,
  assistant: string
): void {
  const taskId = newId("task");
  conversations.addMessage({
    id: newId("msg"),
    conversationId,
    taskId,
    role: "user",
    text: user,
    createdAt: Date.now(),
  });
  conversations.addMessage({
    id: newId("msg"),
    conversationId,
    taskId,
    role: "assistant",
    text: assistant,
    createdAt: Date.now() + 1,
  });
}
