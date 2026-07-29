/** Longest a conversation title may be before it is elided. */
const MAX_TITLE_CHARS = 60;

/**
 * The history-list label for a conversation, derived from a prompt or from
 * a note's heading.
 *
 * Shared because both ends produce it: the composer sets it optimistically
 * the moment a task starts, and the agent persists it. If the two clipped
 * differently the title would visibly change the first time the session was
 * reloaded from the database.
 */
export function conversationTitle(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_TITLE_CHARS
    ? `${trimmed.slice(0, MAX_TITLE_CHARS - 3)}…`
    : trimmed;
}
