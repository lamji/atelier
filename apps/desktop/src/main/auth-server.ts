/**
 * Loopback OAuth callback.
 *
 * Why this exists: Supabase used to redirect straight to
 * `atelier://auth-callback`. The OS hands that to the app correctly, but a
 * browser cannot *render* a custom scheme — so the tab the sign-in happened
 * in was left stranded on a dead page forever. Every user finished signing in
 * and was then left staring at a broken tab.
 *
 * So the browser now lands on a real HTTP page this process serves. It shows a
 * branded "you're signed in" screen, tries to close itself, and hands the code
 * to the exchange. The `atelier://` deep link stays wired in protocol.ts as a
 * fallback for any link already in flight.
 *
 * Note on closing: a page can only call `window.close()` on a window that
 * script opened. This tab was opened by the OS, so browsers usually refuse.
 * The attempt is made because it works in some configurations, and the page is
 * written to read as finished either way rather than depending on it.
 */
import http from "node:http";
import { AUTH_CALLBACK_PATH, LOOPBACK_HOST, LOOPBACK_PORTS } from "./auth-config";

/** How long a started server waits for the browser before giving up. */
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

export interface CallbackResult {
  code?: string;
  errorDescription?: string;
}

type Server = {
  server: http.Server;
  port: number;
  redirectUrl: string;
  timer: NodeJS.Timeout;
};

let active: Server | null = null;

/** `http://127.0.0.1:<port>/auth-callback` for a given port. */
export function loopbackRedirectUrl(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}${AUTH_CALLBACK_PATH}`;
}

/** Every URL a user may need to allow-list, for error messages and docs. */
export function candidateRedirectUrls(): string[] {
  return LOOPBACK_PORTS.map(loopbackRedirectUrl);
}

function shutdown(): void {
  if (!active) return;
  clearTimeout(active.timer);
  active.server.close();
  active.server.closeAllConnections?.();
  active = null;
}

/** Bind the first port in LOOPBACK_PORTS that is free. */
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    let index = 0;
    const tryNext = (): void => {
      const port = LOOPBACK_PORTS[index];
      if (port === undefined) {
        reject(
          new Error(
            `no free loopback port for the sign-in callback (tried ` +
              `${LOOPBACK_PORTS.join(", ")})`,
          ),
        );
        return;
      }
      index += 1;
      server.once("error", (error: NodeJS.ErrnoException) => {
        // Only a taken port is worth retrying; anything else is a real fault.
        if (error.code === "EADDRINUSE") tryNext();
        else reject(error);
      });
      server.listen(port, LOOPBACK_HOST, () => resolve(port));
    };
    tryNext();
  });
}

/**
 * Start (or reuse) the callback server. `onResult` fires once, with the code
 * or the provider's error, as soon as the browser arrives. The server stops
 * itself immediately afterwards — it exists only for the duration of one
 * sign-in, so nothing is left listening on the user's machine.
 */
export async function startCallbackServer(
  onResult: (result: CallbackResult) => void,
): Promise<{ port: number; redirectUrl: string }> {
  // A second sign-in attempt replaces the first: the old PKCE verifier is
  // already superseded, so its pending callback is dead weight.
  shutdown();

  let settled = false;
  const settle = (result: CallbackResult): void => {
    if (settled) return;
    settled = true;
    onResult(result);
    // Let the response flush before tearing the socket down.
    setTimeout(shutdown, 250);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
    if (url.pathname !== AUTH_CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const code = url.searchParams.get("code") ?? undefined;
    const errorDescription =
      url.searchParams.get("error_description") ??
      url.searchParams.get("error") ??
      undefined;

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // This page echoes auth parameters; never let it sit in a cache.
      "cache-control": "no-store",
    });
    res.end(resultPage(code !== undefined && !errorDescription, errorDescription));
    settle({ code, errorDescription });
  });

  const port = await listen(server);
  const timer = setTimeout(() => {
    settle({ errorDescription: "Sign-in timed out waiting for the browser." });
  }, CALLBACK_TIMEOUT_MS);
  // The pending callback must never be the reason the app stays alive.
  timer.unref?.();

  active = { server, port, redirectUrl: loopbackRedirectUrl(port), timer };
  return { port, redirectUrl: active.redirectUrl };
}

/** Stop listening (used on logout and app teardown). */
export function stopCallbackServer(): void {
  shutdown();
}

/**
 * The page the user actually sees in their browser. Inlined and dependency
 * free — it is served before the app has any idea whether the exchange will
 * succeed, and it has to render with no network of its own.
 */
function resultPage(ok: boolean, errorDescription?: string): string {
  const title = ok ? "You're signed in" : "Sign-in didn't finish";
  const body = ok
    ? "Atelier is coming to the front. You can close this tab."
    : escapeHtml(errorDescription ?? "Something went wrong. Try again from Atelier.");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · Atelier</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #eef3f2; --card: #ffffff; --fg: #152527; --muted: #475f62;
    --brand: #224248; --line: #c7d4d1; --ok: #28734d; --bad: #a94444;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101718; --card: #19292b; --fg: #e7eeee; --muted: #aebfc1;
      --brand: #68aeb8; --line: #2d4144; --ok: #4fa879; --bad: #d66b6b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: var(--bg); color: var(--fg); padding: 24px;
    font: 14px/1.55 "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  .card {
    width: 100%; max-width: 380px; background: var(--card);
    border: 1px solid var(--line); border-radius: 10px;
    padding: 32px 28px; text-align: center;
  }
  .mark { width: 44px; height: 44px; margin: 0 auto 18px; display: block; }
  h1 { margin: 0 0 8px; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
  p { margin: 0; color: var(--muted); font-size: 13px; }
  .tag {
    display: inline-block; margin-bottom: 18px; padding: 3px 9px;
    border-radius: 999px; font-size: 11px; font-weight: 600;
    color: ${ok ? "var(--ok)" : "var(--bad)"};
    background: ${ok ? "rgba(79,168,121,.14)" : "rgba(214,107,107,.14)"};
  }
  .hint { margin-top: 20px; font-size: 11px; color: var(--muted); opacity: .75; }
</style>
</head>
<body>
  <main class="card">
    <svg class="mark" viewBox="0 0 512 512" aria-hidden="true">
      <defs>
        <linearGradient id="s" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#224248" />
          <stop offset="38%" stop-color="#35666e" />
          <stop offset="70%" stop-color="#68aeb8" />
          <stop offset="100%" stop-color="#9ad2d8" />
        </linearGradient>
      </defs>
      <path d="M 378.9 213.7 A 130 130 0 1 1 298.3 133.1" fill="none"
        stroke="url(#s)" stroke-width="52" stroke-linecap="round" />
      <circle cx="347.9" cy="164.1" r="27" fill="url(#s)" />
    </svg>
    <span class="tag">${ok ? "Signed in" : "Not signed in"}</span>
    <h1>${title}</h1>
    <p>${body}</p>
    <p class="hint">This tab is no longer needed.</p>
  </main>
  <script>
    // Only script-opened windows may be closed; this one was opened by the
    // OS, so the call is usually refused. Harmless when it is, and the page
    // already reads as finished without it.
    setTimeout(function () { try { window.close(); } catch (e) {} }, 600);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
