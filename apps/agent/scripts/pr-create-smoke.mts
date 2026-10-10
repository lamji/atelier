/**
 * Runtime smoke for pull-request creation.
 *
 * Two things are proved against a real temp git repository:
 *
 *  1. The PR is opened by the account that owns access, not by whichever
 *     account `gh` happens to have active. GitHub's API is stubbed, so the
 *     Authorization header each attempt carries is observable — that header
 *     is the whole bug: the branch pushed as one account while gh asked as
 *     another and GitHub answered "Could not resolve to a Repository".
 *  2. The description is the branch's commit message, not a fresh account
 *     of the same diff. The single-commit case must reach that verbatim and
 *     without a model call.
 *
 *   cd apps/agent && pnpm exec tsx scripts/pr-create-smoke.mts
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPr, prCredentials } from "../src/git/git-ops.js";
import {
  clearForgeAuth,
  forgetForgeToken,
  rememberForgeToken,
} from "../src/git/forge-auth.js";
import { generatePrDescription } from "../src/git/ai-drafts.js";

const HOST = "github.com";
const OWNER = "dftech-dev";
const NAME = "finops-crystal-lens";
const OWNER_TOKEN = "ghp_owner_account_token";
const OTHER_TOKEN = "ghp_other_account_token";

let failed = false;
const check = (ok: boolean, message: string): void => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${message}`);
  if (!ok) failed = true;
};

const git = (root: string, ...args: string[]): string => {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
};

const root = await mkdtemp(path.join(tmpdir(), "atelier-pr-smoke-"));
const io = { onChunk: (chunk: string) => process.stdout.write(`  | ${chunk}`) };

/** Every POST the stub saw, so the chosen account is observable. */
interface Seen {
  url: string;
  token: string;
  body: Record<string, unknown>;
}
const seen: Seen[] = [];
const realFetch = globalThis.fetch;

/**
 * Stands in for GitHub: only OWNER_TOKEN can see the repository, and any
 * other token gets the 404 GitHub really returns for a private repo the
 * caller cannot see.
 */
function installStub(): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    const url = String(input);
    const token = String(
      (init?.headers as Record<string, string> | undefined)?.["Authorization"] ??
        ""
    ).replace(/^Bearer /, "");
    if (url.endsWith("/user")) {
      const login = token === OWNER_TOKEN ? "jick-lampago" : "lamji";
      return new Response(JSON.stringify({ login }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    seen.push({ url, token, body });
    if (token !== OWNER_TOKEN) {
      return new Response(
        JSON.stringify({ message: "Not Found" }),
        { status: 404 }
      );
    }
    return new Response(
      JSON.stringify({
        html_url: `https://github.com/${OWNER}/${NAME}/pull/42`,
      }),
      { status: 201 }
    );
  }) as typeof globalThis.fetch;
}

