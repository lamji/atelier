import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GitConflictFile,
  GitFlowInfo,
  GitOpResult,
  GitPullMode,
  GitRefs,
} from "@atelier/protocol";
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

/** Optionally re-stages everything, then commits (hooks run + stream). */
export async function commitRun(
  root: string,
  message: string,
  stageAll: boolean,
  io: OpIo
): Promise<GitOpResult> {
  if (stageAll) {
    const add = await runStreaming("git", ["add", "-A"], root, io);
    if (!add.ok) return add;
  }
  return runStreaming("git", ["commit", "-m", message], root, io);
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
 * Creates the PR via gh; head is the current branch.
 *
 * The body goes through a temp file rather than `--body`: a drafted
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
  io: OpIo
): Promise<GitOpResult> {
  const head = await currentBranch(root);
  const remote = await originRepo(root);
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
