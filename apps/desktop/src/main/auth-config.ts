import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface AuthConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export const AUTH_PROTOCOL = "atelier";

/**
 * Deep-link callback. No longer what OAuth redirects to — a browser cannot
 * render a custom scheme, which is what left the sign-in tab stranded on a
 * dead page. Kept registered so links already in flight still resolve.
 */
export const AUTH_REDIRECT_URL = `${AUTH_PROTOCOL}://auth-callback`;

/** Loopback callback: a real HTTP page the browser can actually land on. */
export const LOOPBACK_HOST = "127.0.0.1";
export const AUTH_CALLBACK_PATH = "/auth-callback";

/**
 * Fixed, in preference order — NOT ephemeral. Every one of these has to be in
 * the Supabase project's allowed redirect URLs, so the set must be small,
 * stable and documented rather than whatever the OS hands out.
 */
export const LOOPBACK_PORTS = [53174, 53175, 53176] as const;

/**
 * Supabase credentials live in an untracked local file, never in the repo.
 * Dev reads apps/desktop/auth.local.json (next to package.json); a packaged
 * app reads auth.json from resources. The anon (publishable) key is not a
 * secret in the browser sense, but keeping it out of git keeps the project
 * swappable per machine.
 */
export function loadAuthConfig(): AuthConfig | null {
  // Derived from the bundle location, not app.getAppPath(): running
  // `electron dist/main.cjs` makes getAppPath() the dist/ folder, so the
  // config next to package.json was never found.
  const file = app.isPackaged
    ? path.join(process.resourcesPath, "auth.json")
    : path.join(__dirname, "..", "auth.local.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as AuthConfig;
    if (!raw.supabaseUrl || !raw.supabaseAnonKey) {
      console.error(`[auth] ${file} is missing supabaseUrl/supabaseAnonKey`);
      return null;
    }
    if (raw.supabaseUrl.includes("YOUR-PROJECT")) {
      console.error(`[auth] ${file} still holds the example placeholder`);
      return null;
    }
    return raw;
  } catch (error) {
    console.error(
      `[auth] no Supabase config at ${file} — sign-in is unavailable ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}
