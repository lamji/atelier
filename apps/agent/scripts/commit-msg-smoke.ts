/**
 * Smoke: generates a commit message from the repo's current changes via
 * Claude Haiku (subscription auth). Read-only — nothing is committed.
 *
 *   pnpm --filter @atelier/agent exec tsx scripts/commit-msg-smoke.ts
 */
import path from "node:path";
import { EventBus } from "../src/events/event-bus.js";
import { generateCommitMessage } from "../src/git/commit-message.js";
import { GitService } from "../src/git/git-service.js";

const root = path.resolve(import.meta.dirname, "../../..");

async function main(): Promise<void> {
  const git = new GitService(root, new EventBus());
  await git.start();

  const status = await git.status();
  console.log("changed files:", status.files.length);

  const started = Date.now();
  const message = await generateCommitMessage(git);
  console.log(`generated in ${Date.now() - started}ms:\n`);
  console.log(message);
  git.stop();
}

main().catch((error) => {
  console.error("smoke failed:", error);
  process.exit(1);
});
