import fs from "node:fs";
import path from "node:path";

/**
 * Dev: ATELIER_DEV_URL points at the Vite dev server (http://localhost:517x),
 * started by the existing root scripts/dev.mjs; the backend is owned by that
 * runner. The WS bridge's Origin allowlist accepts localhost/127.0.0.1, so
 * the app must always load over http — never file://.
 */
export function devUrl(): string | null {
  return process.env.ATELIER_DEV_URL ?? null;
}

/**
 * Packaged: the supervisor's WebHost serves the built SPA on the hub port
 * and injects window.__ATELIER_HUB__ — the exact URL `atelier run` opens.
 * A directory argument (e.g. "Atelier.exe C:\\proj") becomes ?open=<path>,
 * feeding the same projects.add bootstrap as the CLI.
 */
export function hubUrl(hubPort: number, openPath: string | null): string {
  const base = `http://127.0.0.1:${hubPort}/`;
  return openPath ? `${base}?open=${encodeURIComponent(openPath)}` : base;
}

/** First CLI argument that is an existing directory, if any. */
export function workspaceFromArgv(argv: string[]): string | null {
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("-")) continue;
    try {
      const resolved = path.resolve(arg);
      if (fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // not a path — ignore
    }
  }
  return null;
}
