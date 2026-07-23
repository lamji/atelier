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
 */
export function registerGitTools(registry: ToolRegistry, git: GitService): void {
  registry.register("git", async (input: GitToolInput) => {
    switch (input.action) {
      case "status":
        return git.status();
      case "log":
        return git.log(input.maxCount);
      case "diff":
        return git.diff(input.path, input.staged, input.ref);
      case "stage":
        await git.stage(required(input.paths, "paths"));
        return { staged: input.paths };
      case "unstage":
        await git.unstage(required(input.paths, "paths"));
        return { unstaged: input.paths };
      case "commit":
        return { hash: await git.commit(required(input.message, "message")) };
      case "branches":
        return git.branches();
      case "checkout":
        await git.checkout(required(input.ref, "ref"), input.create);
        return { checkedOut: input.ref };
      default:
        throw new Error(`git tool: unknown action "${String(input.action)}"`);
    }
  });
}
