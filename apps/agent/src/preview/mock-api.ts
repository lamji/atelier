import type {
  PreviewSession,
  PreviewSessionStore,
  PreviewStorageEntry,
} from "./preview-session-store.js";

/**
 * Replays one API call exactly as the signed-in app would make it.
 *
 * The problem this exists for: asked to check an endpoint, the agent had no
 * way to be the logged-in user. It reached for the headless preview, which
 * redirected to /auth, so there was no `access_token` to send — and every
 * mimicked call came back `401 {"error":"Missing authorization header"}`,
 * which says nothing about the endpoint under test. The in-app browser is
 * signed in the whole time; the preview-session bridge already carries its
 * cookies and web storage into the agent, and this spends them.
 *
 * Read-only in spirit but not in enforcement: the caller names the method,
 * because "does this POST 401 or 422?" is the question being asked. It is
 * confined to local origins, the same boundary preview_review holds.
 */

/** Storage keys that hold a bearer token outright, in order of confidence. */
const DIRECT_TOKEN_KEYS = [
  "access_token",
  "accessToken",
  "authToken",
  "auth_token",
  "id_token",
  "idToken",
  "token",
  "jwt",
];

/** Keys whose VALUE is a JSON envelope with the token inside. */
const ENVELOPE_KEY = /^(sb-.*-auth-token|.*auth.*|.*session.*)$/i;

/** Fields to dig for inside such an envelope. */
const ENVELOPE_FIELDS = ["access_token", "accessToken", "token", "jwt"];

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_CHARS = 4_000;

export type MockApiMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface MockApiRequest {
  url: string;
  method: MockApiMethod;
  /** Raw request body, already a string; JSON is sent as-is. */
  body?: string;
  /** What the user said the call is about — "login", "signup", free text. */
  note?: string;
}

/** Where a token came from, safe to print. The token itself never is. */
export interface AuthSource {
  token: string;
  /** e.g. `localStorage.access_token` or `localStorage.sb-x-auth-token`. */
  origin: string;
}

export interface MockApiResult {
  request: MockApiRequest;
  /** Non-secret description of the credential used, or null. */
  authOrigin: string | null;
  cookiesSent: number;
  status: number | null;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
  truncated: boolean;
  durationMs: number;
  /** Transport-level failure — the request never got an answer. */
  error?: string;
  /** The preview session used, for the report's provenance line. */
  session: { origin: string; url: string; ageMs: number } | null;
}

/** Only local services, matching the boundary preview_review enforces. */
export function localApiUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "A full URL is required, for example " +
        "http://localhost:5055/api/v1/budgets"
    );
  }
  const local =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (!local || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(
      "Only local http(s) URLs can be mimicked — this replays the signed-in " +
        "preview session, which belongs to a service running on this machine."
    );
  }
  return url;
}

/**
 * Pulls a bearer token out of the preview's web storage.
 *
 * Apps store it three ways and all three appear in practice: the raw JWT
 * under a plain key, a JSON envelope (Supabase writes `sb-<ref>-auth-token`
 * holding the whole session), or a JWT under some key nobody would guess.
 * The last resort scans values rather than names, because a token that is
 * plainly a JWT is a token whatever it is filed under.
 */
export function bearerFrom(session: PreviewSession): AuthSource | null {
  const stores: Array<[string, PreviewStorageEntry[]]> = [
    ["localStorage", session.localStorage],
    ["sessionStorage", session.sessionStorage],
  ];

  for (const [storeName, entries] of stores) {
    const byName = new Map(entries.map((entry) => [entry.name, entry.value]));
    for (const key of DIRECT_TOKEN_KEYS) {
      const value = byName.get(key)?.trim();
      if (value && !value.startsWith("{")) {
        return { token: value, origin: `${storeName}.${key}` };
      }
    }
  }

  for (const [storeName, entries] of stores) {
    for (const entry of entries) {
      if (!ENVELOPE_KEY.test(entry.name)) continue;
      const found = fromEnvelope(entry.value);
      if (found) return { token: found, origin: `${storeName}.${entry.name}` };
    }
  }

  for (const [storeName, entries] of stores) {
    for (const entry of entries) {
      if (JWT.test(entry.value.trim())) {
        return {
          token: entry.value.trim(),
          origin: `${storeName}.${entry.name}`,
        };
      }
    }
  }
  return null;
}

