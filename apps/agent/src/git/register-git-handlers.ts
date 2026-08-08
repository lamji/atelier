import type { Router } from "../bridge/router.js";
import { generatePrDescription, suggestBranchName } from "./ai-drafts.js";
import { generateCommitMessage } from "./commit-message.js";
import type { GitService } from "./git-service.js";
import * as ops from "./git-ops.js";

/**
 * @param selectedModel Reads the user's current model choice, so AI drafts
 * follow it (an "ollama/" id runs locally). Omit to stay on the default.
 */
export function registerGitHandlers(
  router: Router,
  git: GitService,
  selectedModel: () => string | undefined = () => undefined
): void {
  router.register("git.repos", async () => ({
    repos: await git.repos(),
    active: git.activeRepo,
  }));

  router.register("git.init", async () => git.init());

  router.register("git.selectRepo", async (params) => ({
    active: await git.select(params.repo),
  }));

  router.register("git.status", async () => ({ status: await git.status() }));

  router.register("git.log", async (params) => ({
    commits: await git.log(params?.maxCount),
  }));

  router.register("git.diff", (params) =>
    git.diff(params.path, params.staged, params.ref)
  );

  router.register("git.stage", async (params) => {
    await git.stage(params.paths);
    return {};
  });

  router.register("git.unstage", async (params) => {
    await git.unstage(params.paths);
    return {};
  });

  router.register("git.discard", async (params) => {
    await git.discard(params.paths);
    return {};
  });

  router.register("git.commit", async (params) => ({
    hash: await git.commit(params.message),
  }));

  router.register("git.branches", async () => ({
    branches: await git.branches(),
  }));

  router.register("git.checkout", async (params) => {
    await git.checkout(params.ref, params.create);
    return {};
  });

  router.register("git.connectRemote", async () => ({
    url: await git.connectToGitHub(),
  }));

  router.register("git.generateCommitMessage", async () => ({
    message: await generateCommitMessage(git, selectedModel()),
  }));

  // ── Commit → push → PR wizard ──────────────────────────────────────────
  // "Run" handlers stream command output to the caller as progress chunks.

  router.register("git.flowInfo", async () => ({
    info: await ops.flowInfo(git),
  }));

  router.register("git.suggestBranchName", async () => ({
    name: await suggestBranchName(git, selectedModel()),
  }));

  router.register("git.commitRun", async (params, ctx) => {
    const result = await ops.commitRun(
      git.root,
      params.message,
      params.stageAll ?? false,
      { onChunk: (chunk) => ctx.progress({ chunk }), signal: ctx.signal }
    );
    await git.refresh();
    return { result };
  });

  router.register("git.pushRun", async (params, ctx) => {
    const result = await ops.pushRun(git.root, params.flags, {
      onChunk: (chunk) => ctx.progress({ chunk }),
      signal: ctx.signal,
    });
    await git.refresh();
    return { result };
  });

  router.register("git.remoteBranches", async () => ({
    branches: await ops.remoteBranches(git.root),
  }));

  router.register("git.checkConflicts", (params) =>
    ops.checkConflicts(git.root, params.base)
  );

  router.register("git.mergeRun", async (params, ctx) => {
    const result = await ops.mergeRun(git.root, params.base, {
      onChunk: (chunk) => ctx.progress({ chunk }),
      signal: ctx.signal,
    });
    await git.refresh();
    return { result };
  });

  router.register("git.generatePrDescription", (params) =>
    generatePrDescription(git, params.base, selectedModel())
  );

  router.register("git.createPr", async (params, ctx) => {
    const result = await ops.createPr(
      git.root,
      params.base,
      params.title,
      params.body,
      { onChunk: (chunk) => ctx.progress({ chunk }), signal: ctx.signal }
    );
    return { result };
  });
}
