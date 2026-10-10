import type { MockApiMethod, MockApiRequest, MockApiResult } from "./mock-api.js";

export const MOCK_API_COMMAND_NAME = "context_mock_api";
export const MOCK_API_COMMAND_ID =
  "project:command:" + MOCK_API_COMMAND_NAME;

const METHODS: MockApiMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export interface MockApiCommand {
  /** Empty when the command arrived with no URL — the usage case. */
  request: MockApiRequest | null;
  /** Why the input could not be read, when it could not. */
  problem?: string;
}

/**
 * Returns undefined when the prompt is not the command.
 *
 * Accepted shapes, all one line:
 *   /context_mock_api <url>
 *   /context_mock_api POST <url>
 *   /context_mock_api POST <url> {"json":"body"}
 *   /context_mock_api <url> login
 *
 * Method first because that is how curl and every HTTP log write it. A
 * trailing `{`/`[` is a body; anything else trailing is free-text context —
 * "login", "signup", "the one the budgets page calls" — which is recorded
 * in the report so the answer says what it was answering.
 *
 * Only the first line is read: a send from the composer carries the hidden
 * page-preview block after it, and that must not be parsed as arguments.
 */
export function parseMockApiCommand(
  prompt: string
): MockApiCommand | undefined {
  const firstLine = prompt.trim().split(/\r?\n/, 1)[0] ?? "";
  const match = /^\/context[_-]mock[_-]api(?:\s+([^]*))?$/i.exec(
    firstLine.trim()
  );
  if (!match) return undefined;

  const rest = (match[1] ?? "").trim();
  if (!rest) return { request: null };

  const tokens = rest.split(/\s+/);
  let method: MockApiMethod = "GET";
  const head = (tokens[0] ?? "").toUpperCase() as MockApiMethod;
  if (METHODS.includes(head)) {
    method = head;
    tokens.shift();
  }

  const url = tokens.shift() ?? "";
  if (!url) {
    return {
      request: null,
      problem: "No URL followed the method.",
    };
  }
  if (!/^https?:\/\//i.test(url)) {
    return {
      request: null,
      problem: `"${url}" is not a URL. Include the scheme and port, for ` +
        "example http://localhost:5055/api/v1/budgets.",
    };
  }

  const tail = rest.slice(rest.indexOf(url) + url.length).trim();
  const isBody = tail.startsWith("{") || tail.startsWith("[");
  return {
    request: {
      url,
      method,
      ...(isBody ? { body: tail } : {}),
      ...(!isBody && tail ? { note: tail.slice(0, 200) } : {}),
    },
  };
}

export const MOCK_API_USAGE =
  "Usage: /context_mock_api [METHOD] <url> [context or JSON body]\n\n" +
  "Examples:\n" +
  "  /context_mock_api http://localhost:5055/api/v1/budgets?billing_mode=usage\n" +
  "  /context_mock_api POST http://localhost:5055/api/v1/budgets {\"name\":\"test\"}\n" +
  "  /context_mock_api http://localhost:5055/api/v1/me login\n\n" +
  "The call is replayed with the session the in-app Page preview is signed " +
  "in as, so it carries the same Authorization header and cookies the app " +
  "itself would send. Open Page preview and sign in first.";

/** The report the command leaves in the conversation. */
export function renderMockApiReport(result: MockApiResult): string {
  const lines: string[] = [];
  const { request } = result;
  lines.push(`Mimicked ${request.method} ${request.url}`);
  if (request.note) lines.push(`Context: ${request.note}`);
  lines.push("");

  if (result.authOrigin) {
    lines.push(
      `Authorization: Bearer … — taken from the signed-in Page preview ` +
        `(${result.authOrigin}). The token itself is not printed.`
    );
  } else if (result.session) {
    lines.push(
      "Authorization: none — a Page preview session was available but held " +
        "no bearer token. If this endpoint needs one, the app may keep it " +
        "somewhere this cannot read; say where and it can be taught."
    );
  } else {
    lines.push(
      "Authorization: none — no signed-in Page preview session was " +
        "published. Open Page preview, sign in, and run this again; the " +
        "call below went out unauthenticated."
    );
  }
  if (result.cookiesSent > 0) {
    lines.push(`Cookies: ${result.cookiesSent} sent, as the browser would.`);
  }
  if (result.session) {
    lines.push(
      `Session source: ${result.session.url} ` +
        `(captured ${Math.round(result.session.ageMs / 1000)}s ago)`
    );
  }
  lines.push("");

  if (result.error) {
    lines.push(`No response: ${result.error}`);
    lines.push(
      "The service may not be running on that port. Nothing was changed."
    );
    return lines.join("\n");
  }

  lines.push(
    `Response: HTTP ${result.status} ${result.statusText}`.trim() +
      ` (${result.durationMs}ms)`
  );
  if (result.headers.length > 0) {
    lines.push("", "Headers:");
    for (const [name, value] of result.headers) {
      lines.push(`  ${name}: ${value}`);
    }
  }
  lines.push("", "Body:");
  lines.push(result.body || "(empty)");
  if (result.truncated) lines.push("… (body truncated)");

  if (result.status === 401 || result.status === 403) {
    lines.push(
      "",
      result.authOrigin
        ? "The call carried the preview's own token and was still refused, " +
          "so this is the endpoint's answer to the signed-in user — not a " +
          "missing header."
        : "This is the unauthenticated answer. Sign in to Page preview and " +
          "run it again to see what the signed-in user gets."
    );
  }
  lines.push("", "Read-only replay — no files were changed.");
  return lines.join("\n");
}