/** Digs a token out of a stored JSON session envelope, one level deep. */
function fromEnvelope(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Supabase has shipped both a bare object and a [session, ...] tuple.
  const roots = Array.isArray(parsed) ? parsed : [parsed];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    const record = root as Record<string, unknown>;
    for (const field of ENVELOPE_FIELDS) {
      const value = record[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    for (const nested of ["currentSession", "session", "data", "user"]) {
      const child = record[nested];
      if (!child || typeof child !== "object") continue;
      const childRecord = child as Record<string, unknown>;
      for (const field of ENVELOPE_FIELDS) {
        const value = childRecord[field];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }
  return null;
}

/**
 * The Cookie header the browser would send to this URL.
 *
 * Host-only matching, and deliberately port-blind: a cookie set by the UI on
 * localhost:8080 really is sent to an API on localhost:5055, because cookies
 * are not scoped by port. Reproducing that is the entire point.
 */
export function cookieHeaderFor(session: PreviewSession, target: URL): string {
  const host = target.hostname.toLowerCase();
  const matched = session.cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, "").toLowerCase();
    if (!domain) return false;
    if (host === domain) return true;
    return host.endsWith(`.${domain}`);
  });
  return matched.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/**
 * Runs the call.
 *
 * `sessions.latest()` rather than a lookup by the API's own origin: the UI
 * and its API routinely sit on different ports, and the session belongs to
 * the browser, not to one port of it.
 */
export async function runMockApi(
  request: MockApiRequest,
  sessions: PreviewSessionStore
): Promise<MockApiResult> {
  const target = localApiUrl(request.url);
  const session = sessions.latest();
  const auth = session ? bearerFrom(session) : null;
  const cookieHeader = session ? cookieHeaderFor(session, target) : "";

  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
  };
  if (auth) headers["Authorization"] = `Bearer ${auth.token}`;
  if (cookieHeader) headers["Cookie"] = cookieHeader;
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  const base: MockApiResult = {
    request: { ...request, url: target.href },
    authOrigin: auth?.origin ?? null,
    cookiesSent: cookieHeader ? cookieHeader.split("; ").length : 0,
    status: null,
    statusText: "",
    headers: [],
    body: "",
    truncated: false,
    durationMs: 0,
    session: session
      ? {
          origin: session.origin,
          url: session.url,
          ageMs: Date.now() - session.capturedAt,
        }
      : null,
  };

  try {
    const response = await fetch(target.href, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "manual",
      signal: abort.signal,
    });
    const text = await response.text();
    return {
      ...base,
      status: response.status,
      statusText: response.statusText,
      headers: readableHeaders(response.headers),
      body: text.slice(0, MAX_BODY_CHARS),
      truncated: text.length > MAX_BODY_CHARS,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...base,
      durationMs: Date.now() - startedAt,
      error:
        abort.signal.aborted
          ? `No answer within ${REQUEST_TIMEOUT_MS / 1000}s`
          : error instanceof Error
            ? error.message
            : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Response headers worth printing.
 *
 * `set-cookie` is redacted rather than dropped: knowing the endpoint set a
 * session cookie is diagnostic, and printing its value would put a live
 * credential in the transcript.
 */
function readableHeaders(headers: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  headers.forEach((value, name) => {
    out.push([
      name,
      /^set-cookie$/i.test(name) ? "(redacted)" : value.slice(0, 300),
    ]);
  });
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}
