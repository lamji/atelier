import { createHash } from "node:crypto";
import type { ChatMessage } from "@atelier/protocol";
import type { Embedder } from "../../knowledge/embeddings/embedder.js";
import type { VectorStore } from "../../knowledge/embeddings/vector-store.js";
import type { Db } from "../../storage/db.js";
import type { ConversationRepo } from "../../storage/repositories/conversations.js";

export interface GlobalSessionResult {
  id: string;
  alias: string;
  chunks: number;
  updated: boolean;
}

export interface GlobalSessionAliasContext {
  title: string;
  transcript: string;
  existingAlias?: string;
  knownAliases: string[];
}

interface GlobalRow {
  id: string;
  alias: string;
  alias_norm: string;
  source_conversation_id: string;
  created_at: number;
}

/** Durable, explicitly promoted conversation snapshots for cross-session RAG. */
export class GlobalSessionStore {
  constructor(
    private db: Db,
    private conversations: ConversationRepo,
    private embedder?: Embedder,
    private vectors?: VectorStore,
    private onWrite?: () => void
  ) {}

  aliasContext(conversationId: string): GlobalSessionAliasContext {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`Unknown conversation: ${conversationId}`);
    const existing = this.db
      .prepare(
        "SELECT gs.alias FROM global_session_sources gss " +
          "JOIN global_sessions gs ON gs.id = gss.global_session_id " +
          "WHERE gss.conversation_id = ? LIMIT 1"
      )
      .get(conversationId) as { alias: string } | undefined;
    const known = this.db
      .prepare("SELECT alias FROM global_sessions ORDER BY updated_at DESC LIMIT 60")
      .all() as Array<{ alias: string }>;
    const transcript = sessionMessages(this.conversations, conversationId)
      .slice(-20)
      .map((message) => `${message.role.toUpperCase()}: ${clipDetail(message.text.trim(), 1600)}`)
      .join("\n\n");
    if (!transcript) throw new Error("This session has no conversation to promote yet.");
    return {
      title: conversation.title,
      transcript,
      existingAlias: existing?.alias,
      knownAliases: known.map((row) => row.alias),
    };
  }

  async promote(
    conversationId: string,
    requestedAlias?: string
  ): Promise<GlobalSessionResult> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error(`Unknown conversation: ${conversationId}`);

    const alias = cleanAlias(requestedAlias || conversation.title);
    const aliasNorm = normalizeAlias(alias);
    const bySource = this.db
      .prepare(
        "SELECT gs.* FROM global_session_sources gss " +
          "JOIN global_sessions gs ON gs.id = gss.global_session_id " +
          "WHERE gss.conversation_id = ? LIMIT 1"
      )
      .get(conversationId) as GlobalRow | undefined;
    const byAlias = this.db
      .prepare("SELECT * FROM global_sessions WHERE alias_norm = ?")
      .get(aliasNorm) as GlobalRow | undefined;
    const existing = bySource ?? byAlias;
    if (bySource && byAlias && bySource.id !== byAlias.id) {
      throw new Error(
        `The alias "${alias}" belongs to another global session. Choose a different alias.`
      );
    }

    const id = existing?.id ?? stableId(conversationId);
    const now = Date.now();
    const messages = sessionMessages(this.conversations, conversationId);
    if (messages.length === 0) {
      throw new Error("This session has no conversation to promote yet.");
    }

    const texts = buildChunks({
      id,
      alias,
      title: conversation.title,
      sourceConversationId: conversationId,
      messages,
    });
    const oldChunkIds = this.db.transaction(() => {
      const old = this.db
        .prepare(
          "SELECT chunk_id FROM global_session_chunks WHERE global_session_id = ?"
        )
        .all(id) as Array<{ chunk_id: number }>;
      this.db
        .prepare(
          "INSERT INTO global_sessions(" +
            "id, alias, alias_norm, source_conversation_id, title, created_at, updated_at" +
            ") VALUES(?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET alias = excluded.alias, " +
            "alias_norm = excluded.alias_norm, " +
            "source_conversation_id = excluded.source_conversation_id, " +
            "title = excluded.title, updated_at = excluded.updated_at"
        )
        .run(
          id,
          alias,
          aliasNorm,
          conversationId,
          conversation.title,
          existing?.created_at ?? now,
          now
        );
      this.db
        .prepare(
          "INSERT INTO global_session_sources(conversation_id, global_session_id, linked_at) " +
            "VALUES(?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET " +
            "global_session_id = excluded.global_session_id, linked_at = excluded.linked_at"
        )
        .run(conversationId, id, now);
      this.db
        .prepare("DELETE FROM global_session_chunks WHERE global_session_id = ?")
        .run(id);
      const removeChunk = this.db.prepare("DELETE FROM chunks WHERE id = ?");
      for (const row of old) removeChunk.run(row.chunk_id);

      const insertChunk = this.db.prepare(
        "INSERT INTO chunks(" +
          "file_id, symbol_id, kind, content_hash, text, token_count, start_row, end_row" +
          ") VALUES(NULL, NULL, 'global-session-memory', ?, ?, ?, NULL, NULL)"
      );
      const link = this.db.prepare(
        "INSERT INTO global_session_chunks(" +
          "global_session_id, ord, chunk_id, updated_at) VALUES(?, ?, ?, ?)"
      );
      texts.forEach((text, ord) => {
        const hash = createHash("sha256").update(text).digest("hex");
        const result = insertChunk.run(hash, text, Math.ceil(text.length / 4));
        link.run(id, ord, Number(result.lastInsertRowid), now);
      });
      return old.map((row) => row.chunk_id);
    })();

    this.vectors?.forget(oldChunkIds);
    await this.embed(id);
    this.onWrite?.();
    return { id, alias, chunks: texts.length, updated: Boolean(existing) };
  }

  private async embed(globalSessionId: string): Promise<void> {
    if (!this.embedder?.available || !this.vectors) return;
    const rows = this.db
      .prepare(
        "SELECT c.id, c.text FROM global_session_chunks gsc " +
          "JOIN chunks c ON c.id = gsc.chunk_id " +
          "WHERE gsc.global_session_id = ? ORDER BY gsc.ord"
      )
      .all(globalSessionId) as Array<{ id: number; text: string }>;
    const embeddings = await this.embedder.embed(rows.map((row) => row.text));
    rows.forEach((row, index) => {
      const vector = embeddings[index];
      if (vector) this.vectors!.upsert(row.id, vector);
    });
  }
}

