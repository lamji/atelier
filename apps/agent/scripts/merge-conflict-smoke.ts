/**
 * Merge-conflict smoke: builds a throwaway bare "origin" plus two clones,
 * makes them diverge on the same lines, then drives the pull → conflict →
 * resolve → complete flow through GitService and the git-ops layer exactly
 * as the RPC handlers do. Prints every git.state.changed emission so the
 * detection path (conflicts count, mergeKind) is visible too.
 *
 *   pnpm --filter @atelier/agent exec tsx scripts/merge-conflict-smoke.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { EventBus } from "../src/events/event-bus.js";
import { GitService } from "../src/git/git-service.js";
import * as ops from "../src/git/git-ops.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${String(detail)}` : ""}`);
  if (!ok) failures += 1;
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-merge-smoke-"));
const bare = path.join(sandbox, "origin.git");
const alice = path.join(sandbox, "alice");
const bob = path.join(sandbox, "bob");

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Like `sh`, but a non-zero exit is an answer ("not set"), not a crash. */
function shOk(cwd: string, ...args: string[]): string | null {
  try {
    return sh(cwd, ...args);
  } catch {
    return null;
  }
}

function setupIdentity(cwd: string): void {
  sh(cwd, "config", "user.email", "smoke@atelier.local");
  sh(cwd, "config", "user.name", "Atelier Smoke");
}

