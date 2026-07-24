import { create } from "zustand";
import type { GitFlowInfo, GitFlowRequest } from "@atelier/protocol";

/**
 * State for the commit → push → PR wizard modal. Stages:
 *
 *   confirm       the agent was blocked from running git — user decides
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
  | "confirm"
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
  /** Set when the agent's blocked git attempt opened this modal. */
  request: GitFlowRequest | null;
  commitMessage: string;
  /** True when nothing was staged at open — the first commit stages all. */
  stageAllFirst: boolean;
  branchName: string;
  suggestingBranch: boolean;
  /** Free-form push flags typed by the user, e.g. "--no-verify --tags". */
  flagsText: string;
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
  requestFlow: (request: GitFlowRequest) => void;
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
  request: null,
  commitMessage: "",
  stageAllFirst: false,
  branchName: "",
  suggestingBranch: false,
  flagsText: "",
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

  /**
   * Opens the wizard on the confirm stage after the git-flow hook refused
   * the agent's own commit/push/PR. A flow the user already started wins:
   * a late block (e.g. from an AI fix task) must not reset it.
   */
  requestFlow: (request) =>
    set((s) =>
      s.open
        ? s
        : {
            ...initial,
            open: true,
            stage: "confirm" as FlowStage,
            request,
            commitMessage: request.commitMessage ?? "",
            stageAllFirst: true,
          }
    ),
  close: () => set({ ...initial }),
  set: (patch) => set(patch),
  appendOutput: (chunk) => set((s) => ({ output: s.output + chunk })),
  clearOutput: () => set({ output: "" }),
}));
