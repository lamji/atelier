/**
 * Supabase auth (Google OAuth via the system browser + atelier:// deep link).
 *
 * The supabase client lives in the MAIN process so the PKCE code verifier
 * and the session survive between "open browser" and the deep-link callback,
 * and so tokens are stored with safeStorage instead of renderer storage.
 * Ported from agent-deck's proven implementation.
 */
import fs from "node:fs";
import path from "node:path";
import { app, safeStorage, shell } from "electron";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
// Electron 34 ships Node 20, which has no global WebSocket — supabase-js's
// realtime client refuses to construct without one, so hand it `ws`.
import WebSocketImpl from "ws";
import { loadAuthConfig } from "./auth-config";
import {
  candidateRedirectUrls,
  startCallbackServer,
  stopCallbackServer,
} from "./auth-server";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  avatar?: string;
}

export type AuthChangedPayload = { user: AuthUser | null; error?: string };

type AuthListener = (payload: AuthChangedPayload) => void;

let client: SupabaseClient | null = null;
const listeners = new Set<AuthListener>();

const config = { value: null as ReturnType<typeof loadAuthConfig> };

/** True when a Supabase project is configured; false disables the gate. */
export function authConfigured(): boolean {
  if (config.value === null) config.value = loadAuthConfig();
  return config.value !== null;
}

// ---- encrypted single-file storage (userData/session.bin) ----
// supabase-js persists the session AND the PKCE verifier through this
// adapter; it must be file-backed or the verifier dies with the process
// between startLogin() and the browser's deep-link callback.

function storeFile(): string {
  return path.join(app.getPath("userData"), "session.bin");
}

function loadStore(): Record<string, string> {
  try {
    const raw = fs.readFileSync(storeFile());
    const txt = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString("utf8");
    return JSON.parse(txt) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveStore(obj: Record<string, string>): void {
  try {
    const txt = JSON.stringify(obj);
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(txt)
      : Buffer.from(txt, "utf8");
    fs.writeFileSync(storeFile(), data);
  } catch (error) {
    console.error("auth: session store write failed:", error);
  }
}

const storageAdapter = {
  getItem: (key: string): string | null => loadStore()[key] ?? null,
  setItem: (key: string, value: string): void => {
    const s = loadStore();
    s[key] = value;
    saveStore(s);
  },
  removeItem: (key: string): void => {
    const s = loadStore();
    delete s[key];
    saveStore(s);
  },
};

function sb(): SupabaseClient {
  if (!client) {
    if (!authConfigured() || !config.value) {
      throw new Error("auth: Supabase is not configured");
    }
    client = createClient(config.value.supabaseUrl, config.value.supabaseAnonKey, {
      auth: {
        flowType: "pkce",
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storage: storageAdapter,
      },
      realtime: {
        transport: WebSocketImpl as unknown as typeof WebSocket,
      },
    });
  }
  return client;
}

function sessionUser(session: {
  user: {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };
} | null): AuthUser | null {
  if (!session?.user) return null;
  const meta = session.user.user_metadata ?? {};
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const email = session.user.email ?? "";
  return {
    id: session.user.id,
    email,
    name: str(meta.full_name) ?? str(meta.name) ?? email,
    avatar: str(meta.avatar_url) ?? str(meta.picture),
  };
}

function emit(payload: AuthChangedPayload): void {
  for (const listener of listeners) listener(payload);
}

/** Subscribe to login/logout results; returns an unsubscribe fn. */
export function onAuthChanged(listener: AuthListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Current user, or null. The getSession call is raced against a timeout so
 * app boot never hangs on a slow token refresh.
 */
export async function getSession(): Promise<AuthUser | null> {
  if (!authConfigured()) return null;
  try {
    const result = await Promise.race([
      sb().auth.getSession(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("auth timeout")), 5000)
      ),
    ]);
    return sessionUser(result.data.session);
  } catch {
    return null;
  }
}

/**
 * Exchange an authorization code for a session. Shared by both callback
 * routes — the loopback page and the atelier:// deep link — so a code lands
 * the same way whichever one delivered it.
 */
async function completeLogin(code: string): Promise<void> {
  try {
    const { data, error } = await sb().auth.exchangeCodeForSession(code);
    if (error) {
      emit({ user: null, error: error.message });
      return;
    }
    emit({ user: sessionUser(data.session) });
  } catch (error) {
    emit({
      user: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The message a user needs when Supabase silently refuses our redirect. It
 * does not error — it quietly falls back to the project's Site URL, so the
 * browser lands somewhere else entirely and our callback is never hit. Naming
 * the exact URLs to allow-list is the only way that is diagnosable.
 */
function redirectNotAllowedHint(): string {
  return (
    "The browser never came back. Add these to your Supabase project under " +
    "Authentication → URL Configuration → Redirect URLs, then try again: " +
    candidateRedirectUrls().join(" , ")
  );
}

/**
 * Kick off Google OAuth in the system browser, with a loopback page as the
 * landing spot so the tab ends on something real instead of a dead
 * custom-scheme navigation.
 */
export async function startLogin(): Promise<{ ok: boolean; error?: string }> {
  if (!authConfigured()) {
    return { ok: false, error: "Supabase is not configured" };
  }
  try {
    const { redirectUrl } = await startCallbackServer((result) => {
      if (result.errorDescription) {
        emit({ user: null, error: result.errorDescription });
        return;
      }
      if (result.code) void completeLogin(result.code);
    });

    const { data, error } = await sb().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: redirectUrl, skipBrowserRedirect: true },
    });
    if (error || !data?.url) {
      stopCallbackServer();
      return { ok: false, error: error?.message ?? "no auth url" };
    }
    void shell.openExternal(data.url);
    return { ok: true };
  } catch (error) {
    stopCallbackServer();
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The hint text the renderer shows if a sign-in attempt never lands. */
export function loginTroubleshootHint(): string {
  return redirectNotAllowedHint();
}

/**
 * Handle the atelier://auth-callback?code=… deep link. No longer the primary
 * route (see auth-server.ts) but still wired: a link already in flight, or an
 * older build's redirect, must still sign the user in.
 */
export async function handleDeepLink(url: string): Promise<void> {
  if (!authConfigured()) return;
  let code: string | null = null;
  let errorDescription: string | null = null;
  try {
    const parsed = new URL(url);
    code = parsed.searchParams.get("code");
    errorDescription = parsed.searchParams.get("error_description");
  } catch {
    return;
  }
  if (errorDescription) {
    emit({ user: null, error: errorDescription });
    return;
  }
  if (!code) return;
  // A deep link means the loopback page is not going to be visited.
  stopCallbackServer();
  await completeLogin(code);
}

export async function logout(): Promise<void> {
  // A sign-in half in flight must not complete into the session we are about
  // to clear.
  stopCallbackServer();
  try {
    if (client) await client.auth.signOut();
  } catch {
    // local cleanup below is what actually matters
  }
  fs.rmSync(storeFile(), { force: true });
  client = null; // next call builds a fresh client with empty storage
  emit({ user: null });
}
