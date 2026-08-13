import { create } from "zustand";

/** Where a line came from — shell tool calls, or one of the validators. */
export type ConsoleSource = "shell" | "typecheck" | "lint" | "test";

export interface ConsoleLine {
  /** Monotonic per conversation; React keys only, never rendered. */
  id: number;
  source: ConsoleSource;
  text: string;
}

/**
 * Scrollback cap per conversation. A failing suite can emit tens of
 * thousands of lines and the pane only exists to be read, so the oldest are
 * dropped rather than kept for a scrollbar nobody drags that far.
 */
const MAX_LINES = 2000;

interface ConversationConsole {
  lines: ConsoleLine[];
  /**
   * A chunk boundary is not a line boundary: output arrives mid-line and the
   * remainder lands in the next chunk. Held here until its newline shows up,
   * so a line is never split into two rows.
   */
  partial: string;
  nextId: number;
  /**
   * When output was last seen, as epoch ms. This is the whole reason the
   * pane earns its place: a run that is grinding and a run that has hung
   * look identical in the process rail, and differ only here.
   */
  lastAt: number | null;
}

function emptyConsole(): ConversationConsole {
  return { lines: [], partial: "", nextId: 0, lastAt: null };
}

interface ProcessConsoleStore {
  byConversation: Record<string, ConversationConsole>;
  append: (convId: string, source: ConsoleSource, chunk: string) => void;
  clear: (convId: string) => void;
  reset: () => void;
}

/**
 * Streamed output from everything the agent runs, per conversation.
 *
 * Kept apart from the transcript on purpose: this is a tail of a process,
 * not a message, and it turns over far too fast to belong to anything that
 * re-renders the conversation.
 */
export const useProcessConsoleStore = create<ProcessConsoleStore>((set) => ({
  byConversation: {},

  append: (convId, source, chunk) =>
    set((state) => {
      const current = state.byConversation[convId] ?? emptyConsole();
      const text = current.partial + chunk.replaceAll("\r\n", "\n");
      const parts = text.split("\n");
      // The trailing element is whatever followed the last newline — an
      // unfinished line, unless the chunk happened to end on one.
      const partial = parts.pop() ?? "";
      let nextId = current.nextId;
      const added = parts.map((line) => ({
        id: nextId++,
        source,
        text: line,
      }));
      const lines = [...current.lines, ...added];
      return {
        byConversation: {
          ...state.byConversation,
          [convId]: {
            lines: lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines,
            partial,
            nextId,
            lastAt: Date.now(),
          },
        },
      };
    }),

  clear: (convId) =>
    set((state) => ({
      byConversation: { ...state.byConversation, [convId]: emptyConsole() },
    })),

  reset: () => set({ byConversation: {} }),
}));
