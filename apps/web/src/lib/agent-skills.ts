/** Curated agent roles surfaced beside provider models in the composer. */
export const UI_UX_DESIGNER_CHOICE = "atelier/ui-ux-designer";

/**
 * Backend Engineer: runs /secure-backend-integrator on the flagship Codex
 * row at its highest supported reasoning level.
 */
export const BACKEND_ENGINEER_CHOICE = "atelier/secure-backend-integrator";

/** Public assets that are injected into every UI/UX Designer task. */
export const UI_UX_DESIGNER_REFERENCE_PATHS = [
  "skills/ui-ux-designer/reference-01-dashboard-green.png",
  "skills/ui-ux-designer/reference-02-dashboard-yellow.png",
  "skills/ui-ux-designer/reference-03-income-blue.png",
] as const;

const UI_UX_REFERENCES_SENT_KEY = "atelier.uiUxDesigner.referencesSent";
const MAX_REFERENCE_CONVERSATIONS = 200;

/** True after this conversation successfully started its first design task. */
export function uiUxReferencesWereSent(conversationId: string): boolean {
  return readReferenceConversations().includes(conversationId);
}

/**
 * Persist successful delivery so later design follow-ups do not resend three
 * expensive reference images. The cap matches remembered composer chats.
 */
export function markUiUxReferencesSent(conversationId: string): void {
  const current = readReferenceConversations().filter(
    (id) => id !== conversationId
  );
  current.push(conversationId);
  localStorage.setItem(
    UI_UX_REFERENCES_SENT_KEY,
    JSON.stringify(current.slice(-MAX_REFERENCE_CONVERSATIONS))
  );
}

function readReferenceConversations(): string[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(UI_UX_REFERENCES_SENT_KEY) ?? "[]"
    ) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}
