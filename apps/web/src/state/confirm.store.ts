import { create } from "zustand";

/**
 * In-app replacement for `window.confirm`.
 *
 * Electron on Windows has a long-standing bug: after a native
 * `confirm()`/`alert()` closes, the page's text inputs stop taking
 * keystrokes until the window loses and regains focus. The dialog looks
 * gone, the caret even blinks, and typing does nothing. Asking through
 * this store keeps the prompt inside the renderer, so focus never leaves.
 */
export interface ConfirmRequest {
  title: string;
  message: string;
  /** Label for the confirming button. */
  confirmLabel?: string;
  /** Paints the confirming button red: the action cannot be undone. */
  destructive?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

interface ConfirmState {
  pending: PendingConfirm | null;
  answer: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  pending: null,
  answer: (ok) => {
    const pending = get().pending;
    if (!pending) return;
    set({ pending: null });
    pending.resolve(ok);
  },
}));

/** Resolves true when the user confirms, false on cancel or Escape. */
export function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  // A second ask while one is open cancels the first rather than
  // leaving its promise hanging forever.
  useConfirmStore.getState().answer(false);
  return new Promise((resolve) => {
    useConfirmStore.setState({ pending: { ...request, resolve } });
  });
}
