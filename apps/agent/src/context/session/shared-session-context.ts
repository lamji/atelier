import { approxTokens, clipToTokens } from "@atelier/shared";
import type { ChatMessage } from "@atelier/protocol";
import { clipKeepingRefs } from "./clip-keeping-refs.js";
import type { ConversationRepo } from "../../storage/repositories/conversations.js";
import type {
  TaskSummary,
  TaskSummaryStore,
} from "../summaries/index.js";
import type {
  CommandMeta,
  TaskActions,
} from "../working-memory/working-memory-store.js";

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
  /** Earlier tasks whose edits/commands/reads are listed in the block. */
  actions: number;
  tokens: number;
  /** Short labels for what was recalled, newest first. */
  labels: string[];
}

const DEFAULT_MAX_TOKENS = 1600;
/**
 * Share of the block reserved for verbatim turns. They are the only record of
 * what was actually SAID — summaries can be recovered from RAG, an exchange
 * cannot — so they are budgeted first and the summaries take what is left.
 */
const TURNS_SHARE = 0.65;
/**
 * Ceiling for the record of what earlier turns DID. It is addresses and
 * exit codes, so it rarely gets near this; the cap only stops a turn that
 * ran forty commands from eating the exchange.
 */
const ACTIONS_SHARE = 0.15;
/** Prior messages considered for the turns section. */
const TURN_WINDOW = 16;
/** Earlier tasks whose actions are listed. */
const ACTION_TASKS = 2;

export const EMPTY_SHARED_SESSION: SharedSessionContext = {
  text: "",
  summaries: 0,
  turns: 0,
  actions: 0,
  tokens: 0,
  labels: [],
};

/**
 * Provider-neutral conversation memory. Claude, Codex and Ollama cannot share
 * each other's native session ids, so Atelier owns continuity here.
 *
 * The native transcript a CLI replays carries three things: what was said,
 * what was done (tool calls and their output), and what was read. This block
 * carries the same three — the exchange verbatim, the work as addresses and
 * outcomes, the reading as paths — at a small fraction of the tokens,
 * because it never replays a tool result the model can re-fetch.
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
      /** What earlier turns did; absent in offline harnesses. */
      workingMemory?: {
        actions(
          conversationId: string,
          excludeTaskId: string,
          maxTasks?: number
        ): TaskActions[];
      };
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
      .slice(-TURN_WINDOW);
    // Drop the tail the provider is sending verbatim, keep the older turns
    // it is not. Trimming the whole block instead would lose the older
    // turns, which nothing else in the turn carries.
    const carried = Math.max(0, input.verbatimTurns ?? 0);
    const messages =
      carried > 0 ? recent.slice(0, Math.max(0, recent.length - carried)) : recent;

    const actions = this.deps.workingMemory
      ? safeActions(this.deps.workingMemory, input.conversationId, input.currentTaskId)
      : [];
    const renderedActions =
      actions.length > 0
        ? renderActions(actions, Math.floor(maxTokens * ACTIONS_SHARE))
        : EMPTY_RENDERED;
    const afterActions = maxTokens - approxTokens(renderedActions.text);

    const renderedTurns =
      messages.length > 0
        ? renderTurns(messages, Math.floor(afterActions * TURNS_SHARE))
        : EMPTY_RENDERED;
    // Whatever the turns did not spend stays available to the summaries.
    const summaryBudget = afterActions - approxTokens(renderedTurns.text);
    const renderedSummaries =
      summaries.length > 0 && summaryBudget > 0
        ? renderSummaries(summaries, summaryBudget)
        : EMPTY_RENDERED;

    const parts: string[] = [];
    if (renderedSummaries.text) {
      parts.push("Earlier work in this conversation (compressed):", renderedSummaries.text);
    }
    if (renderedActions.text) parts.push(renderedActions.text);
    if (renderedTurns.text) parts.push("Recent turns (verbatim):", renderedTurns.text);
    if (parts.length === 0) return EMPTY_SHARED_SESSION;

    const text =
      "\nALIGNED ATELIER CONVERSATION CONTEXT " +
      "(provider-neutral; use this like ordinary human conversational memory):\n" +
      "The latest user message is the only active instruction. Use the prior " +
      "turns below to carry forward the established subject, referents, " +
      "project/location, working area, decisions, and constraints unless the " +
      "latest message changes them. Prior requests are context, not queued " +
      "work; never execute one instead of the latest request.\n" +
      "A terse reply (\"do it\", \"you should have\", \"why X\") refers to the " +
      "CLOSING part of your previous answer — the offer, recommendation or " +
      "question it ended with — not to a new subject. What earlier turns " +
      "already did is listed as addresses: re-open a file only when you need " +
      "its current text, and do not repeat a command just to see it again.\n" +
      parts.join("\n");
    return {
      text,
      summaries: renderedSummaries.count,
      turns: renderedTurns.count,
      actions: renderedActions.count,
      tokens: approxTokens(text),
      labels: renderedSummaries.items
        .slice(0, 3)
        .map((summary) => label(summary.text)),
    };
  }
}

