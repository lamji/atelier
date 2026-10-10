import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitBranchState,
  GitConflictFile,
  GitFlowInfo,
  GitForge,
  GitForgeAuthSource,
  GitForgeCredential,
  GitForgeStatus,
  GitOpResult,
  GitPullMode,
  GitPullRequest,
  GitRefs,
} from "@atelier/protocol";
import {
  clearForgeAuth,
  forgeAuthCandidates,
  forgeCredentialId,
  rememberForgeToken,
  type ForgeAuth,
} from "./forge-auth.js";
import type { GitService } from "./git-service.js";

/**
 * Streamed git/gh command layer for the commit→push→PR wizard. Commands
 * are spawned (never shelled) so user text can't inject; hooks run for
 * real and their output streams to the UI via `io.onChunk`.
 */

export interface OpIo {
  onChunk: (chunk: string) => void;
  signal?: AbortSignal;
}

/**
 * Free-form push flags from the UI: must look like options, and the
 * ones that point git at an arbitrary executable are rejected.
 */
const PUSH_FLAG_RE = /^-{1,2}[A-Za-z0-9][\w=./:@^~,-]*$/;
const PUSH_FLAG_DENYLIST = new Set([
  "--exec",
  "--receive-pack",
  "--upload-pack",
]);

function assertPushFlags(flags: string[]): void {
  for (const flag of flags) {
    const name = flag.split("=")[0] ?? flag;
    if (!PUSH_FLAG_RE.test(flag) || PUSH_FLAG_DENYLIST.has(name)) {
      throw new Error(`Push flag not allowed: ${flag}`);
    }
  }
}

/** Retained output is capped to this tail; streaming is unaffected. */
const MAX_OUTPUT_CHARS = 64_000;

/**
 * Fail fast instead of hanging on an interactive credential prompt, and
 * never open an editor: `:` is git's documented no-op editor, so a merge
 * commit or `rebase --continue` takes the prepared message as-is instead
 * of blocking on a vim nobody can see.
 */
const NO_PROMPT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: ":",
};
// Strips CSI (colors/cursor) and OSC (title/link) escape sequences.
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

/** Spawns a command, streaming ANSI-stripped stdout+stderr interleaved. */
function runStreaming(
  cmd: string,
  args: string[],
  cwd: string,
  io: OpIo
): Promise<GitOpResult> {
  return new Promise((resolve, reject) => {
    // Echo the resolved command so the UI shows exactly what ran — the
    // caller can't know the branch/upstream arguments added here.
    const echo = `$ ${cmd} ${args.join(" ")}\n`;
    io.onChunk(echo);
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: NO_PROMPT_ENV });
    let output = echo;

    const onData = (data: Buffer) => {
      const text = data.toString("utf8").replace(ANSI_RE, "");
      output += text;
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(-MAX_OUTPUT_CHARS);
      }
      io.onChunk(text);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const onAbort = () => child.kill();
    io.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error: NodeJS.ErrnoException) => {
      io.signal?.removeEventListener("abort", onAbort);
      if (error.code === "ENOENT") {
        reject(new Error(`${cmd} is not installed or not on PATH`));
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      io.signal?.removeEventListener("abort", onAbort);
      if (io.signal?.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      const exitCode = code ?? -1;
      resolve({ ok: exitCode === 0, exitCode, output });
    });
  });
}

/** Quiet capture for probes — no streaming, output trimmed. */
export function capture(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: NO_PROMPT_ENV });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out: out.trim() }));
  });
}

/** Capture that also writes to the child's stdin — for `gh --with-token`. */
function captureWithInput(
  cmd: string,
  args: string[],
  cwd: string,
  input: string
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, env: NO_PROMPT_ENV });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out: out.trim() }));
    child.stdin.end(input);
  });
}

/** What adding an account did, in terms the panel can show. */
export interface AddAccountResult {
  ok: boolean;
  /** Account the token belongs to, read back from the forge itself. */
  login?: string;
  /** Whether it was handed to gh, so it survives a restart. */
  persisted: boolean;
  reason?: string;
}

/**
 * Adds a second GitHub account from a token the user pastes.
 *
 * The panel could only tell people to go and run `gh auth login` in a
 * terminal — which is a context switch out of the app, an interactive
 * prompt sequence, and (as this exact message proved) something a user can
 * reasonably mis-paste. A machine with two accounts is normal; adding the
 * second one should not be.
 *
 * The token is VERIFIED before it is stored: GitHub is asked who it
 * belongs to, and the answer is what the panel reports. That matters here
 * more than usual, because the entire failure being fixed is a credential
 * silently belonging to the wrong person — storing an unverified token
 * would just move the confusion one step later.
 *
 * Atelier stores it, and then offers it to `gh` as well.
 *
 * That order matters and was wrong the first time. Handing it to gh alone
 * looked tidier — gh already holds several accounts, and the credential
 * ladder already reads gh — but gh VALIDATES scopes and refuses tokens it
 * dislikes, which most fine-grained PATs are. "gh owns it" then quietly
 * meant nothing owned it, and the account vanished at the next restart.
 * Atelier keeps it in the settings table beside the provider credentials
 * already there; gh is best-effort on top, so the rest of the machine
 * benefits when it accepts.
 */
export async function addForgeAccount(
  root: string,
  host: string,
  token: string
): Promise<AddAccountResult> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { ok: false, persisted: false, reason: "Paste a token first." };
  }
  if (/\s/.test(trimmed)) {
    return {
      ok: false,
      persisted: false,
      reason:
        "That does not look like a token — it contains spaces. Paste only " +
        "the token itself.",
    };
  }

  const api = /^(www\.)?github\.com$/i.test(host)
    ? "https://api.github.com"
    : `https://${host}/api/v3`;
  const who = await forgeFetch(`${api}/user`, {
    Authorization: `Bearer ${trimmed}`,
    Accept: "application/vnd.github+json",
  });
  if (who.status === 401) {
    return {
      ok: false,
      persisted: false,
      reason: "GitHub rejected that token. It may be expired or mistyped.",
    };
  }
  if (who.status === 0) {
    return {
      ok: false,
      persisted: false,
      reason: `Could not reach ${host} to verify the token: ${who.body}`,
    };
  }
  if (who.status !== 200) {
    return {
      ok: false,
      persisted: false,
      reason: `${host} answered ${who.status} when verifying the token.`,
    };
  }
  const login = String(
    (JSON.parse(who.body) as { login?: unknown }).login ?? ""
  );
  if (!login) {
    return {
      ok: false,
      persisted: false,
      reason: "GitHub accepted the token but did not name an account.",
    };
  }

  // Stored FIRST, and by Atelier, because gh is allowed to say no: it
  // validates scopes and rejects tokens it dislikes (a fine-grained PAT
  // without `read:org` is the common case). Depending on gh to keep the
  // token meant a refusal there quietly lost the account the user had just
  // added — which is exactly what happened.
  rememberForgeToken(host, trimmed, login);

  const stored = await captureWithInput(
    "gh",
    ["auth", "login", "--hostname", host, "--with-token"],
    root,
    trimmed + "\n"
  ).catch(() => ({ code: -1, out: "gh is not installed" }));
  // The ladder is cached per host; a new account must be visible at once.
  clearForgeAuth(host);
  if (stored.code !== 0) {
    // Atelier has it either way; gh declining only means other tools on
    // the machine will not see it. Say which, and say gh's own words —
    // "missing required scope 'read:org'" is a fixable sentence, and
    // "gh could not store it" is not.
    return {
      ok: true,
      login,
      persisted: true,
      reason:
        `Added @${login}. Atelier will remember it. The GitHub CLI declined ` +
        `to also store it, so other tools on this machine will not see it: ` +
        `${stored.out.split(/\r?\n/)[0]?.trim() || "gh is not installed"}`,
    };
  }
  return { ok: true, login, persisted: true };
}

/**
 * Optionally re-stages everything, then commits (hooks run + stream).
 *
 * `amend` rewrites HEAD rather than adding to it, which is how a branch
 * keeps ONE commit that documents the whole branch. The caller decides —
 * see branchState() for the only condition under which it is safe to
 * default to.
 */
