/**
 * Resolves the URL the renderer window should load.
 *
 * Dev: ATELIER_DEV_URL points at the Vite dev server (http://localhost:517x),
 * started by the existing root scripts/dev.mjs. The WS bridge's Origin
 * allowlist accepts localhost/127.0.0.1, so the app must always load over
 * http — never file://.
 *
 * Packaged: the supervisor's WebHost serves the built SPA on the hub port
 * and injects window.__ATELIER_HUB__; resolution for that mode lands with
 * the packaged backend launcher.
 */
export function resolveStartUrl(): string | null {
  const devUrl = process.env.ATELIER_DEV_URL;
  if (devUrl) return devUrl;
  return null;
}
