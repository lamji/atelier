/**
 * Runtime smoke for /context_mock_api.
 *
 * Serves the endpoint that produced the reported failure: it answers
 * `401 {"error":"Missing authorization header"}` to an anonymous caller and
 * returns real data to a bearer token. The command is driven against it
 * twice — once with no published Page preview session (the old behaviour,
 * which is all the headless preview could ever manage after it redirected
 * to /auth) and once with the session the in-app browser publishes.
 *
 *   cd apps/agent && pnpm exec tsx scripts/mock-api-smoke.mts
 */
import { createServer } from "node:http";
import { PreviewSessionStore } from "../src/preview/preview-session-store.js";
import {
  bearerFrom,
  cookieHeaderFor,
  localApiUrl,
  runMockApi,
} from "../src/preview/mock-api.js";
import {
  parseMockApiCommand,
  renderMockApiReport,
} from "../src/preview/mock-api-command.js";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl";
const ACCOUNT = "01F185-0AA423-C9BA8A";

let failed = false;
const check = (ok: boolean, message: string): void => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${message}`);
  if (!ok) failed = true;
};

/** What each request actually carried, so the headers are observable. */
const seen: Array<{ auth: string; cookie: string; method: string }> = [];

const server = createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  seen.push({
    auth,
    cookie: req.headers.cookie ?? "",
    method: req.method ?? "",
  });
  res.setHeader("content-type", "application/json");
  res.setHeader("set-cookie", "server_session=should-not-be-printed");
  if (!auth) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Missing authorization header" }));
    return;
  }
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }
  res.writeHead(200);
  res.end(
    JSON.stringify({ budgets: [{ id: "b1", billing_account: ACCOUNT }] })
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };
const API = `http://127.0.0.1:${port}/api/v1/budgets?billing_accounts=${ACCOUNT}&billing_mode=usage`;