export async function commitRun(
  root: string,
  message: string,
  stageAll: boolean,
  io: OpIo,
  opts: { amend?: boolean } = {}
): Promise<GitOpResult> {
  if (stageAll) {
    const add = await runStreaming("git", ["add", "-A"], root, io);
    if (!add.ok) return add;
  }
  const args = ["commit", "-m", message];
  if (opts.amend) args.push("--amend");
  return runStreaming("git", args, root, io);
}

/**
 * Pushes the current branch. The branch is named explicitly unless the
 * branch already tracks a remote branch of the SAME name — otherwise a
 * bare `git push` either fails ("upstream branch does not match the name
 * of your current branch") or, worse, pushes to a differently-named
 * branch. Flags come from the UI free-form and are shape-checked above.
 */
export async function pushRun(
  root: string,
  flags: string[],
  io: OpIo,
  target?: { remote?: string; branch?: string; setUpstream?: boolean }
): Promise<GitOpResult> {
  assertPushFlags(flags);

  const args = ["push", ...flags];
  const branch = await currentBranch(root);
  if (target?.remote) {
    // Explicit target from the "Push to" picker: current branch to
    // <remote>/<branch>, optionally adopting it as upstream.
    const remoteBranch = target.branch || branch;
    if (target.setUpstream) args.push("-u");
    args.push(target.remote, `${branch}:${remoteBranch}`);
    return runStreaming("git", args, root, io);
  }
  if ((await upstreamBranch(root, branch)) !== branch) {
    args.push("-u", "origin", branch);
  }
  return runStreaming("git", args, root, io);
}

/**
 * Merges origin/<base> into the current branch. A conflicted (non-zero)
 * exit is an expected outcome the AI fix loop consumes — not an error.
 */
export async function mergeRun(
  root: string,
  base: string,
  io: OpIo
): Promise<GitOpResult> {
  const fetch = await runStreaming("git", ["fetch", "origin", base], root, io);
  if (!fetch.ok) return fetch;
  return runStreaming(
    "git",
    ["merge", "--no-edit", `origin/${base}`],
    root,
    io
  );
}

/**
 * Creates the PR, as the account that actually owns access to this repo.
 *
 * The API path leads. `gh pr create` spends whichever account gh has
 * ACTIVE, which on a machine with two logins is routinely the wrong one:
 * the branch pushes fine over SSH as one account while gh asks GitHub as
 * another, and GitHub answers "Could not resolve to a Repository" — its
 * honest reply for a private repo the asking token cannot see. Atelier
 * already knows every credential on this machine, and the Requests pane
 * already picks between them by matching the checkout's own git identity;
 * PR creation now uses the same ladder instead of deferring to gh's global
 * state (which a git panel has no business rewriting).
 *
 * `gh` remains the fallback for the cases the API path cannot serve: a
 * non-GitHub forge, a cross-fork head, or a machine where no API-capable
 * credential could be discovered at all.
 *
 * The body goes to gh through a temp file rather than `--body`: a drafted
 * description runs to thousands of characters, and on Windows the whole
 * command line is capped at 32k — a long enough description would fail
 * with a spawn error that looks nothing like "your text was too big".
 * `--repo` pins gh to `origin` so a second remote (a fork, an `upstream`)
 * cannot silently retarget the PR.
 */
export async function createPr(
  root: string,
  base: string,
  title: string,
  body: string,
  io: OpIo,
  /** Branch to merge from; the current checkout when omitted. */
  headBranch?: string,
  /** Opaque id from git.prCredentials; omit to pick the account automatically. */
  credentialId?: string
): Promise<GitOpResult> {
  const head = headBranch?.trim() || (await currentBranch(root));
  const remote = await originRepo(root);

  if (remote && isGitHubRemote(remote.host)) {
    const viaApi = await createPrViaApi(
      root,
      remote,
      base,
      head,
      title,
      body,
      io,
      credentialId
    );
    if (viaApi) return viaApi;
  }

  const bodyFile = await writeBodyFile(body);
  const args = ["pr", "create", "--base", base, "--head", head, "--title", title];
  if (remote) args.push("--repo", `${remote.owner}/${remote.name}`);
  args.push("--body-file", bodyFile);
  try {
    let result = await runStreaming("gh", args, root, io);
    if (!result.ok) {
      result = await retryAsGitIdentity(root, args, result, io);
    }
    const url = result.output.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
    if (url) return { ...result, url };
    if (result.ok) return result;
    return await withPrDiagnosis(root, base, head, title, body, result, io);
  } finally {
    await rm(bodyFile, { force: true }).catch(() => {});
  }
}

/** github.com itself, as opposed to a GitHub Enterprise host. */
function isGitHubDotCom(host: string): boolean {
  return /^(www\.)?github\.com$/i.test(host);
}

/**
 * Any GitHub, Enterprise included — the same rule the request list uses to
 * choose a forge, so one remote cannot be GitHub to one pane and not the
 * other.
 */
function isGitHubRemote(host: string): boolean {
  return /github/i.test(host);
}

function githubApiRoot(host: string): string {
  return isGitHubDotCom(host)
    ? "https://api.github.com"
    : `https://${host}/api/v3`;
}

/**
 * The account this checkout actually authenticates as.
 *
 * SSH is the ground truth when origin is an SSH remote: it is the identity
 * that just pushed the branch, so it is the identity whose token can see
 * the repository. gh's active login is only a hint, and a misleading one
 * on a two-account machine — it is used solely to fill the gap on HTTPS
 * remotes, where the push credential is in the helper ladder anyway.
 */
async function checkoutIdentity(root: string, remote: RemoteRepo): Promise<string> {
  if (remote.ssh) {
    const ssh = await sshLogin(root, remote.host).catch(() => "");
    if (ssh) return ssh;
  }
  return "";
}

/**
 * Which credentials could open this PR, best first, and which one the
 * checkout points at. Feeds the account picker on the describe screen.
 */
export async function prCredentials(root: string): Promise<{
  credentials: GitForgeCredential[];
  /** Credential matching the account git pushes as, when there is one. */
  suggestedId?: string;
  /** Login git authenticates as on this checkout, when it could be read. */
  identity?: string;
  host?: string;
  repo?: string;
}> {
  const remote = await originRepo(root).catch(() => null);
  if (!remote || !isGitHubRemote(remote.host)) return { credentials: [] };
  const repo = `${remote.owner}/${remote.name}`;
  const identity = await checkoutIdentity(root, remote);
  const ordered = preferLogin(
    await forgeAuthCandidates(root, "github", remote.host, repo),
    identity
  );
  const matching = identity
    ? ordered.find((candidate) => sameLogin(candidate.login, identity))
    : undefined;
  return {
    credentials: ordered.map((auth) => ({
      id: forgeCredentialId(auth),
      source: auth.source,
      ...(auth.login ? { login: auth.login } : {}),
    })),
    ...(matching ? { suggestedId: forgeCredentialId(matching) } : {}),
    ...(identity ? { identity } : {}),
    host: remote.host,
    repo,
  };
}

/**
 * Opens the PR through GitHub's REST API.
 *
 * @returns the outcome, or null when this path does not apply and `gh`
 * should be tried instead (no API-capable credential on this machine).
 */
