import { create } from "zustand";
import type { CliDoc } from "@atelier/protocol";
import { bridge } from "./bridge-client.js";

/**
 * The reports the `atelier-init-feature` skill has written into this workspace's
 * `.atelier/doc-agent`, and which session's reports are open in the main
 * view. Each report names the session that wrote it, which is how a row in
 * the Agents list knows it has documentation to show.
 */
interface CliDocsStore {
  docs: CliDoc[];
  /** Conversation whose reports cover the main view; null shows the session. */
  openFor: string | null;
  open: (conversationId: string) => void;
  close: () => void;
  reset: () => void;
}

export const useCliDocsStore = create<CliDocsStore>((set) => ({
  docs: [],
  openFor: null,
  open: (conversationId) => set({ openFor: conversationId }),
  close: () => set({ openFor: null }),
  reset: () => set({ docs: [], openFor: null }),
}));

let refreshing: Promise<void> | null = null;

/**
 * Re-list the saved reports. Best-effort: an agent without the method, or a
 * workspace nobody has documented, is simply no reports.
 */
export function refreshCliDocs(): Promise<void> {
  refreshing ??= bridge
    .rpc("cli.docs.list", {})
    .then(({ docs }) => useCliDocsStore.setState({ docs }))
    .catch(() => undefined)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * Re-list the reports as they are from this moment on. A listing already in
 * flight may have read the folder before the turn that just ended wrote to
 * it, so it is waited out and a new one is made.
 */
export async function refreshCliDocsNow(): Promise<CliDoc[]> {
  await refreshing;
  await refreshCliDocs();
  return useCliDocsStore.getState().docs;
}

/**
 * Every id a report may carry for one Agents row. Codex is handed the row's
 * conversation id (or its pty's, when it has no row); Claude Code fills in
 * its own session id, which is the one the row resumes by.
 */
export function sessionKeys(
  conversationId: string,
  binding: { termId: string; sessionId?: string } | undefined,
  resumed: Record<string, string>
): string[] {
  const keys = [conversationId];
  if (binding) {
    keys.push(binding.termId);
    if (binding.sessionId) keys.push(binding.sessionId);
    const live = resumed[binding.termId];
    if (live) keys.push(live);
  }
  return keys;
}

/** The reports written by a session, newest first. */
export function docsForSession(docs: CliDoc[], keys: string[]): CliDoc[] {
  return docs.filter((doc) => doc.session !== null && keys.includes(doc.session));
}
