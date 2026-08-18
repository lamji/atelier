import { approxTokens, clipToTokens } from "@atelier/shared";
import type { ChatMessage } from "@atelier/protocol";
import type { ConversationRepo } from "../../storage/repositories/conversations.js";
import type {
  TaskSummary,
  TaskSummaryStore,
} from "../summaries/index.js";

export interface SharedSessionContextInput {
  conversationId: string;
  currentTaskId: string;
  /**
   * Tasks whose memory retrieval already surfaced as chunks. Their summaries
   * are skipped here so the same work is never paid for twice.
   */
  excludeTaskIds?: string[];
  /** Token cap for the whole block. */
  maxTokens?: number;
  /**
   * How many of the newest turns the provider already carries verbatim, as
   * real conversation messages. Ollama seeds its transcript with them (see
   * the agent loop), and a summary of a turn sitting beside the turn itself
   * is pure duplication — the budget it frees goes to the task summaries,
   * which nothing else carries.
   */
  verbatimTurns?: number;
}

export interface SharedSessionContext {
  text: string;
  /** Compressed task summaries included in the block. */
  summaries: number;
  /** Verbatim prior turns included in the block. */
  turns: number;
  tokens: number;
  /** Short labels for what was recalled, newest first. */
  labels: string[];
}

const DEFAULT_MAX_TOKENS = 900;
/**
 * Share of the block reserved for verbatim turns. They are the only record of
 * what was actually SAID — summaries can be recovered from RAG, an exchange
 * cannot — so they are budgeted first and the summaries take what is left.
 */
const TURNS_SHARE = 0.6;

export const EMPTY_SHARED_SESSION: SharedSessionContext = {
  text: "",
  summaries: 0,
  turns: 0,
  tokens: 0,
  labels: [],
};

/**
 * Provider-neutral conversation memory. Claude, Codex and Ollama cannot share
 * each other's native session ids, so Atelier owns continuity here.
 *
 * This block is complementary to retrieved session-memory chunks, never
 * replaced by them: RAG finds the relevant OLD work, this carries the RECENT
 * exchange. Suppressing one because the other fired is how a model switch
 * used to lose the thread.
 */
export class SharedSessionContextBuilder {
  constructor(
    private deps: {
      conversations: ConversationRepo;
      summaries: TaskSummaryStore;
    }
  ) {}

  build(input: SharedSessionContextInput): SharedSessionContext {
    const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
    const excluded = new Set(input.excludeTaskIds ?? []);
    const summaries = this.deps.summaries
      .recent(input.conversationId, 8)
      .filter(
        (summary) =>
          summary.taskId !== input.currentTaskId && !excluded.has(summary.taskId)
      );
    const recent = this.deps.conversations
      .getMessages(input.conversationId)
      .filter(
        (message) =>
          message.taskId !== input.currentTaskId &&
          (message.role === "user" || message.role === "assistant")
      )
      .slice(-10);
    // Drop the tail the provider is sending verbatim, keep the older turns
    // it is not. Trimming the whole block instead would lose turns 5-10,
    // which nothing else in the turn carries.
    const carried = Math.max(0, input.verbatimTurns ?? 0);
    const messages =
      carried > 0 ? recent.slice(0, Math.max(0, recent.length - carried)) : recent;

    const renderedTurns =
      messages.length > 0
        ? renderTurns(messages, maxTokens * TURNS_SHARE)
        : EMPTY_RENDERED;
    // Whatever the turns did not spend stays available to the summaries.
    const summaryBudget = maxTokens - approxTokens(renderedTurns.text);
    const renderedSummaries =
      summaries.length > 0 && summaryBudget > 0
        ? renderSummaries(summaries, summaryBudget)
        : EMPTY_RENDERED;

    const parts: string[] = [];
    if (renderedSummaries.text) {
      parts.push("Task summaries:", renderedSummaries.text);
    }
    if (renderedTurns.text) parts.push("Recent turns:", renderedTurns.text);
    if (parts.length === 0) return EMPTY_SHARED_SESSION;

    const text =
      "\nSHARED ATELIER SESSION CONTEXT " +
      "(provider-neutral memory; use this when the user switches models):\n" +
      parts.join("\n");
    return {
      text,
      summaries: renderedSummaries.count,
      turns: renderedTurns.count,
      tokens: approxTokens(text),
      labels: renderedSummaries.items
        .slice(0, 3)
        .map((summary) => label(summary.text)),
    };
  }
}