async function createPrViaApi(
  root: string,
  remote: RemoteRepo,
  base: string,
  head: string,
  title: string,
  body: string,
  io: OpIo,
  credentialId?: string
): Promise<GitOpResult | null> {
  const repo = `${remote.owner}/${remote.name}`;
  const identity = await checkoutIdentity(root, remote);
  const discovered = await forgeAuthCandidates(root, "github", remote.host, repo);
  if (discovered.length === 0) return null;

  let candidates = preferLogin(discovered, identity);
  if (credentialId) {
    const chosen = candidates.find(
      (candidate) => forgeCredentialId(candidate) === credentialId
    );
    if (!chosen) {
      return failedResult(
        io,
        "The selected account is no longer available on this machine. " +
          "Choose another account, or let Atelier pick one automatically."
      );
    }
    // An explicit choice is exactly that: it never falls through to another
    // account, or the picker would be a suggestion rather than a decision.
    candidates = [chosen];
  } else if (identity) {
    io.onChunk(
      `Atelier: this checkout pushes as ${identity} — opening the pull ` +
        `request as that account.\n`
    );
  }

  const attempts: string[] = [];
  for (const auth of candidates.slice(0, MAX_PR_CREDENTIAL_ATTEMPTS)) {
    const who = auth.login ? `@${auth.login}` : sourceLabel(auth.source);
    io.onChunk(`$ POST /repos/${repo}/pulls  (as ${who})\n`);
    const res = await forgeFetch(
      `${githubApiRoot(remote.host)}/repos/${repo}/pulls`,
      {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      { title, head, base, body }
    );

    if (res.status === 201) {
      const url = String(
        (JSON.parse(res.body) as { html_url?: unknown }).html_url ?? ""
      );
      const line = `Pull request opened as ${who}: ${url}\n`;
      io.onChunk(line);
      return {
        ok: true,
        exitCode: 0,
        output: attempts.join("") + line,
        ...(url ? { url } : {}),
      };
    }

    const detail = githubErrorText(res.body);
    const line = `  ${who} → HTTP ${res.status}${detail ? ` — ${detail}` : ""}\n`;
    attempts.push(line);
    io.onChunk(line);

    // 401/403/404 are the answers a wrong account gives, and the next
    // credential may well be the right one. Anything else — a 422 for a
    // PR that already exists or a base/head GitHub rejects, a 5xx — is
    // about the request, not the caller, and retrying it as somebody else
    // only produces the same answer twice.
    const wrongAccount =
      res.status === 401 || res.status === 403 || res.status === 404;
    if (!wrongAccount) {
      return await withPrDiagnosis(
        root,
        base,
        head,
        title,
        body,
        { ok: false, exitCode: 1, output: attempts.join("") },
        io
      );
    }
  }

  return await withPrDiagnosis(
    root,
    base,
    head,
    title,
    body,
    { ok: false, exitCode: 1, output: attempts.join("") },
    io
  );
}

/** How many accounts to spend on one create before reporting the failure. */
const MAX_PR_CREDENTIAL_ATTEMPTS = 4;

/** GitHub's own sentence for a rejected write, when it sent one. */
function githubErrorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      message?: unknown;
      errors?: Array<{ message?: unknown }>;
    };
    const first = parsed.errors?.find((entry) => entry?.message);
    return String(first?.message ?? parsed.message ?? "").slice(0, 300);
  } catch {
    return body.slice(0, 200).replace(/\s+/g, " ").trim();
  }
}

function failedResult(io: OpIo, message: string): GitOpResult {
  const text = `${message}\n`;
  io.onChunk(text);
  return { ok: false, exitCode: 1, output: text };
}

/**
 * gh and git reach GitHub through different credentials — gh's own token
 * versus the SSH key — and nothing warns you when they belong to different
 * accounts. The branch pushes fine while gh insists the repository does not
 * exist, GitHub's honest answer for a private repo gh's account cannot see.
 *
 * When that is what happened AND the account git pushes as is already added
 * to gh, switch to it and run the create once more; the previous account is
 * restored afterwards so we don't quietly repoint the user's whole CLI.
 * Anything else (account not added, switch fails) returns the original
 * failure untouched, and withPrDiagnosis explains the sign-in to the user.
 */
async function retryAsGitIdentity(
  root: string,
  args: string[],
  failure: GitOpResult,
  io: OpIo
): Promise<GitOpResult> {
  if (!/could not resolve to a repository|HTTP 404|not found/i.test(failure.output)) {
    return failure;
  }
  const remote = await originRepo(root).catch(() => null);
  if (!remote?.ssh) return failure;

  const [ghUser, gitUser] = await Promise.all([
    ghLogin(root).catch(() => ""),
    sshLogin(root, remote.host).catch(() => ""),
  ]);
  if (!ghUser || !gitUser || ghUser === gitUser) return failure;
  if (!(await ghAccounts(root)).includes(gitUser)) return failure;

  io.onChunk(
    `\nAtelier: gh asked GitHub as ${ghUser}, but this repo is pushed as ` +
      `${gitUser} — retrying as ${gitUser}.\n`
  );
  const switched = await capture("gh", ["auth", "switch", "-u", gitUser], root);
  if (switched.code !== 0) return failure;
  try {
    const retry = await runStreaming("gh", args, root, io);
    return retry.ok ? retry : failure;
  } finally {
    await capture("gh", ["auth", "switch", "-u", ghUser], root).catch(() => {});
  }
}

/** Every account gh has credentials for, active or not. */
async function ghAccounts(root: string): Promise<string[]> {
  const { out } = await capture("gh", ["auth", "status"], root);
  return [...out.matchAll(/Logged in to \S+ (?:as|account) (\S+)/g)].map(
    (m) => m[1] ?? ""
  );
}

/** Stages the PR body on disk so it never has to fit in a command line. */
async function writeBodyFile(body: string): Promise<string> {
  const file = join(tmpdir(), `atelier-pr-${process.pid}-${Date.now()}.md`);
  await writeFile(file, body, "utf8");
  return file;
}

/** Chars we can spend on a prefilled compare URL before browsers/GitHub balk. */
const COMPARE_URL_LIMIT = 6000;

/**
 * The compare URL for `head` → `base`, carrying the drafted title and body
 * as query params so the browser form opens already filled in.
 *
 * The body is dropped rather than truncated when it would push the URL past
 * what a GET can carry — half a description silently pasted into a PR is
 * worse than an empty box the user can paste into themselves.
 */
