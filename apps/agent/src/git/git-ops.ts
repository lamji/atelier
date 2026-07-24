import { spawn } from "node:child_process";
import type { GitFlowInfo, GitOpResult } from "@atelier/protocol";
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

/** Fail fast instead of hanging on an interactive credential prompt. */
const NO_PROMPT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
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
  io: OpIo
): Promise<GitOpResult> {
  assertPushFlags(flags);

  const args = ["push", ...flags];
  const branch = await currentBranch(root);
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

/** Creates the PR via gh; head is the current branch. */
export async function createPr(
  root: string,
  base: string,
  title: string,
  body: string,
  io: OpIo
): Promise<GitOpResult> {
  const head = await currentBranch(root);
  const result = await runStreaming(
    "gh",
    ["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body],
    root,
    io
  );
  const url = result.output.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
  return url ? { ...result, url } : result;
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

/** Snapshot the wizard uses to pick its starting stage. */
export async function flowInfo(git: GitService): Promise<GitFlowInfo> {
  const root = git.root;
  const status = await git.status();
  return {
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
