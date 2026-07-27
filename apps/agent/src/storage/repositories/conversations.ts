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

  setSdkSessionId(id: string, sdkSessionId: string): void {
    this.db
      .prepare(
        "UPDATE conversations SET sdk_session_id = ?, updated_at = ? WHERE id = ?"
      )
      .run(sdkSessionId, Date.now(), id);
  }

  touch(id: string): void {
    this.db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  addMessage(msg: ChatMessage): void {
    const meta =
      msg.logTopic !== undefined || msg.diff !== undefined
        ? JSON.stringify({ logTopic: msg.logTopic, diff: msg.diff })
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

  updateTaskStatus(taskId: string, status: TaskStatus, endedAt?: number): void {
    this.db
      .prepare("UPDATE tasks SET status = ?, ended_at = ? WHERE id = ?")
      .run(status, endedAt ?? null, taskId);
  }

  listTasks(activeOnly?: boolean): TaskInfo[] {
    const sql = activeOnly
      ? "SELECT * FROM tasks WHERE status = 'running' ORDER BY started_at DESC"
      : "SELECT * FROM tasks ORDER BY started_at DESC LIMIT 100";
    const rows = this.db.prepare(sql).all() as TaskRow[];
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
