import type { ChatMessage, Conversation, TaskInfo, TaskStatus } from "@atelier/protocol";
import type { Db } from "../db.js";

export class ConversationRepo {
  constructor(private db: Db) {}

  create(conv: Conversation): Conversation {
    this.db
      .prepare(
        "INSERT INTO conversations(id, title, sdk_session_id, created_at, updated_at) " +
          "VALUES(?, ?, ?, ?, ?)"
      )
      .run(conv.id, conv.title, conv.sdkSessionId, conv.createdAt, conv.updatedAt);
    return conv;
  }

  list(): Conversation[] {
    const rows = this.db
      .prepare("SELECT * FROM conversations ORDER BY updated_at DESC")
      .all() as ConversationRow[];
    return rows.map(rowToConversation);
  }

  get(id: string): Conversation | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(id) as ConversationRow | undefined;
    return row ? rowToConversation(row) : undefined;
  }

  setTitle(id: string, title: string): void {
    this.db
      .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, Date.now(), id);
  }

  /**
   * Delete a conversation and everything hanging off it.
   *
   * Order matters: foreign_keys is ON and the child tables declare plain
   * REFERENCES with no ON DELETE CASCADE, so the parent row can only go
   * once its children are gone. The context tables carry no FK but are
   * keyed by conversation, and leaving their rows behind would let a
   * deleted chat keep suppressing chunks (dedup) in a later one.
   */
  remove(id: string): boolean {
    const drop = this.db.transaction((convId: string) => {
      const taskIds = (
        this.db
          .prepare("SELECT id FROM tasks WHERE conversation_id = ?")
          .all(convId) as Array<{ id: string }>
      ).map((r) => r.id);
      const dropTimeline = this.db.prepare(
        "DELETE FROM timeline WHERE task_id = ?"
      );
      for (const taskId of taskIds) dropTimeline.run(taskId);
      this.db
        .prepare("DELETE FROM chat_messages WHERE conversation_id = ?")
        .run(convId);
      this.db.prepare("DELETE FROM tasks WHERE conversation_id = ?").run(convId);
      this.db
        .prepare("DELETE FROM context_requests WHERE conversation_id = ?")
        .run(convId);
      this.db
        .prepare("DELETE FROM context_sent_chunks WHERE conversation_id = ?")
        .run(convId);
      this.db
        .prepare(
          "DELETE FROM conversation_working_memory WHERE conversation_id = ?"
        )
        .run(convId);
      return this.db
        .prepare("DELETE FROM conversations WHERE id = ?")
        .run(convId).changes;
    });
    return drop(id) > 0;
  }

  // Deliberately NO setSdkSessionId. A conversation must never remember a
  // provider-side session: every prompt opens a fresh one, and continuity
  // is carried by Atelier's own context (RAG chunks, session memory, the
  // recent exchange) which every provider receives identically. Persisting
  // a provider session id here would resume a growing transcript instead —
  // the context-window problem this design exists to avoid, and a model
  // switch mid-conversation would have nothing to resume anyway. The
  // sdk_session_id column is legacy and stays NULL; see
  // scripts/session-isolation-smoke.ts.

  touch(id: string): void {
    this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  addMessage(msg: ChatMessage): void {
    const meta =
      msg.logTopic !== undefined ||
      msg.diff !== undefined ||
      msg.logDetail !== undefined
        ? JSON.stringify({
            logTopic: msg.logTopic,
            logDetail: msg.logDetail,
            diff: msg.diff,
          })
        : null;
    // OR REPLACE: re-pinning the same event id (a replayed or duplicated
    // publish) should update the row, never abort the task that wrote it.
    this.db
      .prepare(
        "INSERT OR REPLACE INTO chat_messages(" +
          "id, conversation_id, task_id, role, text, created_at, meta) " +
          "VALUES(?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        msg.id,
        msg.conversationId,
        msg.taskId ?? null,
        msg.role,
        msg.text,
        msg.createdAt,
        meta
      );
  }

  getMessages(conversationId: string): ChatMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at"
      )
      .all(conversationId) as MessageRow[];
    return rows.map((r) => {
      const meta = r.meta ? (JSON.parse(r.meta) as StoredMeta) : null;
      return {
        id: r.id,
        conversationId: r.conversation_id,
        taskId: r.task_id ?? undefined,
        role: r.role as ChatMessage["role"],
        text: r.text,
        createdAt: r.created_at,
        logTopic: meta?.logTopic,
        logDetail: meta?.logDetail,
        diff: meta?.diff,
      };
    });
  }

  createTask(task: TaskInfo): void {
    this.db
      .prepare(
        "INSERT INTO tasks(id, conversation_id, prompt, status, started_at, ended_at) " +
          "VALUES(?, ?, ?, ?, ?, ?)"
      )
      .run(task.id, task.conversationId, task.prompt, task.status, task.startedAt, task.endedAt);
  }

  /**
   * Moves a queued task into `running` and re-stamps its start time, so the
   * elapsed counter measures the run and not how long it waited in line.
   */
  startTask(taskId: string, startedAt: number): void {
    this.db
      .prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?")
      .run(startedAt, taskId);
  }

  updateTaskStatus(taskId: string, status: TaskStatus, endedAt?: number): void {
    this.db
      .prepare("UPDATE tasks SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, endedAt ?? null, taskId);
  }

  /**
   * A fresh agent process owns no live tasks. Rows still marked running came
   * from a process that closed mid-turn; make them reviewable history rather
   * than letting the renderer mistake them for work that is still alive.
   */
  markStaleTasksInterrupted(at = Date.now()): number {
    return this.db
      .prepare(
        "UPDATE tasks SET status = 'error', ended_at = ? " +
          "WHERE status = 'running' AND ended_at IS NULL"
      )
      .run(at).changes;
  }

  listTasks(activeOnly?: boolean, conversationId?: string): TaskInfo[] {
    const filters: string[] = [];
    const params: unknown[] = [];
    if (activeOnly) filters.push("status = 'running'");
    if (conversationId) {
      filters.push("conversation_id = ?");
      params.push(conversationId);
    }
    const where = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
    const limit = conversationId ? "" : " LIMIT 100";
    const rows = this.db
      .prepare(`SELECT * FROM tasks${where} ORDER BY started_at DESC${limit}`)
      .all(...params) as TaskRow[];
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      prompt: r.prompt,
      status: r.status as TaskInfo["status"],
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
  }
}

interface ConversationRow {
  id: string;
  title: string;
  sdk_session_id: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  task_id: string | null;
  role: string;
  text: string;
  created_at: number;
  meta: string | null;
}

interface StoredMeta {
  logTopic?: string;
  logDetail?: string;
  diff?: ChatMessage["diff"];
}

interface TaskRow {
  id: string;
  conversation_id: string;
  prompt: string;
  status: string;
  started_at: number;
  ended_at: number | null;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    sdkSessionId: row.sdk_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