function compareUrlFor(
  remote: RemoteRepo,
  base: string,
  head: string,
  title: string,
  body: string
): string {
  const path =
    `https://${remote.host}/${remote.owner}/${remote.name}/compare/` +
    `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const params = new URLSearchParams({ expand: "1" });
  if (title) params.set("title", title);
  const withBody = new URLSearchParams(params);
  if (body) withBody.set("body", body);
  const full = `${path}?${withBody.toString()}`;
  return full.length <= COMPARE_URL_LIMIT ? full : `${path}?${params.toString()}`;
}

/**
 * Explains a failed `gh pr create` and hands back a way through.
 *
 * `gh` reports the repository it resolved but never says where that name
 * came from or which account it asked as, so its most common failure —
 * "Could not resolve to a Repository", which GitHub returns for a private
 * repo the token cannot SEE as readily as for one that does not exist —
 * reads as "your repo is gone" when the truth is usually the wrong
 * account, a token without `repo` scope, or org SSO not authorized.
 *
 * Diagnosis is best-effort and never fails the step: it appends facts to
 * the output the user is already looking at, plus the compare URL, so the
 * PR can still be opened in the browser where their session already works.
 */
async function withPrDiagnosis(
  root: string,
  base: string,
  head: string,
  title: string,
  body: string,
  result: GitOpResult,
  io: OpIo
): Promise<GitOpResult> {
  let remote: RemoteRepo | null = null;
  let ghUser = "";
  let gitUser = "";
  try {
    remote = await originRepo(root);
    ghUser = await ghLogin(root);
    if (remote?.ssh) gitUser = await sshLogin(root, remote.host);
  } catch {
    // A probe that cannot run just leaves its line out.
  }
  // Two forms of the same link: a bare one short enough to read in the
  // output pane, and the prefilled one behind the button in the UI.
  const compareUrl = remote ? compareUrlFor(remote, base, head, "", "") : undefined;
  const prefilledUrl = remote
    ? compareUrlFor(remote, base, head, title, body)
    : undefined;

  const unresolved = /could not resolve to a repository|HTTP 404|not found/i.test(
    result.output
  );
  const lines = ["", "── Atelier: what gh was pointed at ──"];
  if (remote) {
    lines.push(`origin → ${remote.host}/${remote.owner}/${remote.name}`);
  } else {
    lines.push("origin → could not read the remote URL");
  }
  lines.push(`gh signed in as → ${ghUser || "nobody (gh auth status)"}`);
  if (gitUser) lines.push(`git pushes as → ${gitUser} (ssh key)`);
  lines.push(`branch → ${head} into ${base}`);

  const splitIdentity = Boolean(unresolved && ghUser && gitUser && ghUser !== gitUser);
  if (splitIdentity) {
    lines.push(
      "",
      `Your push worked as ${gitUser}, but gh asked GitHub as ${ghUser} — ` +
        `and ${ghUser} cannot see this repository, which GitHub reports as ` +
        '"could not resolve". Nothing is wrong with the branch or the repo; ' +
        "the two tools are signed in as different people.",
      "",
      `Point gh at the account that owns the access:`,
      `  gh auth switch -u ${gitUser}   — if that account is already added`,
      `  gh auth login                  — to add it`
    );
  } else if (unresolved) {
    lines.push(
      "",
      "GitHub says it cannot resolve that repository. It answers the same " +
        "way for a repo that does not exist and for a private one your " +
        "token cannot see, so check, in this order:",
      "  gh auth status                          — signed in as the right account?",
      "  gh auth refresh -h github.com -s repo   — token missing `repo` scope?",
      "  (then approve SSO for the org if it asks)",
      "  git remote -v                           — repo renamed or transferred?"
    );
  }
  if (compareUrl) {
    lines.push(
      "",
      "Or open the pull request in the browser — the title and description " +
        "you drafted come along:",
      `  ${compareUrl}`
    );
  }
  const text = `${lines.join("\n")}\n`;
  io.onChunk(text);
  return {
    ...result,
    output: result.output + text,
    ...(prefilledUrl ? { fallbackUrl: prefilledUrl } : {}),
  };
}

interface RemoteRepo {
  host: string;
  owner: string;
  name: string;
  /** True when origin is an SSH URL, so git authenticates with a key. */
  ssh: boolean;
}

/**
 * owner/name for the `origin` remote. Handles the three URL shapes git
 * writes — scp-style ssh, ssh://, and https — because which one a repo
 * uses is exactly what nobody remembers when a PR fails.
 */
async function originRepo(root: string): Promise<RemoteRepo | null> {
  const { code, out } = await capture(
    "git",
    ["remote", "get-url", "origin"],
    root
  );
  if (code !== 0 || !out) return null;
  const url = out.trim();
  const scp = url.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  const full = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/i);
  const match = scp ?? full;
  if (!match) return null;
  const host = match[1] ?? "";
  const parts = (match[2] ?? "").split("/").filter(Boolean);
  const name = parts.pop();
  const owner = parts.join("/");
  if (!host || !owner || !name) return null;
  return { host, owner, name, ssh: Boolean(scp) || /^ssh:/i.test(url) };
}

/** Forge host of `origin`, for callers that only need where to sign in. */
export async function originHost(root: string): Promise<string> {
  return (await originRepo(root))?.host ?? "github.com";
}

/** The login gh would act as, or "" when it cannot say. */
async function ghLogin(root: string): Promise<string> {
  const { code, out } = await capture("gh", ["auth", "status"], root);
  if (code !== 0 && !out) return "";
  // gh has phrased this as "Logged in to github.com as NAME" and
  // "Logged in to github.com account NAME" across versions.
  return out.match(/Logged in to \S+ (?:as|account) (\S+)/)?.[1] ?? "";
}

/**
 * The login `git` itself authenticates as over SSH.
 *
 * Worth asking because git and gh reach GitHub through different
 * credentials — the SSH key versus gh's own token — and nothing warns you
 * when they belong to different accounts. The branch pushes fine while gh
 * insists the repository does not exist, which is GitHub's honest answer
 * for a private repo the *other* account cannot see.
 */
async function sshLogin(root: string, host: string): Promise<string> {
  const { out } = await capture(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-T", `git@${host}`],
    root
  );
  // GitHub always exits non-zero here; the greeting is the answer.
  return out.match(/^Hi ([^!\s]+)!/m)?.[1] ?? "";
}

/** Branch names on origin (no fetch of contents — refs only). */
export async function remoteBranches(root: string): Promise<string[]> {
  const { code, out } = await capture(
    "git",
    ["ls-remote", "--heads", "origin"],
    root
  );
  if (code !== 0) throw new Error(`Could not list remote branches: ${out}`);
  return out
    .split("\n")
    .map((line) => line.split("refs/heads/")[1]?.trim())
    .filter((name): name is string => Boolean(name));
}

/** What `git.pullRequests` hands back — see the method's contract. */
export interface PullRequestList {
  requests: GitPullRequest[];
  forge: GitForge | null;
  /** Legacy shorthand for `status === "ok"`. */
  available: boolean;
  reason?: string;
  status: GitForgeStatus;
  source?: GitForgeAuthSource;
  /** Credentials the user can explicitly choose without exposing tokens. */
  credentials: GitForgeCredential[];
  repo?: string;
  host?: string;
  login?: string;
  branch?: string;
}

/** Open requests are polled; a wall of them helps nobody, so cap the list. */
const MAX_PULL_REQUESTS = 30;

/** A hung socket must not outlive the poll round that opened it. */
const FORGE_HTTP_TIMEOUT_MS = 10_000;

/**
 * Open pull/merge requests for `origin`, read with whichever credential
 * the user already has — the forge CLI, a token in the environment, or
 * git's own credential helper (see `forge-auth.ts`). Nothing is stored
 * and nothing is asked for: if the checkout can push, this can read.
 *
 * This runs on a timer, so every way it can come up empty is reported as
 * a `status` rather than thrown — a signed-out CLI would otherwise raise
 * the same alert every poll for as long as the panel is open. The status
 * matters more than the sentence beside it: only `signed-out` means the
 * user has anything to do about it.
 */
export async function pullRequests(
  root: string,
  credentialId?: string
): Promise<PullRequestList> {
  const branch = await currentBranch(root).catch(() => "");
  const remote = await originRepo(root).catch(() => null);
  if (!remote) {
    return {
      requests: [],
      forge: null,
      available: false,
      credentials: [],
      status: "no-remote",
      reason: "This checkout has no origin remote.",
    };
  }
  const forge: GitForge | null = isGitHubRemote(remote.host)
    ? "github"
    : /gitlab/i.test(remote.host)
      ? "gitlab"
      : null;
  if (!forge) {
    return {
      requests: [],
      forge: null,
      available: false,
      credentials: [],
      status: "no-forge",
      host: remote.host,
      reason: `${remote.host} is not GitHub or GitLab.`,
    };
  }
  const repo = `${remote.owner}/${remote.name}`;
  const list = await listRequests(root, forge, remote, repo, credentialId);
  return {
    ...list,
    forge,
    branch,
    repo,
    host: remote.host,
    available: list.status === "ok",
    credentials: list.credentials ?? [],
    requests: list.requests.map((r) => ({ ...r, mine: r.head === branch })),
  };
}

/** One forge's answer, before the caller stamps repo/branch/host on it. */
interface ForgeList {
  requests: GitPullRequest[];
  status: GitForgeStatus;
  reason?: string;
  source?: GitForgeAuthSource;
  login?: string;
  credentials?: GitForgeCredential[];
}

/**
 * The credential ladder.
 *
 * The forge CLI goes first because it is the only cheap source of the CI
 * rollup — one call carries `statusCheckRollup`, where REST would need a
 * second call per request. Everything after it exists so that a missing
 * or signed-out CLI is never mistaken for a missing login: the user who
 * can push has a credential somewhere, and `signed-out` is only reached
 * once every one of those places has come up empty.
 */
async function listRequests(
  root: string,
  forge: GitForge,
  remote: RemoteRepo,
  repo: string,
  credentialId?: string
): Promise<ForgeList> {
  const candidatePromise = forgeAuthCandidates(
    root,
    forge,
    remote.host,
    repo
  );

  // An explicit choice never falls through to another account. The token
  // stays in the agent; the browser sends back only its opaque id.
  if (credentialId) {
    const candidates = await candidatePromise;
    const credentials = credentialSummaries(candidates);
    const auth = candidates.find(
      (candidate) => forgeCredentialId(candidate) === credentialId
    );
    if (!auth) {
      return {
        requests: [],
        status: candidates.length === 0 ? "signed-out" : "denied",
        credentials,
        reason:
          "The selected credential is no longer available on this machine. " +
          "Choose another credential or use Automatic.",
      };
    }
    const selected =
      forge === "github"
        ? await githubRequestsRest(remote, repo, auth)
        : await gitlabRequestsRest(remote, repo, auth);
    return { ...selected, credentials };
  }

  // Who git itself is on this checkout.
  //
  // History, Fetch and Pull all work on an SSH remote for one reason: they
  // authenticate with the key, never with an API token. That identity is
  // therefore the ground truth for which account owns this checkout — and
  // it was already being computed here, but only to word an error after
  // everything had failed. It picks the credential now.
  //
  // Without it, "Automatic" walked the ladder in discovery order and led
  // with gh's ACTIVE account, so a machine with two GitHub logins showed
  // "@lamji denied" on a repository the user reaches perfectly well as
  // @jick-lampago. The account that can read the repo was sitting in the
  // ladder the whole time; nothing had put it first.
  const sshIdentity =
    forge === "github" && remote.ssh
      ? await sshLogin(root, remote.host).catch(() => "")
      : "";
  const candidatesRaw = await candidatePromise;
  const candidates = preferLogin(candidatesRaw, sshIdentity);
  const credentials = credentialSummaries(candidates);
  const matchesSsh = sshIdentity
    ? candidates.find((candidate) => sameLogin(candidate.login, sshIdentity))
    : undefined;

  // A credential belonging to the SSH account goes first, ahead of the CLI.
  // The CLI is normally preferred because it is the only cheap source of
  // the CI rollup, but `gh pr list` spends whichever account gh has ACTIVE
  // and Atelier must not run `gh auth switch` to change that — it is the
  // user's global state, and a git panel has no business rewriting it. A
  // correct list without CI chips beats a denial with them.
  if (matchesSsh) {
    const rest = await githubRequestsRest(remote, repo, matchesSsh);
    if (rest.status === "ok") return { ...rest, credentials };
  }

  const cli =
    forge === "github"
      ? await githubPullRequests(root, repo)
      : await gitlabMergeRequests(root);
  if (cli.status === "ok") return { ...cli, credentials };

  if (candidates.length === 0) {
    return {
      requests: [],
      status: "signed-out",
      credentials,
      reason: `No ${forge === "github" ? "GitHub" : "GitLab"} credential found — not in ${
        forge === "github" ? "gh" : "glab"
      }, the environment, or git's credential helper.`,
    };
  }

  let denied: ForgeList | null = null;
  for (const auth of candidates) {
    const rest =
      forge === "github"
        ? await githubRequestsRest(remote, repo, auth)
        : await gitlabRequestsRest(remote, repo, auth);
    if (rest.status === "ok") return { ...rest, credentials };
    // A network or forge failure is shared by every credential. A denial is
    // credential-specific, so keep walking: another repo-scoped helper may
    // be the account that can actually push this selected checkout.
    if (rest.status !== "denied") return { ...rest, credentials };
    denied = rest;
  }

  // An SSH checkout can be perfectly usable while the API identity is not:
  // git authenticates with an SSH key, whereas gh/REST uses a token. Name
  // that split before clearing the cache so the pane never claims the repo
  // itself is invisible when we can prove git reaches it as another account.
  const splitIdentity =
    forge === "github"
      ? await githubIdentityMismatch(root, remote, candidates)
      : null;

  // All candidates were rejected. Drop the host's cached ladders so Re-check
  // can immediately notice a newly authorized account or SSO grant.
  clearForgeAuth(remote.host);
  if (splitIdentity) {
    return {
      requests: [],
      status: "denied",
      source: splitIdentity.auth.source,
      login: splitIdentity.cliLogin,
      credentials,
      reason:
        `Git reaches this checkout as @${splitIdentity.gitLogin} using your ` +
        "SSH key. Pull requests are not part of git — they are a GitHub " +
        "website feature, read over the GitHub API, and GitHub does not " +
        "accept SSH keys for the API. It needs a token, and the only token " +
        `on this machine belongs to @${splitIdentity.cliLogin}, which this ` +
        "repository refused.\n\n" +
        "That is why Changes and History work (they only read your local " +
        ".git folder) and Fetch/Pull work (they use the SSH key) while this " +
        "tab does not.\n\n" +
        `Add a token for @${splitIdentity.gitLogin} below. It sits alongside ` +
        `@${splitIdentity.cliLogin} rather than replacing it.`,
    };
  }
  return {
    ...(denied ?? {
      requests: [],
      status: "denied" as const,
      reason: "No discovered credential can read this repository.",
    }),
    credentials,
  };
}

