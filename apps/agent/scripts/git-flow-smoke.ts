/**
 * Git-flow smoke: exercises the streamed op layer against a throwaway
 * repo (created in the OS temp dir), plus read-only probes against the
 * real workspace repo. Never mutates the workspace repository.
 *
 *   pnpm --filter @atelier/agent exec tsx scripts/git-flow-smoke.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/events/event-bus.js";
import {
  commitRun,
  flowInfo,
  remoteBranches,
  type OpIo,
} from "../src/git/git-ops.js";
import { GitService } from "../src/git/git-service.js";

const realRoot = path.resolve(import.meta.dirname, "../../..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-flow-smoke-"));

function sh(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

const io: OpIo = { onChunk: (c) => process.stdout.write(c) };

async function main(): Promise<void> {
  // ── throwaway repo ────────────────────────────────────────────────────
  sh(["init", "-b", "main"], tempRoot);
  sh(["config", "user.email", "smoke@example.com"], tempRoot);
  sh(["config", "user.name", "Smoke"], tempRoot);
  fs.writeFileSync(path.join(tempRoot, "a.txt"), "one\n");
  sh(["add", "-A"], tempRoot);

  console.log("--- commitRun (staged) ---");
  const first = await commitRun(tempRoot, "smoke: first commit", false, io);
  console.log("ok:", first.ok, "exit:", first.exitCode);
  if (!first.ok) throw new Error("first commit failed");

  fs.writeFileSync(path.join(tempRoot, "b.txt"), "two\n");
  console.log("--- commitRun (stageAll) ---");
  const second = await commitRun(tempRoot, "smoke: stage-all commit", true, io);
  console.log("ok:", second.ok, "exit:", second.exitCode);
  if (!second.ok) throw new Error("stage-all commit failed");

  const bus = new EventBus();
  const tempGit = new GitService(tempRoot, bus);
  await tempGit.start();
  console.log("--- flowInfo (temp repo) ---");
  console.log(JSON.stringify(await flowInfo(tempGit)));
  tempGit.stop();

  // ── read-only probes against the real repo ────────────────────────────
  const realGit = new GitService(realRoot, bus);
  await realGit.start();
  console.log("--- flowInfo (workspace) ---");
  console.log(JSON.stringify(await flowInfo(realGit)));
  console.log("--- remoteBranches (workspace) ---");
  console.log(JSON.stringify(await remoteBranches(realRoot)));
  realGit.stop();

  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.log("smoke passed");
}

main().catch((error) => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  console.error("smoke failed:", error);
  process.exit(1);
});
