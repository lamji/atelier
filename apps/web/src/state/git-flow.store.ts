import { create } from "zustand";
import type {
  GitFlowInfo,
  GitFlowRequest,
  GitForgeCredential,
} from "@atelier/protocol";

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
  /** Step 1: pick head and base. Nothing is drafted or pushed yet. */
  | "pr-compare"
  | "pr-describe"
  /**
   * The head branch is not fully on the remote, shown BEFORE anything is
   * drafted. Its own stage rather than an inline note because the choice —
   * push, or open the request without those commits — decides what the
   * request will contain, and a decision that changes the answer should
   * not sit beside the answer.
   */
  | "pr-push-check"
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
  /**
   * Base the current draft was actually written against.
   *
   * Kept beside prBase so the modal can say when the two disagree. A
   * description is a claim about a commit range; showing one drafted for
   * another base without saying so is how a tag-management branch got
   * proposed as a platform migration.
   */
  prDraftedFor: string;
  /** Branch the request merges FROM — the compare screen's left side. */
  prHead: string;
  /**
   * What is true of the head branch that the user may not want to discover
   * after the fact: uncommitted work, commits not pushed, no remote copy at
   * all. Not errors — GitHub opens the request anyway, from what it can
   * see — so they are shown and confirmed rather than enforced.
   */
  prWarnings: string[];
  prTitle: string;
  prBody: string;
  prDrafting: boolean;
  /** Forge accounts that could open this PR — the describe step's picker. */
  prCredentials: GitForgeCredential[];
  /**
   * Account chosen for the create call, or undefined for automatic.
   *
   * Defaults to the credential matching the identity git pushes as: a
   * machine with two GitHub logins would otherwise open the PR as
   * whichever account `gh` happens to have active, which is how a pushed
   * branch met "Could not resolve to a Repository".
   */
  prCredentialId: string | undefined;
  /** Login git authenticates as on this checkout, for the picker's hint. */
  prIdentity: string;
  conflicts: string[];
  prUrl: string | null;
  /**
   * Set when `gh pr create` failed: the github.com compare page for this
   * branch. A gh auth problem is not a reason the user cannot open the PR.
   */
  prCompareUrl: string | null;

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
  prDraftedFor: "",
  prHead: "",
  prWarnings: [] as string[],
  prTitle: "",
  prBody: "",
  prDrafting: false,
  prCredentials: [] as GitForgeCredential[],
  prCredentialId: undefined as string | undefined,
  prIdentity: "",
  conflicts: [],
  prUrl: null,
  prCompareUrl: null,
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