/** GitHub logins are case-insensitive; a picker must not care about case. */
export function sameLogin(a: string | undefined, b: string): boolean {
  if (!a || !b) return false;
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

/**
 * Puts the credential belonging to `login` at the head of the ladder,
 * keeping the rest in their discovered order.
 *
 * Stable on purpose: the ladder's existing order encodes real priorities
 * (environment, then CLI, then repo-scoped helper) and this only overrides
 * the first place, for the one account we have proof about.
 */
export function preferLogin(
  candidates: ForgeAuth[],
  login: string
): ForgeAuth[] {
  if (!login) return candidates;
  const matching = candidates.filter((c) => sameLogin(c.login, login));
  if (matching.length === 0) return candidates;
  return [...matching, ...candidates.filter((c) => !sameLogin(c.login, login))];
}

/** Public metadata for the picker; never put a token on the bridge. */
function credentialSummaries(candidates: ForgeAuth[]): GitForgeCredential[] {
  return candidates.map((auth) => ({
    id: forgeCredentialId(auth),
    source: auth.source,
    ...(auth.login ? { login: auth.login } : {}),
  }));
}

/**
 * The exact split behind a private SSH checkout that works in git while
 * GitHub's API returns 404. SSH keys cannot authenticate GitHub's REST API,
 * so the request pane must use a gh/token identity with the same access.
 */
async function githubIdentityMismatch(
  root: string,
  remote: RemoteRepo,
  candidates: ForgeAuth[]
): Promise<{ cliLogin: string; gitLogin: string; auth: ForgeAuth } | null> {
  if (!remote.ssh) return null;
  const [cliLogin, gitLogin] = await Promise.all([
    ghLogin(root).catch(() => ""),
    sshLogin(root, remote.host).catch(() => ""),
  ]);
  if (
    !cliLogin ||
    !gitLogin ||
    cliLogin.localeCompare(gitLogin, undefined, { sensitivity: "accent" }) === 0
  ) {
    return null;
  }
  const auth = candidates.find(
    (candidate) =>
      candidate.login?.localeCompare(cliLogin, undefined, {
        sensitivity: "accent",
      }) === 0
  );
  return auth ? { cliLogin, gitLogin, auth } : null;
}

/**
 * GitHub's REST list, spent with whatever credential answered. It cannot
 * carry the check rollup (that is a call per request), so this is the
 * rescue path rather than the default — the rows simply lose their CI
 * chip when `gh` is not the one answering.
 */
async function githubRequestsRest(
  remote: RemoteRepo,
  repo: string,
  auth: ForgeAuth
): Promise<ForgeList> {
  const api = /^(www\.)?github\.com$/i.test(remote.host)
    ? "https://api.github.com"
    : `https://${remote.host}/api/v3`;
  const res = await forgeFetch(
    `${api}/repos/${repo}/pulls?state=open&sort=updated&direction=desc` +
      `&per_page=${MAX_PULL_REQUESTS}`,
    {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    }
  );
  if (res.status !== 200) return httpFailure(res, auth);
  const requests = parseJsonArray(res.body).map((item) => {
    const o = item as Record<string, unknown>;
    const user = o["user"] as { login?: string } | null | undefined;
    const head = o["head"] as { ref?: string } | null | undefined;
    const base = o["base"] as { ref?: string } | null | undefined;
    return {
      number: numberOf(o["number"]),
      title: String(o["title"] ?? ""),
      author: user?.login ?? "",
      head: String(head?.ref ?? ""),
      base: String(base?.ref ?? ""),
      url: String(o["html_url"] ?? ""),
      draft: Boolean(o["draft"]),
      updatedAt: String(o["updated_at"] ?? ""),
    } satisfies GitPullRequest;
  });
  return ok(requests, auth);
}

/**
 * GitLab's REST list. The token is offered as `PRIVATE-TOKEN` first
 * (what a PAT wants) and retried as a bearer, because a credential
 * helper hands back an OAuth token that only the second form accepts.
 */
async function gitlabRequestsRest(
  remote: RemoteRepo,
  repo: string,
  auth: ForgeAuth
): Promise<ForgeList> {
  const url =
    `https://${remote.host}/api/v4/projects/${encodeURIComponent(repo)}` +
    `/merge_requests?state=opened&order_by=updated_at&per_page=${MAX_PULL_REQUESTS}`;
  let res = await forgeFetch(url, { "PRIVATE-TOKEN": auth.token });
  if (res.status === 401) {
    res = await forgeFetch(url, { Authorization: `Bearer ${auth.token}` });
  }
  if (res.status !== 200) return httpFailure(res, auth);
  const requests = parseJsonArray(res.body).map((item) => {
    const o = item as Record<string, unknown>;
    const author = o["author"] as { username?: string } | null | undefined;
    return {
      number: numberOf(o["iid"] ?? o["number"]),
      title: String(o["title"] ?? ""),
      author: author?.username ?? "",
      head: String(o["source_branch"] ?? ""),
      base: String(o["target_branch"] ?? ""),
      url: String(o["web_url"] ?? ""),
      draft: Boolean(o["draft"] ?? o["work_in_progress"]),
      updatedAt: String(o["updated_at"] ?? ""),
    } satisfies GitPullRequest;
  });
  return ok(requests, auth);
}

function ok(requests: GitPullRequest[], auth: ForgeAuth): ForgeList {
  return {
    requests,
    status: "ok",
    source: auth.source,
    ...(auth.login ? { login: auth.login } : {}),
  };
}

/** One fetch that cannot throw and cannot hang. */
async function forgeFetch(
  url: string,
  headers: Record<string, string>,
  /** Present for a write — the JSON body to POST. */
  post?: unknown
): Promise<{ status: number; body: string }> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), FORGE_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "atelier",
        ...(post === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(post === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(post) }),
      signal: abort.signal,
    });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    // status 0 = never reached the forge: offline, DNS, proxy, timeout.
    return { status: 0, body: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An HTTP answer that was not a list. Only a rejected credential is
 * allowed to read as "denied" — everything else is an error, so the pane
 * never offers a sign-in for a problem signing in cannot fix.
 */
function httpFailure(
  res: { status: number; body: string },
  auth: ForgeAuth
): ForgeList {
  const from = sourceLabel(auth.source);
  if (res.status === 401 || res.status === 403) {
    return {
      requests: [],
      status: "denied",
      source: auth.source,
      ...(auth.login ? { login: auth.login } : {}),
      reason: `The ${from} credential was rejected (HTTP ${res.status}).`,
    };
  }
  if (res.status === 404) {
    return {
      requests: [],
      status: "denied",
      source: auth.source,
      ...(auth.login ? { login: auth.login } : {}),
      reason: `The forge returned HTTP 404 to the ${from} credential.`,
    };
  }
  return {
    requests: [],
    status: "error",
    reason: res.status
      ? `The forge answered HTTP ${res.status}.`
      : shortReason(res.body),
  };
}

/** The credential source in the words the status strip uses. */
function sourceLabel(source: GitForgeAuthSource): string {
  return source === "env"
    ? "environment"
    : source === "credential-helper"
      ? "git credential"
      : "CLI";
}

/**
 * `gh pr list --json`. A non-zero exit is not a verdict — it means only
 * that gh could not answer; the ladder above tries the other credentials
 * before anyone is told they are signed out.
 */
async function githubPullRequests(
  root: string,
  repo: string
): Promise<ForgeList> {
  const fields =
    "number,title,author,headRefName,baseRefName,url,isDraft,updatedAt," +
    "reviewDecision,statusCheckRollup";
  const probe = await capture(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(MAX_PULL_REQUESTS),
      "--json",
      fields,
    ],
    root
  ).catch((err: NodeJS.ErrnoException) => ({
    code: -1,
    out: err.code === "ENOENT" ? "gh is not installed or not on PATH" : String(err),
  }));
  if (probe.code !== 0) {
    return { requests: [], status: "error", reason: shortReason(probe.out) };
  }
  const raw = parseJsonArray(probe.out);
  const requests = raw.map((item) => {
    const o = item as Record<string, unknown>;
    const author = o["author"] as { login?: string } | null | undefined;
    return {
      number: numberOf(o["number"]),
      title: String(o["title"] ?? ""),
      author: author?.login ?? "",
      head: String(o["headRefName"] ?? ""),
      base: String(o["baseRefName"] ?? ""),
      url: String(o["url"] ?? ""),
      draft: Boolean(o["isDraft"]),
      updatedAt: String(o["updatedAt"] ?? ""),
      ...(o["reviewDecision"]
        ? { reviewDecision: String(o["reviewDecision"]) }
        : {}),
      ...rollupChecks(o["statusCheckRollup"]),
    } satisfies GitPullRequest;
  });
  return { requests, status: "ok", source: "cli" };
}

