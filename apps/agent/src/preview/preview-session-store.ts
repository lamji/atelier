/**
 * Holds the signed-in Page preview session for the review browser.
 *
 * The renderer lifts cookies and web storage out of the in-app preview
 * iframe and publishes them here; `preview_review` then opens its headless
 * context with that state, so the audit lands on the requested route instead
 * of the app's login redirect.
 *
 * Everything in here is credential material:
 *  - it lives in memory only, never on disk and never in a transcript;
 *  - it expires, so a snapshot cannot outlive the review it was taken for;
 *  - `summary()` is the only shape allowed near a tool result or a log.
 */

export interface PreviewSessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface PreviewStorageEntry {
  name: string;
  value: string;
}

export interface PreviewSession {
  url: string;
  origin: string;
  cookies: PreviewSessionCookie[];
  localStorage: PreviewStorageEntry[];
  sessionStorage: PreviewStorageEntry[];
  capturedAt: number;
}

/** Non-secret description of a held session, safe to show the model. */
export interface PreviewSessionSummary {
  origin: string;
  url: string;
  cookies: number;
  localStorage: number;
  sessionStorage: number;
  capturedAt: number;
  ageMs: number;
}

/**
 * A review starts seconds after the snapshot is taken. Fifteen minutes is
 * generous for a queued task and still short enough that a forgotten
 * snapshot is gone long before the tokens in it are interesting.
 */
const DEFAULT_TTL_MS = 15 * 60_000;

function sameOrigin(value: string, origin: string): boolean {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

function localOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    return local && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

export class PreviewSessionStore {
  private sessions = new Map<string, PreviewSession>();

  constructor(
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * @returns the reason a snapshot was refused, or null when it was stored.
   */
  set(session: PreviewSession): string | null {
    if (!localOrigin(session.origin)) {
      return "preview sessions are only accepted for local preview origins";
    }
    if (!sameOrigin(session.url, session.origin)) {
      return "the preview URL does not belong to the declared origin";
    }
    this.sessions.set(session.origin, {
      ...session,
      capturedAt: Number.isFinite(session.capturedAt)
        ? session.capturedAt
        : this.now(),
    });
    return null;
  }

  /** The session for a URL's origin, or null when absent or expired. */
  get(url: string): PreviewSession | null {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return null;
    }
    const session = this.sessions.get(origin);
    if (!session) return null;
    if (this.now() - session.capturedAt > this.ttlMs) {
      this.sessions.delete(origin);
      return null;
    }
    return session;
  }

  /**
   * The most recently captured session that has not expired.
   *
   * Keyed lookups answer "what is the session FOR this origin", which is
   * right for reviewing a page. Replaying an API call is the other
   * question: the UI on :8080 and the API on :5055 are different origins,
   * and the session belongs to the browser rather than to one port of it.
   */
  latest(): PreviewSession | null {
    let newest: PreviewSession | null = null;
    for (const [origin, session] of this.sessions) {
      if (this.now() - session.capturedAt > this.ttlMs) {
        this.sessions.delete(origin);
        continue;
      }
      if (!newest || session.capturedAt > newest.capturedAt) newest = session;
    }
    return newest;
  }

  summary(url: string): PreviewSessionSummary | null {
    const session = this.get(url);
    if (!session) return null;
    return {
      origin: session.origin,
      url: session.url,
      cookies: session.cookies.length,
      localStorage: session.localStorage.length,
      sessionStorage: session.sessionStorage.length,
      capturedAt: session.capturedAt,
      ageMs: this.now() - session.capturedAt,
    };
  }

  /** Drops one origin, or every held session when none is named. */
  clear(origin?: string): boolean {
    if (!origin) {
      const had = this.sessions.size > 0;
      this.sessions.clear();
      return had;
    }
    return this.sessions.delete(origin);
  }
}
