import type { GitService } from "../git/git-service.js";
import type { ToolRegistry } from "./registry.js";

export interface GitToolInput {
  action:
    | "status"
    | "log"
    | "diff"
    | "stage"
    | "unstage"
    | "commit"
    | "branches"
    | "checkout";
  paths?: string[];
  path?: string;
  staged?: boolean;
  ref?: string;
  message?: string;
  create?: boolean;
  maxCount?: number;
  /** Which checkout to act on, when the workspace holds several. */
  repo?: string;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`git tool: "${name}" is required for this action`);
  }
  return value;
}

/**
 * Registers the git tool: one action-dispatched entry point over
 * GitService, so model-invoked git operations emit the same tool.* and
 * git.state.changed events as UI-invoked RPCs.
 *
 * `repo` selects the checkout in a workspace that holds several. Omitting
 * it is normal and correct — the service falls back to the checkout the
 * session is scoped to, which is what a locked session always wants.
 */
export function registerGitTools(registry: ToolRegistry, git: GitService): void {
  registry.register("git", async (input: GitToolInput) => {
    const repo = input.repo;
    switch (input.action) {
      case "status":
        return git.status(repo);
      case "log":
        return git.log(input.maxCount, repo);
      case "diff":
        return git.diff(input.path, input.staged, input.ref, repo);
      case "stage":
        await git.stage(required(input.paths, "paths"), repo);
        return { staged: input.paths };
      case "unstage":
        await git.unstage(required(input.paths, "paths"), repo);
        return { unstaged: input.paths };
      case "commit":
        return {
          hash: await git.commit(required(input.message, "message"), repo),
        };
      case "branches":
        return git.branches(repo);
      case "checkout":
        await git.checkout(required(input.ref, "ref"), input.create, repo);
        return { checkedOut: input.ref };
      default:
        throw new Error(`git tool: unknown action "${String(input.action)}"`);
    }
  });
}