/** `glab mr list -F json`, run in the checkout so glab resolves the project. */
async function gitlabMergeRequests(root: string): Promise<ForgeList> {
  const probe = await capture(
    "glab",
    ["mr", "list", "--per-page", String(MAX_PULL_REQUESTS), "-F", "json"],
    root
  ).catch((err: NodeJS.ErrnoException) => ({
    code: -1,
    out:
      err.code === "ENOENT" ? "glab is not installed or not on PATH" : String(err),
  }));
  if (probe.code !== 0) {
    return { requests: [], status: "error", reason: shortReason(probe.out) };
  }
  const raw = parseJsonArray(probe.out);
  const requests = raw.map((item) => {
    const o = item as Record<string, unknown>;
    const author = o["author"] as { username?: string } | null | undefined;
    return {
      number: numberOf(o["iid"] ?? o["number"]),
      title: String(o["title"] ?? ""),
      author: author?.username ?? "",
      head: String(o["source_branch"] ?? ""),
      base: String(o["target_branch"] ?? ""),
      url: String(o["web_url"] ?? ""),
      draft: Boolean(o["draft"] ?? o["work_in_progress"]),
      updatedAt: String(o["updated_at"] ?? ""),
    } satisfies GitPullRequest;
  });
  return { requests, status: "ok", source: "cli" };
}

/**
 * gh's per-PR check contexts as one word. A single failure decides the
 * whole rollup — that is what the user has to go and look at — and
 * anything still running keeps it "pending" rather than calling it green.
 */
function rollupChecks(
  rollup: unknown
): { checks?: GitPullRequest["checks"] } {
  if (!Array.isArray(rollup) || rollup.length === 0) return {};
  let pending = false;
  for (const entry of rollup) {
    const c = entry as Record<string, unknown>;
    const state = String(c["conclusion"] ?? c["state"] ?? "").toUpperCase();
    if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "FAILED"].includes(state)) {
      return { checks: "failing" };
    }
    if (!state || ["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "RUNNING"].includes(state)) {
      pending = true;
    }
  }
  return { checks: pending ? "pending" : "passing" };
}

