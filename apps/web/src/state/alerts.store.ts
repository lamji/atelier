import { create } from "zustand";

export type AlertTone = "info" | "success" | "warning" | "danger";

export interface AlertAction {
  label: string;
  run: () => void;
}

export interface AppAlert {
  id: string;
  tone: AlertTone;
  title: string;
  detail?: string;
  action?: AlertAction;
  /** Sticky alerts stay until dismissed or replaced by id. */
  sticky?: boolean;
  /** Called when the user closes the alert (X or the action button). */
  onDismiss?: () => void;
  createdAt: number;
}

export interface AlertInput {
  /** Stable id makes a repeat REPLACE the previous alert instead of stacking. */
  id?: string;
  tone: AlertTone;
  title: string;
  detail?: string;
  action?: AlertAction;
  sticky?: boolean;
  onDismiss?: () => void;
  /** Auto-dismiss delay; ignored for sticky alerts. */
  ttlMs?: number;
}

interface AlertsStore {
  alerts: AppAlert[];
  push: (input: AlertInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const DEFAULT_TTL: Record<AlertTone, number> = {
  info: 4_000,
  success: 4_000,
  warning: 7_000,
  danger: 9_000,
};
const MAX_VISIBLE = 4;
const timers = new Map<string, number>();
let seq = 0;

/**
 * Transient, top-centre alerts. Every git source-control operation reports
 * here — success and failure alike — so an action taken from a panel that
 * is no longer on screen (or a streamed run that took a while) still gets
 * an unmissable one-line outcome. Sticky alerts (merge conflicts) live
 * until the condition clears.
 */
export const useAlertsStore = create<AlertsStore>((set, get) => ({
  alerts: [],
  push: (input) => {
    const id = input.id ?? `alert-${++seq}`;
    const existing = timers.get(id);
    if (existing) {
      window.clearTimeout(existing);
      timers.delete(id);
    }
    const alert: AppAlert = {
      id,
      tone: input.tone,
      title: input.title,
      detail: input.detail,
      action: input.action,
      sticky: input.sticky,
      onDismiss: input.onDismiss,
      createdAt: Date.now(),
    };
    set((s) => {
      const rest = s.alerts.filter((a) => a.id !== id);
      // Oldest non-sticky alerts fall off first when the stack is full.
      const trimmed = [...rest, alert];
      while (trimmed.length > MAX_VISIBLE) {
        const idx = trimmed.findIndex((a) => !a.sticky && a.id !== id);
        if (idx === -1) break;
        trimmed.splice(idx, 1);
      }
      return { alerts: trimmed };
    });
    if (!input.sticky) {
      const ttl = input.ttlMs ?? DEFAULT_TTL[input.tone];
      timers.set(
        id,
        window.setTimeout(() => get().dismiss(id), ttl)
      );
    }
    return id;
  },
  dismiss: (id) => {
    const t = timers.get(id);
    if (t) window.clearTimeout(t);
    timers.delete(id);
    set((s) =>
      s.alerts.some((a) => a.id === id)
        ? { alerts: s.alerts.filter((a) => a.id !== id) }
        : s
    );
  },
  clear: () => {
    for (const t of timers.values()) window.clearTimeout(t);
    timers.clear();
    set({ alerts: [] });
  },
}));

/** Shorthand used by the git view models: `alert.success("Pushed 2 commits")`. */
export const alert = {
  info: (title: string, detail?: string, extra?: Partial<AlertInput>) =>
    useAlertsStore.getState().push({ tone: "info", title, detail, ...extra }),
  success: (title: string, detail?: string, extra?: Partial<AlertInput>) =>
    useAlertsStore.getState().push({ tone: "success", title, detail, ...extra }),
  warning: (title: string, detail?: string, extra?: Partial<AlertInput>) =>
    useAlertsStore.getState().push({ tone: "warning", title, detail, ...extra }),
  danger: (title: string, detail?: string, extra?: Partial<AlertInput>) =>
    useAlertsStore.getState().push({ tone: "danger", title, detail, ...extra }),
  dismiss: (id: string) => useAlertsStore.getState().dismiss(id),
};
