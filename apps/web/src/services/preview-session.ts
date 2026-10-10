import { bridge } from "@/services/bridge-client";
import { currentPreviewUrl } from "@/services/preview-context";

/**
 * Hands the agent the session the user is already signed into.
 *
 * A frontend review used to open an empty headless profile, so any app that
 * gates its routes bounced it to a login screen and the audit reported on
 * /auth instead of the changed page. Electron can read the real cookies and
 * web storage of the displayed preview iframe; this publishes them to the
 * agent, which holds them in memory for the next preview_review call.
 *
 * The snapshot travels renderer -> agent over RPC only. It is never appended
 * to the prompt and never rendered, so tokens do not reach the model or the
 * transcript.
 */
export async function publishPreviewSession(
  previewUrl: string
): Promise<boolean> {
  const getPreviewSession = window.atelierDesktop?.getPreviewSession;
  if (!getPreviewSession) return false;

  let session: AtelierDesktopPreviewSessionResult | null;
  try {
    session = await getPreviewSession(previewUrl);
  } catch {
    return false;
  }
  if (!session) return false;
  const empty =
    session.cookies.length === 0 &&
    session.localStorage.length === 0 &&
    session.sessionStorage.length === 0;
  if (empty) return false;

  try {
    const { accepted } = await bridge.rpc("preview.session.set", {
      url: session.url,
      origin: session.origin,
      cookies: session.cookies,
      localStorage: session.localStorage,
      sessionStorage: session.sessionStorage,
      capturedAt: session.capturedAt,
    });
    return accepted;
  } catch {
    return false;
  }
}

/**
 * Publishes the session of whatever Page preview is currently open.
 *
 * Called on every send, beside the DOM capture. The session has a short
 * TTL in the agent, so republishing each turn is what keeps a command like
 * `/context_mock_api` calling the API as a signed-in user rather than as
 * nobody — and it is a no-op when no preview is open.
 */
export async function publishActivePreviewSession(): Promise<boolean> {
  const url = currentPreviewUrl();
  if (!url) return false;
  return publishPreviewSession(url);
}

/** Drops the held session — on sign-out, or when Page preview closes. */
export async function clearPreviewSession(origin?: string): Promise<void> {
  try {
    await bridge.rpc("preview.session.clear", origin ? { origin } : undefined);
  } catch {
    // A detached agent has nothing to clear.
  }
}