function parseJsonArray(out: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(out || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function numberOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** CLI failure text is a paragraph; the pane has room for a sentence. */
function shortReason(out: string): string {
  const line = out.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^ERROR:\s*/i, "").slice(0, 160) || "The CLI returned no output.";
}

/**
 * Dry conflict probe: merge-tree writes nothing to the working tree.
 * Exit 0 = mergeable, exit 1 = conflicts (files listed after the oid).
 */
export async function checkConflicts(
  root: string,
  base: string
): Promise<{ mergeable: boolean; conflicts: string[] }> {
  const fetch = await capture("git", ["fetch", "origin", base], root);
  if (fetch.code !== 0) {
    throw new Error(`Could not fetch origin/${base}: ${fetch.out}`);
  }
  const { code, out } = await capture(
    "git",
    ["merge-tree", "--write-tree", "--name-only", `origin/${base}`, "HEAD"],
    root
  );
  if (code === 0) return { mergeable: true, conflicts: [] };
  // First line is the partial tree oid; the rest are conflicted paths.
  const conflicts = [...new Set(out.split("\n").slice(1))]
    .map((l) => l.trim())
    .filter(Boolean);
  return { mergeable: false, conflicts };
}

/**
 * Local + remote refs from the ref store — what the pull/push/checkout
 * pickers list. No network: a stale list is refreshed by Fetch, and a
 * picker that blocks on the network is a picker nobody opens twice.
 */
export async function refs(root: string): Promise<GitRefs> {
  const [current, remotesOut, localOut, remoteOut] = await Promise.all([
    currentBranch(root).catch(() => "HEAD"),
    capture("git", ["remote", "-v"], root),
    capture(
      "git",
      ["for-each-ref", "--format=%(refname:short)%09%(upstream:short)", "refs/heads"],
      root
    ),
    capture(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
      root
    ),
  ]);
  const remotes = new Map<string, string>();
  for (const line of remotesOut.out.split("\n")) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (m) remotes.set(m[1] ?? "", m[2] ?? "");
  }
  const local = localOut.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", upstream = ""] = line.split("\t");
      return { name, upstream: upstream || null };
    });
  const remote = remoteOut.out
    .split("\n")
    .filter((ref) => ref && !/\/HEAD$/.test(ref))
    .map((ref) => {
      const slash = ref.indexOf("/");
      return {
        ref,
        remote: slash === -1 ? "" : ref.slice(0, slash),
        branch: slash === -1 ? ref : ref.slice(slash + 1),
      };
    });
  return {
    current,
    remotes: [...remotes.entries()].map(([name, url]) => ({ name, url })),
    local,
    remote,
  };
}

/**
 * Streamed checkout. `--track <remote>/<b>` checks out a remote branch as a
 * local tracking one; `-b <ref> [start]` branches out, from `opts.from`
 * when the caller picked a base and from HEAD otherwise.
 *
 * Branching out of a REMOTE base gets `--no-track`: git would otherwise
 * make the new branch track the base, so a later push would target
 * someone else's branch instead of creating this one.
 */
export async function checkoutRun(
  root: string,
  ref: string,
  io: OpIo,
  opts?: { create?: boolean; track?: string; from?: string }
): Promise<GitOpResult> {
  const args = ["checkout"];
  if (opts?.track) {
    args.push("--track", opts.track);
  } else if (opts?.create) {
    const from = opts.from?.trim();
    if (from && (await isRemoteRef(root, from))) args.push("--no-track");
    args.push("-b", ref);
    if (from) args.push(from);
  } else {
    args.push(ref);
  }
  return runStreaming("git", args, root, io);
}

