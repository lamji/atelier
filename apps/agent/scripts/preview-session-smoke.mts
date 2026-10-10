/**
 * Runtime smoke for the Page preview session bridge.
 *
 * Serves an auth-gated app that behaves like the real thing: the server
 * bounces a cookieless request to /auth, and the app itself bounces again on
 * the client when its token is missing from localStorage. The REAL registered
 * preview_review impl is driven against it twice — once with no published
 * session, once with the session a signed-in Page preview would publish — so
 * the difference between "audited the login screen" and "audited the
 * requested route" is proved, not assumed.
 *
 *   cd apps/agent && pnpm exec tsx scripts/preview-session-smoke.mts
 */
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  registerPreviewReviewTools,
  shutdownPreviewReviewBrowser,
} from "../src/tools/preview-review-tools.js";
import { PreviewSessionStore } from "../src/preview/preview-session-store.js";
import type { ToolContext, ToolImpl, ToolRegistry } from "../src/tools/registry.js";

const SESSION_COOKIE = "smoke_session";
const TOKEN_KEY = "smoke-token";
const FLAG_KEY = "smoke-flag";
const ROUTE = "/workspace?section=ChargebackAndReport2";

const AUTH_PAGE = `<!doctype html><html><head><title>Sign in</title></head><body>
<h1>Sign In</h1><p>Continue with Google / Email / Password</p>
</body></html>`;

const APP_PAGE = `<!doctype html><html><head><title>Workspace</title></head><body>
<h1 id="screen">Loading…</h1>
<p id="flag"></p>
<script>
  // The client-side half of the gate: a real SPA reads its token from web
  // storage, so a cookie alone is not enough to stay on the route.
  if (!localStorage.getItem(${JSON.stringify(TOKEN_KEY)})) {
    location.replace('/auth');
  } else {
    setTimeout(function () {
      document.getElementById('screen').textContent = 'Chargeback by Billing Account';
      document.getElementById('flag').textContent =
        'flag=' + (sessionStorage.getItem(${JSON.stringify(FLAG_KEY)}) || 'none');
    }, 300);
  }
</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/auth") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(AUTH_PAGE);
    return;
  }
  const cookies = req.headers.cookie ?? "";
  if (!cookies.includes(`${SESSION_COOKIE}=ok`)) {
    res.writeHead(302, { location: "/auth" });
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(APP_PAGE);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };
const origin = `http://127.0.0.1:${port}`;
const url = `${origin}${ROUTE}`;

const outRoot = await mkdtemp(path.join(process.cwd(), "preview-session-smoke-"));
const sessions = new PreviewSessionStore();
let impl: ToolImpl | null = null;
const registry = {
  register: (name: string, tool: ToolImpl) => {
    if (name === "preview_review") impl = tool;
  },
} as unknown as ToolRegistry;
registerPreviewReviewTools(registry, outRoot, sessions);
if (!impl) throw new Error("preview_review was not registered");

const ctx: ToolContext = {
  taskId: "smoke",
  signal: new AbortController().signal,
  emitOutput: (chunk) => process.stdout.write(`  [tool] ${chunk}`),
};

interface Review {
  status: string;
  decision: string;
  browser: string;
  routeReached: boolean;
  previewSession: { applied: boolean };
  viewports: Array<{
    name: string;
    url: string;
    reachedRequestedRoute: boolean;
    audit: { title: string; headings: string[]; text: string };
  }>;
}

let failed = false;
const check = (ok: boolean, message: string): void => {
  if (ok) {
    console.log(`  ok: ${message}`);
    return;
  }
  failed = true;
  console.error(`  FAIL: ${message}`);
};

try {
  console.log("\n[1] signed out — no session published");
  const signedOut = (await (impl as ToolImpl)({ url }, ctx)) as Review;
  console.log(`  browser: ${signedOut.browser}`);
  for (const view of signedOut.viewports) {
    console.log(`  ${view.name}: ${view.url} — ${view.audit.title}`);
  }
  check(signedOut.routeReached === false, "the audit reports it never reached the route");
  check(signedOut.status === "off-route", `status is off-route (got ${signedOut.status})`);
  check(
    signedOut.decision === "report-route-not-reached-and-fail",
    `decision fails the review (got ${signedOut.decision})`
  );
  check(
    signedOut.previewSession.applied === false,
    "previewSession.applied is false when nothing was published"
  );
  check(
    signedOut.viewports.every((view) => view.url.endsWith("/auth")),
    "both viewports landed on the login redirect"
  );

  console.log("\n[2] signed in — the Page preview session is published");
  const stored = sessions.set({
    url,
    origin,
    cookies: [
      {
        name: SESSION_COOKIE,
        value: "ok",
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    localStorage: [{ name: TOKEN_KEY, value: "token-value" }],
    sessionStorage: [{ name: FLAG_KEY, value: "seeded" }],
    capturedAt: Date.now(),
  });
  check(stored === null, `the session was accepted${stored ? ` (${stored})` : ""}`);

  const signedIn = (await (impl as ToolImpl)({ url }, ctx)) as Review;
  console.log(`  browser: ${signedIn.browser}`);
  for (const view of signedIn.viewports) {
    console.log(`  ${view.name}: ${view.url} — ${JSON.stringify(view.audit.headings)}`);
  }
  check(signedIn.routeReached === true, "the audit reached the requested route");
  check(signedIn.status !== "off-route", `status is not off-route (got ${signedIn.status})`);
  check(
    signedIn.previewSession.applied === true,
    "previewSession.applied reports the reused session"
  );
  check(
    signedIn.viewports.every((view) =>
      view.audit.headings.some((heading) =>
        heading.includes("Chargeback by Billing Account")
      )
    ),
    "the gated screen rendered at both viewports"
  );
  check(
    signedIn.viewports.every((view) => view.audit.text.includes("flag=seeded")),
    "sessionStorage was seeded before the app booted"
  );
  check(
    signedIn.browser.includes("warm"),
    "the second review reused the warm browser instead of relaunching"
  );
  check(
    signedIn.browser.includes("signed-in Page preview session"),
    "the browser line names the reused session"
  );

  console.log("\n[3] an expired session is not reused");
  const expired = new PreviewSessionStore(0);
  expired.set({
    url,
    origin,
    cookies: [],
    localStorage: [{ name: TOKEN_KEY, value: "token-value" }],
    sessionStorage: [],
    capturedAt: Date.now() - 1,
  });
  check(expired.get(url) === null, "a session past its TTL is dropped");
  check(
    new PreviewSessionStore().set({
      url: "https://example.com/app",
      origin: "https://example.com",
      cookies: [],
      localStorage: [],
      sessionStorage: [],
      capturedAt: Date.now(),
    }) !== null,
    "a remote origin is refused"
  );
} catch (error) {
  failed = true;
  console.error("FAIL:", error);
} finally {
  await shutdownPreviewReviewBrowser();
  await rm(outRoot, { recursive: true, force: true });
  if (server.listening) server.close();
}
console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(failed ? 1 : 0);
