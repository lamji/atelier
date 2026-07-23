/**
 * Phase 4 smoke: exercises GitService against the current repo without
 * mutating history. Creates one temp file, stages + unstages it, deletes
 * it, and prints every git.state.changed emission along the way.
 *
 *   pnpm --filter @atelier/agent exec tsx scripts/git-smoke.ts
 */
import fs from "node:fs";
import path from "node:path";
import { EventBus } from "../src/events/event-bus.js";
import { GitService } from "../src/git/git-service.js";

const root = path.resolve(import.meta.dirname, "../../..");
const tempRel = "scratch/phase4-git-smoke.tmp.txt";
const tempAbs = path.join(root, tempRel);

async function main(): Promise<void> {
  const bus = new EventBus();
  bus.subscribe((e) => {
    if (e.topic === "git.state.changed") {
      console.log("[event] git.state.changed", JSON.stringify(e.payload));
    }
  });

  const git = new GitService(root, bus);
  await git.start();

  const status = await git.status();
  console.log("branch:", status.branch, "clean:", status.isClean);
  console.log("changed files:", status.files.length);

  console.log("log entries:", (await git.log(5)).length);
  console.log("branches:", (await git.branches()).map((b) => b.name));

  fs.mkdirSync(path.dirname(tempAbs), { recursive: true });
  fs.writeFileSync(tempAbs, "phase 4 smoke\n");
  try {
    await git.stage([tempRel]);
    const staged = (await git.status()).files.find((f) => f.path === tempRel);
    console.log("after stage:", JSON.stringify(staged));

    const diff = await git.diff(tempRel, true);
    console.log(
      "staged diff — patch bytes:",
      diff.diff.length,
      "| before:",
      JSON.stringify(diff.before),
      "| after:",
      JSON.stringify(diff.after)
    );

    await git.unstage([tempRel]);
    const unstaged = (await git.status()).files.find((f) => f.path === tempRel);
    console.log("after unstage:", JSON.stringify(unstaged));

    await git.discard([tempRel]);
    console.log(
      "after discard — file exists:",
      fs.existsSync(tempAbs),
      "| in status:",
      (await git.status()).files.some((f) => f.path === tempRel)
    );
  } finally {
    fs.rmSync(tempAbs, { force: true });
    await git.refresh();
    git.stop();
  }
  console.log("smoke OK");
}

main().catch((error) => {
  console.error("smoke FAILED:", error);
  process.exit(1);
});
