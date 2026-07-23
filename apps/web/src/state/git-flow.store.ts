import { create } from "zustand";
import type { GitFlowInfo } from "@atelier/protocol";

/**
 * State for the commit → push → PR wizard modal. Stages:
 *
 *   branch        pick/confirm the AI-suggested feature branch
 *   commit        streaming `git commit` (hooks) output
 *   commit-fix    commit failed → AI fix chat → re-commit
 *   push          push button + --no-verify flag, then streaming output
 *   push-fix      push failed → AI fix chat → re-push
 *   pr-ask        create a PR, or finish here?
 *   pr-describe   AI-drafted title/body (editable) + base selection
 *   pr-conflicts  conflict validation against the base branch
 *   conflict-fix  merge conflicts → AI fix chat → commit merge → re-push
 *   pr-create     streaming `gh pr create` output
 *   pr-fix        PR creation failed → AI fix chat → retry
 *   done          summary (+ PR link)
 */
export type FlowStage =
  | "idle"
  | "branch"
  | "commit"
  | "commit-fix"
  | "push"
  | "push-fix"
  | "pr-ask"
  | "pr-describe"
  | "pr-conflicts"
  | "conflict-fix"
  | "pr-create"
  | "pr-fix"
  | "done";

/** Where the flow resumes after a successful push. */
export type AfterPush = "pr-ask" | "pr-conflicts" | "done";

export interface GitFlowStore {
  open: boolean;
  stage: FlowStage;
  running: boolean;
  output: string;
  error: string | null;

  info: GitFlowInfo | null;
  commitMessage: string;
  /** True when nothing was staged at open — the first commit stages all. */
  stageAllFirst: boolean;
  branchName: string;
  suggestingBranch: boolean;
  noVerify: boolean;
  afterPush: AfterPush;

  fixConversationId: string | null;

  remoteBranches: string[];
  prBase: string;
  prTitle: string;
  prBody: string;
  prDrafting: boolean;
  conflicts: string[];
  prUrl: string | null;

  openFlow: (commitMessage: string, stageAllFirst: boolean) => void;
  close: () => void;
  set: (patch: Partial<GitFlowStore>) => void;
  appendOutput: (chunk: string) => void;
  clearOutput: () => void;
}

const initial = {
  open: false,
  stage: "idle" as FlowStage,
  running: false,
  output: "",
  error: null,
  info: null,
  commitMessage: "",
  stageAllFirst: false,
  branchName: "",
  suggestingBranch: false,
  noVerify: false,
  afterPush: "pr-ask" as AfterPush,
  fixConversationId: null,
  remoteBranches: [],
  prBase: "",
  prTitle: "",
  prBody: "",
  prDrafting: false,
  conflicts: [],
  prUrl: null,
};

export const useGitFlowStore = create<GitFlowStore>((set) => ({
  ...initial,

  openFlow: (commitMessage, stageAllFirst) =>
    set({ ...initial, open: true, commitMessage, stageAllFirst }),
  close: () => set({ ...initial }),
  set: (patch) => set(patch),
  appendOutput: (chunk) => set((s) => ({ output: s.output + chunk })),
  clearOutput: () => set({ output: "" }),
}));