/** True when `name` resolves to a remote-tracking ref ("origin/main"). */
async function isRemoteRef(root: string, name: string): Promise<boolean> {
  const { code } = await capture(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/remotes/${name}`],
    root
  );
  return code === 0;
}

/** Snapshot the wizard uses to pick its starting stage. */
export async function flowInfo(git: GitService): Promise<GitFlowInfo> {
  const root = git.root;
  const status = await git.status();
  return {
    repo: git.activeRepo ?? ".",
    branch: status.branch,
    defaultBranch: await defaultBranch(root),
    hasCommits: await git.hasCommits(),
    hasUpstream: await hasUpstream(root),
    hasRemote: status.hasRemote,
  };
}

/**
 * What this branch has of its own, which is what decides whether the next
 * commit AMENDS or creates.
 *
 * The workflow this serves keeps ONE commit per branch and rewrites it as
 * the work grows, so the branch reads as a single dated changelog of what
 * it does rather than a trail of "wip", "fix", "fix again". That is only
 * safe to do automatically while the branch owns exactly one commit of its
 * own: at zero there is nothing to amend, and past one an amend would
 * silently fold work the user chose to keep separate.
 */
export async function branchState(git: GitService): Promise<GitBranchState> {
  const root = git.root;
  const branch = await currentBranch(root).catch(() => "");
  const base = await defaultBranch(root);
  const merged = await capture(
    "git",
    ["merge-base", "HEAD", `origin/${base}`],
    root
  );
  // No origin/<base> locally (fresh clone of one branch, offline): fall back
  // to the local base ref, and to "cannot tell" if that is missing too.
  const point =
    merged.code === 0 && merged.out
      ? merged.out
      : (await capture("git", ["merge-base", "HEAD", base], root)).out;
  const counted = point
    ? await capture("git", ["rev-list", "--count", `${point}..HEAD`], root)
    : { code: -1, out: "" };
  const ahead = counted.code === 0 ? Number(counted.out) || 0 : 0;
  const subject = await capture("git", ["log", "-1", "--pretty=%s"], root);
  const body = await capture("git", ["log", "-1", "--pretty=%B"], root);
  return {
    branch,
    base,
    ahead,
    onBase: branch === base,
    hasUpstream: await hasUpstream(root),
    headSubject: subject.code === 0 ? subject.out : "",
    headMessage: body.code === 0 ? body.out : "",
  };
}

async function currentBranch(root: string): Promise<string> {
  const { code, out } = await capture(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    root
  );
  if (code !== 0 || !out) throw new Error("Could not resolve current branch");
  return out;
}

/** Remote branch this branch tracks ("main"), or null when untracked. */
async function upstreamBranch(
  root: string,
  branch: string
): Promise<string | null> {
  const { code, out } = await capture(
    "git",
    ["config", "--get", `branch.${branch}.merge`],
    root
  );
  if (code !== 0 || !out) return null;
  return out.replace(/^refs\/heads\//, "");
}

async function hasUpstream(root: string): Promise<boolean> {
  const { code } = await capture(
    "git",
    ["rev-parse", "--abbrev-ref", "@{u}"],
    root
  );
  return code === 0;
}

async function defaultBranch(root: string): Promise<string> {
  const gh = await capture(
    "gh",
    ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"],
    root
  ).catch(() => ({ code: -1, out: "" }));
  if (gh.code === 0 && gh.out) return gh.out;

  const sym = await capture(
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    root
  );
  if (sym.code === 0 && sym.out.startsWith("origin/")) {
    return sym.out.slice("origin/".length);
  }
  return "main";
}

// ── Sync + merge-conflict resolution ─────────────────────────────────────

/**
 * Quiet `git fetch`, then the fresh ahead/behind of the current branch.
 *
 * Every remote, not just the current branch's: a checkout with a fork
 * plus an upstream had half its branches go stale because the panel only
 * ever refreshed one of them. `--prune` drops remote-tracking refs whose
 * branch is gone, and `--tags` brings tags a plain fetch would skip, so
 * the pickers list what the server actually has and nothing it does not.
 *
 * Nothing is merged into the working tree — this only moves the
 * remote-tracking refs, which is what makes it safe to run any time.
 */
export async function fetchRun(
  git: GitService
): Promise<{ ahead: number; behind: number; updated: number }> {
  const root = git.root;
  const fetched = await capture(
    "git",
    ["fetch", "--all", "--prune", "--tags"],
    root
  );
  if (fetched.code !== 0) throw new Error(fetched.out || "git fetch failed");
  const status = await git.status();
  return { ahead: status.ahead, behind: status.behind, updated: countRefUpdates(fetched.out) };
}

/**
 * How many refs the fetch moved. git prints one line per updated ref, and
 * every one of them names its destination with an arrow —
 * "   abc1234..def5678  main -> origin/main", " * [new branch] x ->
 * origin/x", " - [deleted] (none) -> origin/gone". The rest of the output
 * ("Fetching origin", "From github.com:o/r") has no arrow.
 */
function countRefUpdates(output: string): number {
  return output.split("\n").filter((line) => / -> /.test(line)).length;
}

const PULL_MODE_FLAG: Record<GitPullMode, string> = {
  merge: "--no-rebase",
  rebase: "--rebase",
  "ff-only": "--ff-only",
};

/**
 * Streamed `git pull`. The reconcile mode is always explicit: modern git
 * refuses a bare `pull` on a diverged branch until pull.rebase is set,
 * and the panel should never fail on a config the user has not touched.
 *
 * A conflicted exit is an expected outcome — the caller reads
 * `conflicts` and opens the resolver — so it resolves rather than throws.
 */
export async function pullRun(
  git: GitService,
  mode: GitPullMode,
  io: OpIo,
  source?: { remote?: string; branch?: string }
): Promise<{ result: GitOpResult; conflicts: string[] }> {
  const root = git.root;
  const args = ["pull", PULL_MODE_FLAG[mode], "--no-edit"];
  if (source?.remote) {
    args.push(source.remote);
    if (source.branch) args.push(source.branch);
  }
  const result = await runStreaming("git", args, root, io);
  const conflicts = result.ok ? [] : await unmergedPaths(git);
  return { result, conflicts };
}

/**
 * Replays the current branch on top of `onto`.
 *
 * Two things make this different from running the command by hand:
 *
 * `--autostash` — an in-app rebase is started from a panel that shows
 * uncommitted work, and git refuses to rebase a dirty tree. The stash is
 * taken and popped by git itself, so the changes are still there when the
 * replay finishes.
 *
 * `keep` — the automatic side, in the caller's terms rather than git's.
 * During a rebase HEAD is the branch being replayed ONTO, so git's "ours"
 * is the base and "theirs" is the work being replayed. Keeping the
 * rebasing branch's own version is therefore `-X theirs`, which reads
 * backwards to everyone; the mapping lives here so the UI never has to
 * say it.
 *
 * A conflicted exit is an expected outcome — the caller reads `conflicts`
 * and opens the resolver — so it resolves rather than throws.
 */
export async function rebaseRun(
  git: GitService,
  onto: string,
  keep: "mine" | "base" | "none",
  io: OpIo,
  remote?: string
): Promise<{ result: GitOpResult; conflicts: string[] }> {
  const root = git.root;
  if (remote) {
    // Rebasing onto a remote-tracking ref is only meaningful against a
    // fresh copy of it; a stale one silently replays onto old work.
    const branch = onto.startsWith(`${remote}/`)
      ? onto.slice(remote.length + 1)
      : onto;
    const fetched = await runStreaming("git", ["fetch", remote, branch], root, io);
    if (!fetched.ok) return { result: fetched, conflicts: [] };
  }
  const args = ["rebase", "--autostash"];
  if (keep === "mine") args.push("-X", "theirs");
  else if (keep === "base") args.push("-X", "ours");
  args.push(onto);
  const result = await runStreaming("git", args, root, io);
  const conflicts = result.ok ? [] : await unmergedPaths(git);
  return { result, conflicts };
}

async function unmergedPaths(git: GitService): Promise<string[]> {
  try {
    return (await git.status()).conflicts;
  } catch {
    return [];
  }
}

/**
 * All three sides of one conflicted file plus its marked-up working copy.
 * The labels travel with the payload so the resolver names the sides the
 * same way the merge banner does.
 */
export async function conflictFile(
  git: GitService,
  relPath: string
): Promise<GitConflictFile> {
  const status = await git.status();
  const [base, ours, theirs] = await Promise.all([
    git.stageContent(relPath, 1),
    git.stageContent(relPath, 2),
    git.stageContent(relPath, 3),
  ]);
  return {
    path: relPath,
    base,
    ours,
    theirs,
    current: git.readWorking(relPath),
    oursLabel: status.mergeState?.ours ?? status.branch,
    theirsLabel: status.mergeState?.theirs ?? "incoming",
    resolved: !status.conflicts.includes(relPath),
  };
}

/**
 * Persists the resolver's buffer. Staging is what tells git the conflict
 * is settled, so it is a separate, explicit step from autosave.
 */
export async function resolveConflict(
  git: GitService,
  relPath: string,
  content: string,
  stage: boolean
): Promise<void> {
  git.writeWorking(relPath, content);
  if (stage) await git.stage([relPath]);
  else git.scheduleRefresh();
}

/**
 * Take one whole side. `checkout --ours/--theirs` needs that side to
 * exist in the index; when it does not (deleted on that side, added on
 * the other) taking it means removing the file — which is what
 * `git rm` does, and what the user asked for.
 */
export async function resolveConflictWith(
  git: GitService,
  relPaths: string[],
  side: "ours" | "theirs"
): Promise<void> {
  const stage = side === "ours" ? 2 : 3;
  for (const relPath of relPaths) {
    const { root, repoRel } = git.locate(relPath);
    const exists = (await git.stageContent(relPath, stage)) !== "";
    if (exists) {
      const out = await capture(
        "git",
        ["checkout", `--${side}`, "--", repoRel],
        root
      );
      if (out.code !== 0) throw new Error(out.out || `checkout --${side} failed`);
      const added = await capture("git", ["add", "--", repoRel], root);
      if (added.code !== 0) throw new Error(added.out || "git add failed");
    } else {
      const removed = await capture("git", ["rm", "-q", "--", repoRel], root);
      if (removed.code !== 0) throw new Error(removed.out || "git rm failed");
    }
  }
  await git.refresh();
}

/** Puts the markers back so a resolution can be redone from scratch. */
export async function restoreConflict(
  git: GitService,
  relPath: string
): Promise<void> {
  const { root, repoRel } = git.locate(relPath);
  const out = await capture("git", ["checkout", "-m", "--", repoRel], root);
  if (out.code !== 0) throw new Error(out.out || "Could not restore conflict");
  await git.refresh();
}

const MARKER_RE = /^(?:<{7}(?: |$)|={7}$|>{7}(?: |$)|\|{7}(?: |$))/m;

/** Splits `paths` by whether conflict markers are still on disk. */
export function scanConflictMarkers(
  git: GitService,
  relPaths: string[]
): { clean: string[]; dirty: string[] } {
  const clean: string[] = [];
  const dirty: string[] = [];
  for (const relPath of relPaths) {
    const text = git.readWorking(relPath);
    (MARKER_RE.test(text) ? dirty : clean).push(relPath);
  }
  return { clean, dirty };
}

/** Rolls back whichever operation is mid-flight. */
export async function mergeAbort(git: GitService): Promise<void> {
  const status = await git.status();
  const kind = status.mergeState?.kind;
  if (!kind) {
    throw new Error("No merge, rebase, cherry-pick or revert is in progress");
  }
  const out = await capture("git", [kind, "--abort"], git.root);
  if (out.code !== 0) throw new Error(out.out || `git ${kind} --abort failed`);
  await git.refresh();
}

/**
 * Finishes the operation in flight. A merge is completed by committing —
 * with the user's message when they edited it, else the MERGE_MSG git
 * prepared; the others continue. git refuses on its own while paths are
 * still unmerged, and that refusal streams to the UI like any other run.
 */
export async function mergeContinueRun(
  git: GitService,
  message: string | undefined,
  io: OpIo
): Promise<GitOpResult> {
  const status = await git.status();
  const kind = status.mergeState?.kind;
  if (!kind) {
    throw new Error("No merge, rebase, cherry-pick or revert is in progress");
  }
  const trimmed = message?.trim();
  const args =
    kind === "merge"
      ? trimmed
        ? ["commit", "-m", trimmed]
        : ["commit", "--no-edit"]
      : [kind, "--continue"];
  return runStreaming("git", args, git.root, io);
}
