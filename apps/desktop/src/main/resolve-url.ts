import path from "node:path";

/**
 * Dev: ATELIER_DEV_URL points at the Vite dev server. Packaged: the built
 * SPA is loaded straight from resources over file:// — with the WS bridge
 * gone there is no Origin constraint, and the renderer uses a hash router
 * so file:// navigation works.
 */
export function devUrl(): string | null {
  return process.env.ATELIER_DEV_URL ?? null;
}

/** Packaged SPA entry (loaded with win.loadFile). ATELIER_WEB_DIST lets a
 *  dry-run test a staged build without an installer. */
export function packagedIndexHtml(): string {
  const dist =
    process.env.ATELIER_WEB_DIST ?? path.join(process.resourcesPath, "web");
  return path.join(dist, "index.html");
}