/** First clause of a summary line — enough to recognise the work. */
function label(text: string): string {
  const head = text.replace(/^request:\s*/i, "").split(" · ")[0] ?? text;
  return head.length > 60 ? `${head.slice(0, 57)}…` : head;
}

interface Rendered<T = never> {
  text: string;
  count: number;
  items: T[];
}

const EMPTY_RENDERED: Rendered = { text: "", count: 0, items: [] };

/**
 * Packs the newest exchange first. The previous implementation rendered
 * oldest-to-newest and then clipped the tail, which discarded exactly the
 * assistant answer a terse follow-up such as "fix the gap" referred to.
 */
function renderTurns(
  messages: ChatMessage[],
  budget: number
): Rendered<ChatMessage> {
  const newestFirst = [...messages].reverse();
  const selected: Array<{ message: ChatMessage; line: string }> = [];
  let remaining = Math.max(0, Math.floor(budget));

  for (let index = 0; index < newestFirst.length && remaining > 0; index++) {
    // Always give the latest user/assistant exchange a fair share. Older turns
    // are useful only when enough budget remains for a meaningful excerpt.
    if (index >= 2 && remaining < 80) break;
    const message = newestFirst[index]!;
    const role = message.role === "assistant" ? "assistant" : "user";
    const prefix = `- ${role}: `;
    const roleLimit = role === "assistant" ? 900 : 500;
    const newestExchangeShare =
      index < 2 ? Math.max(1, Math.floor(budget / 2)) : remaining;
    const lineBudget = Math.min(roleLimit, remaining, newestExchangeShare);
    const bodyBudget = lineBudget - approxTokens(prefix);
    if (bodyBudget <= 0) break;
    const line = `${prefix}${clipTurnText(message.text, bodyBudget)}`;
    const cost = approxTokens(line);
    if (cost > remaining) break;
    selected.push({ message, line });
    remaining -= cost;
  }

  selected.reverse();
  return {
    text: selected.map(({ line }) => line).join("\n"),
    count: selected.length,
    items: selected.map(({ message }) => message),
  };
}

/** Summaries arrive newest-first; preserve that priority under clipping. */
function renderSummaries(
  summaries: TaskSummary[],
  budget: number
): Rendered<TaskSummary> {
  const selected: Array<{ summary: TaskSummary; line: string }> = [];
  let remaining = Math.max(0, Math.floor(budget));
  for (const summary of summaries) {
    const prefix = "- ";
    const bodyBudget = remaining - approxTokens(prefix);
    if (bodyBudget <= 0) break;
    const line = `${prefix}${clipToTokens(summary.text, bodyBudget)}`;
    const cost = approxTokens(line);
    if (cost > remaining) break;
    selected.push({ summary, line });
    remaining -= cost;
  }
  return {
    text: selected.map(({ line }) => line).join("\n"),
    count: selected.length,
    items: selected.map(({ summary }) => summary),
  };
}

/**
 * Keep both the start and end of a long turn. The start carries the subject;
 * the end commonly carries the actual recommendation or unresolved gap.
 */
function clipTurnText(text: string, maxTokens: number): string {
  if (approxTokens(text) <= maxTokens) return text;
  const maxChars = Math.max(0, maxTokens * 4 - 1);
  const marker = " … [middle omitted] … ";
  if (maxChars <= marker.length) return clipToTokens(text, maxTokens);
  const available = maxChars - marker.length;
  const head = Math.floor(available * 0.4);
  return `${text.slice(0, head)}${marker}${text.slice(-(available - head))}`;
}