try {
  console.log("\n[1] the command line is read the way it is typed");
  const bare = parseMockApiCommand("/context_mock_api");
  check(bare?.request === null, "a bare command asks for usage");
  const simple = parseMockApiCommand(`/context_mock_api ${API}`);
  check(
    simple?.request?.method === "GET" && simple.request.url === API,
    "a lone URL is a GET"
  );
  const posted = parseMockApiCommand(
    `/context_mock_api POST ${API} {"name":"test"}`
  );
  check(
    posted?.request?.method === "POST" &&
      posted.request.body === '{"name":"test"}',
    "a leading method and a trailing JSON body are both read"
  );
  const noted = parseMockApiCommand(`/context_mock_api ${API} login`);
  check(noted?.request?.note === "login", "trailing free text becomes context");
  check(
    parseMockApiCommand("/context-mock-api " + API)?.request?.url === API,
    "the hyphen spelling is the same command"
  );
  check(
    parseMockApiCommand("what does /context_mock_api do?") === undefined,
    "the parser does not fire mid-sentence"
  );
  check(
    parseMockApiCommand(`/context_mock_api ${API}\nCURRENT PAGE PREVIEW\nURL: x`)
      ?.request?.url === API,
    "the hidden preview block after the command is not parsed as arguments"
  );
  check(
    parseMockApiCommand("/context_mock_api budgets")?.request === null,
    "a bare word is refused with a problem, not sent as a URL"
  );

  console.log("\n[2] only local services can be replayed");
  let refused = false;
  try {
    localApiUrl("https://api.stripe.com/v1/charges");
  } catch {
    refused = true;
  }
  check(refused, "a remote host is refused");

  console.log("\n[3] no session — the reported 401, reproduced");
  const empty = new PreviewSessionStore();
  seen.length = 0;
  const anonymous = await runMockApi(
    { url: API, method: "GET" },
    empty
  );
  check(anonymous.status === 401, `HTTP 401 without a session`);
  check(
    anonymous.body.includes("Missing authorization header"),
    "the body is the exact error from the report"
  );
  check(seen[0]?.auth === "", "no Authorization header was sent");
  const anonymousReport = renderMockApiReport(anonymous);
  check(
    anonymousReport.includes("no signed-in Page preview session"),
    "the report says WHY, instead of blaming the endpoint"
  );

  console.log("\n[4] with the in-app browser's session — the real answer");
  const sessions = new PreviewSessionStore();
  // The UI runs on another port entirely; the session still applies.
  sessions.set({
    url: "http://localhost:8080/workspace?section=BudgetsAndAlerts",
    origin: "http://localhost:8080",
    cookies: [
      {
        name: "sb-refresh",
        value: "refresh-value",
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
      {
        name: "elsewhere",
        value: "no",
        domain: "example.com",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ],
    localStorage: [{ name: "access_token", value: TOKEN }],
    sessionStorage: [],
    capturedAt: Date.now(),
  });
  seen.length = 0;
  const signedIn = await runMockApi({ url: API, method: "GET" }, sessions);
  check(signedIn.status === 200, `HTTP 200 with the preview session`);
  check(
    signedIn.body.includes(ACCOUNT),
    "the endpoint returned the signed-in user's data"
  );
  check(
    seen[0]?.auth === `Bearer ${TOKEN}`,
    "the browser's own bearer token was sent"
  );
  check(
    seen[0]?.cookie === "sb-refresh=refresh-value",
    "host-matching cookies rode along; a foreign-domain cookie did not"
  );
  check(
    signedIn.authOrigin === "localStorage.access_token",
    "the report names where the token came from"
  );

  const report = renderMockApiReport(signedIn);
  check(!report.includes(TOKEN), "the token is never printed in the report");
  check(
    !report.includes("should-not-be-printed"),
    "a Set-Cookie in the response is redacted"
  );
  check(
    report.includes("HTTP 200"),
    "the report leads with the status"
  );

  console.log("\n[5] tokens are found however the app stores them");
  const shapes: Array<[string, { name: string; value: string }]> = [
    ["a plain key", { name: "access_token", value: TOKEN }],
    ["camelCase", { name: "accessToken", value: TOKEN }],
    [
      "a Supabase envelope",
      {
        name: "sb-abcdef-auth-token",
        value: JSON.stringify({ access_token: TOKEN, token_type: "bearer" }),
      },
    ],
    [
      "a nested envelope",
      {
        name: "supabase.auth.session",
        value: JSON.stringify({ currentSession: { access_token: TOKEN } }),
      },
    ],
    ["an unguessable key", { name: "df_creds_v2", value: TOKEN }],
  ];
  for (const [label, entry] of shapes) {
    const found = bearerFrom({
      url: "http://localhost:8080/",
      origin: "http://localhost:8080",
      cookies: [],
      localStorage: [entry],
      sessionStorage: [],
      capturedAt: Date.now(),
    });
    check(found?.token === TOKEN, `${label} is read`);
  }

  const noToken = bearerFrom({
    url: "http://localhost:8080/",
    origin: "http://localhost:8080",
    cookies: [],
    localStorage: [{ name: "theme", value: "dark" }],
    sessionStorage: [],
    capturedAt: Date.now(),
  });
  check(noToken === null, "a store with no token yields none, not a guess");

  const cookieOnly = cookieHeaderFor(
    {
      url: "http://localhost:8080/",
      origin: "http://localhost:8080",
      cookies: [
        {
          name: "a",
          value: "1",
          domain: "localhost",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      localStorage: [],
      sessionStorage: [],
      capturedAt: Date.now(),
    },
    new URL("http://localhost:5055/api/v1/budgets")
  );
  check(
    cookieOnly === "a=1",
    "a localhost cookie reaches another localhost port, as in a browser"
  );
} catch (error) {
  failed = true;
  console.error("FAIL:", error);
} finally {
  // fetch keeps its sockets alive, so the server has live connections here.
  // Dropping them before close is what lets the loop drain instead of
  // aborting inside libuv when the process exits under them.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exitCode = failed ? 1 : 0;