const MAX_DETAIL_CHARS = 7000;

function buildChunks(input: {
  id: string;
  alias: string;
  title: string;
  sourceConversationId: string;
  messages: ChatMessage[];
}): string[] {
  const header =
    `Global session: ${input.alias}\n` +
    `Global ID: ${input.id}\n` +
    `Source conversation: ${input.sourceConversationId}\n` +
    `Title: ${input.title}`;
  const exchanges: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  for (const message of input.messages) {
    if (message.role === "user" && current.length > 0) {
      exchanges.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) exchanges.push(current);
  const details = exchanges.map((exchange, exchangeIndex) => {
    const body = exchange
      .map(
        (message) =>
          `${message.role.toUpperCase()}\n${message.text.trim()}`
      )
      .join("\n\n");
    return clipDetail(
      `${header}\n\nExchange ${exchangeIndex + 1}\n${body}`,
      MAX_DETAIL_CHARS
    );
  });
  const overview =
    `${header}\n\nDetailed transcript: ${input.messages.length} messages in ` +
    `${details.length} retrievable part(s). Re-promoting this session updates ` +
    `the same global ID instead of adding another memory.`;
  return [overview, ...details];
}

function clipDetail(value: string, max: number): string {
  if (value.length <= max) return value;
  const half = Math.floor((max - 48) / 2);
  return `${value.slice(0, half)}\n\n[...middle clipped...]\n\n${value.slice(-half)}`;
}

function cleanAlias(value: string): string {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 80);
  return cleaned || "Untitled global session";
}

function normalizeAlias(value: string): string {
  const normalized = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function stableId(conversationId: string): string {
  return `global_${createHash("sha1").update(conversationId).digest("hex").slice(0, 16)}`;
}

function sessionMessages(
  conversations: ConversationRepo,
  conversationId: string
): ChatMessage[] {
  return conversations.getMessages(conversationId).filter(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      !isPromotionPrompt(message.text)
  );
}

function isPromotionPrompt(text: string): boolean {
  return /^\/global-session\s*$/i.test(text.trim());
}
