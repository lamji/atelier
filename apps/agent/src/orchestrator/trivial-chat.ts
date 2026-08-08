import type { TaskOptions } from "./orchestrator.js";

/** Past this length a message is a request, not a greeting. */
const MAX_CHARS = 80;

/**
 * Words that make a turn engineering work even in a short sentence. "why"
 * and "where" are here on purpose: "why can't I log in?" is a debugging
 * turn that deserves the effort the user picked.
 */
const WORK_WORDS =
  /\b(fix|add|implement|refactor|build|run|test|debug|error|bug|why|where|which|how|create|update|remove|delete|change|install|deploy|check|search|find|read|write|open|log|crash|fail|review|commit|merge|migrate|start|stop|restart|port|explain|show)\b/i;

/** A path, filename, flag, or code span — never a greeting. */
const CODE_SHAPE = /[/\\`{}()<>$]|\.[a-z]{1,4}\b|--?[a-z]/i;

/**
 * True when the message is conversation rather than work: "hi", "thanks",
 * "ok cool", "nice one".
 *
 * The point is latency. A greeting sent at Opus/Medium still buys a full
 * reasoning pass plus whatever tools the model decides to call, so a turn
 * with nothing to think about cost tens of seconds. The test is deliberately
 * narrow — short, no work word, no code shape, no attachment — because the
 * cost of getting it wrong is a real question answered too cheaply.
 */
export function isTrivialChat(prompt: string, hasImages: boolean): boolean {
  if (hasImages) return false;
  const text = prompt.trim();
  if (!text || text.length > MAX_CHARS) return false;
  if (text.includes("\n")) return false;
  // A question is asking for something, however short — "the other issue?"
  // carries no work word yet expects a real answer.
  if (text.endsWith("?")) return false;
  if (CODE_SHAPE.test(text)) return false;
  return !WORK_WORDS.test(text);
}

/**
 * The effort this turn actually runs at: the user's pick, dropped to the
 * cheapest tier for a greeting. Never raises what the user chose.
 */
export function effortFor(
  prompt: string,
  hasImages: boolean,
  picked: TaskOptions["effort"]
): TaskOptions["effort"] {
  return isTrivialChat(prompt, hasImages) ? "low" : picked;
}