try {
  installStub();

  // A repo whose origin is the SSH remote of a private repository, with a
  // base branch and a feature branch carrying one detailed commit.
  git(root, "init", "-b", "SPDNX-Dev");
  git(root, "config", "user.email", "smoke@atelier.test");
  git(root, "config", "user.name", "Smoke");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "README.md"), "base\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "Base commit");
  git(root, "remote", "add", "origin", `git@${HOST}:${OWNER}/${NAME}.git`);
  git(root, "checkout", "-b", "fix/chargeback_and_global_filtering");
  writeFileSync(path.join(root, "chargeback.ts"), "export const x = 1;\n");
  git(root, "add", "-A");
  const COMMIT_SUBJECT = "Fix billing account identity in chargeback allocation";
  const COMMIT_BODY = [
    "The Chargeback by Billing Account table rendered the account id where",
    "the name belongs, because the name lookup was keyed by the wrong field.",
    "",
    "- resolve the display name before falling back to the id",
    "- keep the id as the fallback branch so an unnamed account still renders",
  ].join("\n");
  git(root, "commit", "-m", COMMIT_SUBJECT, "-m", COMMIT_BODY);

  console.log("\n[1] the description reuses the commit message");
  const draft = await generatePrDescription(
    { root } as unknown as Parameters<typeof generatePrDescription>[0],
    "SPDNX-Dev",
    undefined,
    undefined
  );
  check(
    draft.title === COMMIT_SUBJECT,
    `the title is the commit subject (got "${draft.title}")`
  );
  check(
    draft.body === COMMIT_BODY,
    "the body is the commit body, verbatim and unrewritten"
  );

  console.log("\n[2] two accounts, only one can see the repo");
  // Both accounts are stored the way the Requests pane stores them.
  rememberForgeToken(HOST, OTHER_TOKEN, "lamji");
  rememberForgeToken(HOST, OWNER_TOKEN, "jick-lampago");
  clearForgeAuth(HOST);

  const credentials = await prCredentials(root);
  console.log(
    `  accounts: ${credentials.credentials
      .map((credential) => credential.login ?? credential.source)
      .join(", ")}`
  );
  check(
    credentials.credentials.length >= 2,
    "both stored accounts are offered to the picker"
  );
  check(
    !credentials.credentials.some((credential) =>
      JSON.stringify(credential).includes("ghp_")
    ),
    "no token is exposed in the picker payload"
  );

  console.log("\n[3] an explicit account choice is honoured");
  seen.length = 0;
  const chosen = credentials.credentials.find(
    (credential) => credential.login === "jick-lampago"
  );
  check(Boolean(chosen), "the owning account has a selectable id");
  const pinned = await createPr(
    root,
    "SPDNX-Dev",
    draft.title,
    draft.body,
    io,
    "fix/chargeback_and_global_filtering",
    chosen?.id
  );
  check(pinned.ok, `the PR was created (${pinned.url ?? "no url"})`);
  check(
    pinned.url === `https://github.com/${OWNER}/${NAME}/pull/42`,
    "the created PR URL is returned"
  );
  check(seen.length === 1, `exactly one account was tried (${seen.length})`);
  check(
    seen[0]?.token === OWNER_TOKEN,
    "the PR was opened with the chosen account's token"
  );
  check(
    seen[0]?.body["title"] === COMMIT_SUBJECT &&
      seen[0]?.body["base"] === "SPDNX-Dev" &&
      seen[0]?.body["head"] === "fix/chargeback_and_global_filtering",
    "title, head and base reached GitHub unchanged"
  );

  console.log("\n[4] a wrong account is not the end of the attempt");
  // Automatic selection with no readable SSH identity walks the ladder:
  // the account that cannot see the repo 404s, and the next one succeeds
  // instead of the whole create failing the way gh's single account did.
  seen.length = 0;
  const auto = await createPr(
    root,
    "SPDNX-Dev",
    draft.title,
    draft.body,
    io,
    "fix/chargeback_and_global_filtering"
  );
  check(auto.ok, "automatic selection still opened the PR");
  check(
    seen.some((attempt) => attempt.token === OWNER_TOKEN),
    "the owning account was reached"
  );
  const lastAttempt = seen[seen.length - 1];
  check(
    lastAttempt?.token === OWNER_TOKEN,
    "the successful attempt is the one that owns access"
  );

  console.log("\n[5] no account can see it — the failure explains itself");
  forgetForgeToken(HOST, OWNER_TOKEN);
  clearForgeAuth(HOST);
  seen.length = 0;
  const denied = await createPr(
    root,
    "SPDNX-Dev",
    draft.title,
    draft.body,
    io,
    "fix/chargeback_and_global_filtering"
  );
  check(!denied.ok, "the create failed when no account has access");
  check(
    denied.output.includes("404"),
    "the output names the HTTP answer each account got"
  );
  check(
    Boolean(denied.fallbackUrl?.includes("/compare/")),
    "a prefilled compare URL is still offered"
  );
  check(
    !denied.output.includes("ghp_"),
    "no token leaks into the failure output"
  );
} catch (error) {
  failed = true;
  console.error("FAIL:", error);
} finally {
  globalThis.fetch = realFetch;
  forgetForgeToken(HOST, OWNER_TOKEN);
  forgetForgeToken(HOST, OTHER_TOKEN);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK");
process.exit(failed ? 1 : 0);