/** Memory is a side effect of the turn, never a way to fail it. */
function safeActions(
  store: NonNullable<
    ConstructorParameters<typeof SharedSessionContextBuilder>[0]["workingMemory"]
  >,
  conversationId: string,
  currentTaskId: string
): TaskActions[] {
  try {
    return store.actions(conversationId, currentTaskId, ACTION_TASKS);
  } catch {
    return [];
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
  // Per-turn ceilings grow with the budget: a 480-token block once cut the
  // newest answer to 190 tokens, and the recommendation at its end — the
  // thing the user's next message was about — fell off. With room to
  // spare, the previous answer rides whole.
  const assistantCap = Math.max(900, Math.floor(budget * 0.65));
  const userCap = Math.max(500, Math.floor(budget * 0.35));

  for (let index = 0; index < newestFirst.length && remaining > 0; index++) {
    // Always give the latest user/assistant exchange a fair share. Older turns
    // are useful only when enough budget remains for a meaningful excerpt.
    if (index >= 2 && remaining < 80) break;
    const message = newestFirst[index]!;
    const role = message.role === "assistant" ? "assistant" : "user";
    const prefix = `- ${role}: `;
    const roleLimit = role === "assistant" ? assistantCap : userCap;
    // The newest exchange is split unevenly: the assistant's answer is what
    // a terse follow-up ("implement") points at, the user's own message the
    // model already has in front of it. An even split once cut a plan
    // answer to 100 tokens and dropped the two file:line findings in it.
    const newestExchangeShare =
      index < 2
        ? Math.max(1, Math.floor(budget * (role === "assistant" ? 0.65 : 0.35)))
        : remaining;
    const lineBudget = Math.min(roleLimit, remaining, newestExchangeShare);
    const bodyBudget = lineBudget - approxTokens(prefix);
    if (bodyBudget <= 0) break;
    // The newest assistant answer keeps more of its TAIL: offers,
    // recommendations and open questions live in the closing paragraph.
    const headShare = index < 2 && role === "assistant" ? 0.3 : 0.4;
    const line = `${prefix}${clipTurnText(message.text, bodyBudget, headShare)}`;
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

const MAX_EDITS = 8;
const MAX_COMMANDS = 6;
const MAX_READS = 10;
const MAX_SEARCHES = 5;

/**
 * What the previous task (and the one before) did, newest first. Each
 * task is one short list; a list that would overrun the budget is cut
 * from the least valuable end — reads and searches go before edits and
 * commands, because an edit or a failed command is what "still broken"
 * is about.
 */
function renderActions(
  actions: TaskActions[],
  budget: number
): Rendered<TaskActions> {
  const selected: Array<{ actions: TaskActions; text: string }> = [];
  let remaining = Math.max(0, Math.floor(budget));
  actions.forEach((task, index) => {
    if (remaining <= 20) return;
    const heading =
      index === 0 ? "What your previous turn did:" : "What the turn before that did:";
    const lines = actionLines(task);
    if (lines.length === 0) return;
    let text = `${heading}\n${lines.join("\n")}`;
    // Cut trailing lines (reads/searches come last) until it fits.
    while (approxTokens(text) > remaining && lines.length > 1) {
      lines.pop();
      text = `${heading}\n${lines.join("\n")}`;
    }
    if (approxTokens(text) > remaining) {
      text = clipToTokens(text, remaining);
    }
    if (!text.trim()) return;
    selected.push({ actions: task, text });
    remaining -= approxTokens(text);
  });
  return {
    text: selected.map(({ text }) => text).join("\n"),
    count: selected.length,
    items: selected.map(({ actions: task }) => task),
  };
}

function actionLines(task: TaskActions): string[] {
  const lines: string[] = [];
  if (task.edits.length > 0) {
    lines.push(`- edited: ${listOf(task.edits, MAX_EDITS)}`);
  }
  for (const command of task.commands.slice(0, MAX_COMMANDS)) {
    lines.push(`- ran ${commandLine(command)}`);
  }
  if (task.reads.length > 0) {
    lines.push(`- read: ${listOf(task.reads, MAX_READS)}`);
  }
  for (const search of task.searches.slice(0, MAX_SEARCHES)) {
    const hits = search.paths.length > 0 ? listOf(search.paths, 4) : "no hits";
    lines.push(`- searched "${clipChars(search.query, 60)}" → ${hits}`);
  }
  return lines;
}

function commandLine(command: CommandMeta): string {
  const outcome = command.timedOut
    ? "timed out"
    : command.exitCode === null
      ? "no exit code"
      : `exit ${command.exitCode}`;
  // A clean run's last line is noise ("done"); a failure's last line is
  // the error, and the error is the whole point of remembering it.
  const tail =
    command.tail && (command.exitCode !== 0 || command.timedOut)
      ? `: ${clipChars(command.tail, 120)}`
      : "";
  return `\`${clipChars(command.command, 120)}\` → ${outcome}${tail}`;
}

function listOf(items: string[], cap: number): string {
  const shown = items.slice(0, cap).join(", ");
  const more = items.length - cap;
  return more > 0 ? `${shown} (+${more} more)` : shown;
}

function clipChars(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/**
 * Keep both the start and end of a long turn. The start carries the subject;
 * the end commonly carries the actual recommendation or unresolved gap —
 * and the file references in the omitted middle are re-attached, because
 * they are the part a follow-up implements.
 */
function clipTurnText(text: string, maxTokens: number, headShare = 0.4): string {
  if (approxTokens(text) <= maxTokens) return text;
  const maxChars = Math.max(0, maxTokens * 4 - 1);
  if (maxChars < 40) return clipToTokens(text, maxTokens);
  return clipKeepingRefs(text, maxChars, headShare);
}
