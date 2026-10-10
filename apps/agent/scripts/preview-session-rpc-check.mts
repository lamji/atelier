/**
 * Checks the renderer -> agent hop of the preview session bridge: the
 * protocol schema, the router dispatch and the store, wired exactly as the
 * runtime wires them.
 *
 *   cd apps/agent && pnpm exec tsx scripts/preview-session-rpc-check.mts
 */
import { Router } from "../src/bridge/router.js";
import { PreviewSessionStore } from "../src/preview/preview-session-store.js";
import { registerPreviewHandlers } from "../src/preview/register-preview-handlers.js";

const sessions = new PreviewSessionStore();
const router = new Router();
registerPreviewHandlers(router, sessions);

const ctx = {
  connectionId: "check",
  authenticated: true,
  progress: () => undefined,
  signal: new AbortController().signal,
};

let failed = false;
const check = (ok: boolean, message: string): void => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${message}`);
  if (!ok) failed = true;
};

const payload = {
  url: "http://localhost:8080/workspace?section=Chargeback",
  origin: "http://localhost:8080",
  cookies: [
    {
      name: "sb-access-token",
      value: "token",
      domain: "localhost",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ],
  localStorage: [{ name: "sb-auth", value: "{}" }],
  sessionStorage: [],
  capturedAt: Date.now(),
};

const set = (await router.dispatch("preview.session.set", payload, ctx)) as {
  accepted: boolean;
};
check(set.accepted === true, "a local session is accepted through the router");
check(
  sessions.get(payload.url)?.cookies.length === 1,
  "the store holds the published cookie"
);

const remote = (await router.dispatch(
  "preview.session.set",
  { ...payload, url: "https://example.com/app", origin: "https://example.com" },
  ctx
)) as { accepted: boolean; reason?: string };
check(remote.accepted === false, `a remote origin is refused (${remote.reason})`);

const cleared = (await router.dispatch(
  "preview.session.clear",
  { origin: payload.origin },
  ctx
)) as { cleared: boolean };
check(cleared.cleared === true, "clear drops the held session");
check(sessions.get(payload.url) === null, "the store is empty afterwards");

try {
  await router.dispatch(
    "preview.session.set",
    { ...payload, cookies: [{ name: "bad" }] },
    ctx
  );
  check(false, "a malformed cookie is rejected by the schema");
} catch {
  check(true, "a malformed cookie is rejected by the schema");
}

console.log(failed ? "\nCHECK FAILED" : "\nCHECK OK");
process.exit(failed ? 1 : 0);