async function main(): Promise<void> {
  // ── two clones that disagree about greeting.txt ─────────────────────
  sh(sandbox, "init", "--bare", "-b", "main", bare);
  sh(sandbox, "clone", "-q", bare, alice);
  setupIdentity(alice);
  fs.writeFileSync(path.join(alice, "greeting.txt"), "hello\nworld\n");
  fs.writeFileSync(path.join(alice, "untouched.txt"), "same\n");
  sh(alice, "add", "-A");
  sh(alice, "commit", "-q", "-m", "base");
  sh(alice, "push", "-q", "-u", "origin", "main");

  sh(sandbox, "clone", "-q", bare, bob);
  setupIdentity(bob);

  // Alice pushes a change; Bob edits the same line locally.
  fs.writeFileSync(path.join(alice, "greeting.txt"), "hello from alice\nworld\n");
  sh(alice, "commit", "-q", "-am", "alice greeting");
  sh(alice, "push", "-q");
  fs.writeFileSync(path.join(bob, "greeting.txt"), "hello from bob\nworld\n");
  sh(bob, "commit", "-q", "-am", "bob greeting");

  const bus = new EventBus();
  const events: unknown[] = [];
  bus.subscribe((e) => {
    if (e.topic === "git.state.changed") {
      events.push(e.payload);
      console.log("[event] git.state.changed", JSON.stringify(e.payload));
    }
  });
  const git = new GitService(bob, bus);
  await git.start();

  const before = await git.status();
  check("at rest: no conflicts", before.conflicts.length === 0);
  check("at rest: no merge state", before.mergeState === null);

  // ── fetch shows the divergence ──────────────────────────────────────
  const counts = await ops.fetchRun(git);
  check("fetch reports 1 ahead / 1 behind", counts.ahead === 1 && counts.behind === 1, JSON.stringify(counts));

  // ── refs for the pickers ───────────────────────────────────────────
  const refs = await ops.refs(bob);
  check("refs: current branch", refs.current === "main");
  check("refs: origin listed", refs.remotes.some((r) => r.name === "origin"));
  check("refs: local main tracks origin/main", refs.local.find((b) => b.name === "main")?.upstream === "origin/main");
  check("refs: remote main known", refs.remote.some((r) => r.remote === "origin" && r.branch === "main"));

  // ── checkoutRun: new branch, back to main ──────────────────────────
  const co = await ops.checkoutRun(bob, "scratch/x", { onChunk: () => undefined }, { create: true });
  check("checkoutRun creates a branch", co.ok && sh(bob, "rev-parse", "--abbrev-ref", "HEAD") === "scratch/x");
  const back = await ops.checkoutRun(bob, "main", { onChunk: () => undefined });
  check("checkoutRun switches back", back.ok && sh(bob, "rev-parse", "--abbrev-ref", "HEAD") === "main");

  // ── branch out from a chosen base (not HEAD) ───────────────────────
  let outLog = "";
  const out1 = await ops.checkoutRun(
    bob,
    "scratch/from-base",
    { onChunk: (c) => (outLog += c) },
    { create: true, from: "scratch/x" }
  );
  check("branch out uses the chosen start point", out1.ok && /-b scratch\/from-base scratch\/x/.test(outLog));
  check(
    "branched commit matches the base, not HEAD",
    sh(bob, "rev-parse", "HEAD") === sh(bob, "rev-parse", "scratch/x")
  );

  let remoteLog = "";
  const out2 = await ops.checkoutRun(
    bob,
    "scratch/from-remote",
    { onChunk: (c) => (remoteLog += c) },
    { create: true, from: "origin/main" }
  );
  check("branch out from a remote base passes --no-track", out2.ok && /--no-track/.test(remoteLog));
  check(
    "no upstream adopted from the remote base",
    shOk(bob, "config", "--get", "branch.scratch/from-remote.merge") === null
  );
  sh(bob, "checkout", "-q", "main");

  // ── pull conflicts ─────────────────────────────────────────────────
  let output = "";
  const pulled = await ops.pullRun(git, "merge", { onChunk: (c) => (output += c) }, { remote: "origin", branch: "main" });
  check("explicit source is echoed", /\$ git pull --no-rebase --no-edit origin main/.test(output));
  check("pull exits non-zero on conflict", !pulled.result.ok, pulled.result.exitCode);
  check("pull reports the conflicted path", pulled.conflicts.join() === "greeting.txt", pulled.conflicts.join());
  check("streamed output mentions CONFLICT", /CONFLICT/.test(output));

  await git.refresh();
  const during = await git.status();
  check("status lists the conflict", during.conflicts.join() === "greeting.txt");
  check("merge state detected", during.mergeState?.kind === "merge", JSON.stringify(during.mergeState));
  check("merge message prepared", Boolean(during.mergeState?.message));
  const last = events.at(-1) as { conflicts?: number; mergeKind?: string | null };
  check("event carries conflict count", last?.conflicts === 1, JSON.stringify(last));
  check("event carries merge kind", last?.mergeKind === "merge");

  // ── conflict file payload ──────────────────────────────────────────
  const file = await ops.conflictFile(git, "greeting.txt");
  check("base side is the original", file.base === "hello\nworld\n");
  check("ours side is bob", file.ours.startsWith("hello from bob"));
  check("theirs side is alice", file.theirs.startsWith("hello from alice"));
  check("working copy has markers", /^<{7}/m.test(file.current) && /^>{7}/m.test(file.current));
  check("not yet resolved", file.resolved === false);
  check("labels name the sides", file.oursLabel === "main" && file.theirsLabel.length > 0, `${file.oursLabel} / ${file.theirsLabel}`);

  // ── marker scan + manual resolution ────────────────────────────────
  const scan1 = ops.scanConflictMarkers(git, ["greeting.txt", "untouched.txt"]);
  check("scan: marked file is dirty", scan1.dirty.join() === "greeting.txt");
  check("scan: clean file is clean", scan1.clean.join() === "untouched.txt");

  await ops.resolveConflict(git, "greeting.txt", "hello from both\nworld\n", false);
  check("autosave keeps it unmerged", (await git.status()).conflicts.length === 1);
  await ops.resolveConflict(git, "greeting.txt", "hello from both\nworld\n", true);
  const afterStage = await git.status();
  check("staging marks it resolved", afterStage.conflicts.length === 0);
  check("merge state persists until commit", afterStage.mergeState?.kind === "merge");

  // ── restore, then take a side ──────────────────────────────────────
  await ops.restoreConflict(git, "greeting.txt");
  check("restore puts markers back", /^<{7}/m.test(fs.readFileSync(path.join(bob, "greeting.txt"), "utf8")));
  check("restore re-lists the conflict", (await git.status()).conflicts.length === 1);

  await ops.resolveConflictWith(git, ["greeting.txt"], "theirs");
  check("take theirs writes alice's line", fs.readFileSync(path.join(bob, "greeting.txt"), "utf8").startsWith("hello from alice"));
  check("take theirs stages it", (await git.status()).conflicts.length === 0);

  // ── complete the merge ─────────────────────────────────────────────
  let doneOut = "";
  const done = await ops.mergeContinueRun(git, "Merge origin/main (smoke)", { onChunk: (c) => (doneOut += c) });
  check("merge commit succeeds", done.ok, doneOut.slice(-200));
  await git.refresh();
  const after = await git.status();
  check("merge state cleared", after.mergeState === null);
  check("tree clean after merge", after.isClean);
  check("HEAD is a merge commit", sh(bob, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length === 3);

  // ── abort path on a fresh conflict ─────────────────────────────────
  fs.writeFileSync(path.join(alice, "greeting.txt"), "alice again\nworld\n");
  sh(alice, "commit", "-q", "-am", "alice again");
  sh(alice, "push", "-q");
  fs.writeFileSync(path.join(bob, "greeting.txt"), "bob again\nworld\n");
  sh(bob, "commit", "-q", "-am", "bob again");
  const pulled2 = await ops.pullRun(git, "merge", { onChunk: () => undefined });
  check("second pull conflicts", !pulled2.result.ok);
  await ops.mergeAbort(git);
  const aborted = await git.status();
  check("abort clears merge state", aborted.mergeState === null && aborted.conflicts.length === 0);
  check("abort restores bob's content", fs.readFileSync(path.join(bob, "greeting.txt"), "utf8").startsWith("bob again"));

  // ── rebase detection ───────────────────────────────────────────────
  const pulled3 = await ops.pullRun(git, "rebase", { onChunk: () => undefined });
  check("rebase pull conflicts", !pulled3.result.ok);
  const rebasing = await git.status();
  check("rebase state detected", rebasing.mergeState?.kind === "rebase", JSON.stringify(rebasing.mergeState));
  check("rebase labels warn about swapped sides", /your commit/.test(rebasing.mergeState?.theirs ?? ""));
  await ops.mergeAbort(git);
  check("rebase abort clears state", (await git.status()).mergeState === null);

  git.stop();
  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
