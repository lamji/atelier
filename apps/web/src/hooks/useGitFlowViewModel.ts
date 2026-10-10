import { useCallback } from "react";
import type { MethodParams } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import { bridge } from "@/services/bridge-client";
import { alert } from "@/state/alerts.store";
import { useGitFlowStore } from "@/state/git-flow.store";
import { useGitStore } from "@/state/git.store";
import { useSessionsStore } from "@/state/sessions.store";
import { branchMatches } from "./useGitViewModel";
import { gitDraftModel } from "@/views/git/GitModelSelect";

/** Model for the AI repair loops, per the user's product decision. */
const FIX_MODEL = "claude-sonnet-5";
/** Only the tail of a failed run is fed to the fix agent. */
const OUTPUT_TAIL_CHARS = 8_000;

type FixKind = "commit" | "push" | "conflict" | "pr";

const FIX_KIND_BY_STAGE: Partial<Record<string, FixKind>> = {
  "commit-fix": "commit",
  "push-fix": "push",
  "conflict-fix": "conflict",
  "pr-fix": "pr",
};

/**
 * ViewModel for the commit → push → PR wizard. Owns every stage
 * transition; streamed command output lands in the flow store via RPC
 * progress chunks. AI fixes run as orchestrator tasks (Sonnet 5) in a
 * dedicated conversation whose messages stream through the existing
 * sessions store.
 */
/**
 * What is worth saying about the head branch before a request is opened.
 *
 * Deliberately warnings and not blocks. GitHub compares what it HAS — the
 * branch as pushed — so uncommitted work and unpushed commits simply are
 * not in the request. That is a thing to be told, not a reason to refuse:
 * plenty of requests are opened from a branch whose author is still
 * working, and forcing a push first is the app deciding for them.
 */
function prWarningsFor(input: {
  head: string;
  branches: string[];
  status: { files: unknown[]; ahead: number };
  info: { hasUpstream: boolean };
}): string[] {
  const warnings: string[] = [];
  if (!input.branches.includes(input.head)) {
    warnings.push(
      `${input.head} has never been pushed, so GitHub cannot see it yet. ` +
        "Creating the request will fail until it is pushed."
    );
  } else if (input.status.ahead > 0) {
    warnings.push(
      `${input.status.ahead} commit(s) on ${input.head} are not pushed. ` +
        "They will not be part of this request."
    );
  }
  if (input.status.files.length > 0) {
    warnings.push(
      `${input.status.files.length} file(s) have uncommitted changes. ` +
        "They will not be part of this request."
    );
  }
  return warnings;
}

/**
 * Whether the head branch has commits the remote has not seen.
 *
 * Read off the warning text rather than recomputed: prWarningsFor is the
 * one place that decides what "not pushed" means, and a second opinion
 * here is a second thing to keep in step.
 */
function needsPush(warnings: string[]): boolean {
  return warnings.some(
    (warning) => /never been pushed/.test(warning) || /are not pushed/.test(warning)
  );
}

export function useGitFlowViewModel() {
  const flow = useGitFlowStore();
  const fixSession = useSessionsStore((s) =>
    flow.fixConversationId ? (s.sessions[flow.fixConversationId] ?? null) : null
  );

  const state = () => useGitFlowStore.getState();
  const patch = (p: Parameters<typeof flow.set>[0]) => {
    // Never mutate the store after the user closed the modal.
    if (useGitFlowStore.getState().open) useGitFlowStore.getState().set(p);
  };

  /**
   * Streams one git/gh run into the output pane; returns the result. The
   * agent echoes the resolved command itself, so what the pane shows is
   * exactly what ran (including branch/upstream arguments).
   */
  const streamRun = useCallback(
    async <
      M extends "git.commitRun" | "git.pushRun" | "git.mergeRun" | "git.createPr",
    >(
      method: M,
      params: MethodParams<M>
    ) => {
      useGitFlowStore.getState().clearOutput();
      patch({ running: true, error: null });
      const { result } = await bridge.rpc(method, params, (p) => {
        if (p.chunk) useGitFlowStore.getState().appendOutput(p.chunk);
      });
      useGitFlowStore
        .getState()
        .appendOutput(`\n[exit ${result.exitCode}]\n`);
      return result;
    },
    []
  );

  const runCommit = useCallback(
    async (stageAll: boolean) => {
      patch({ stage: "commit" });
      try {
        // One commit per branch: once the branch owns exactly one, every
        // later commit rewrites it so the branch reads as a single dated
        // changelog rather than a trail of fixups. Never on the base
        // branch, and never past one commit — that would fold together
        // work the user chose to keep apart.
        const branch = await bridge
          .rpc("git.branchState", {})
          .then((r) => r.state)
          .catch(() => null);
        const amend = Boolean(branch && branch.ahead === 1 && !branch.onBase);
        const result = await streamRun("git.commitRun", {
          message: state().commitMessage,
          stageAll,
          amend,
        });
        useGitStore.getState().bumpStateVersion();
        if (result.ok) {
          alert.success(
            amend ? "Commit updated" : "Committed",
            firstLine(state().commitMessage) +
              (amend && branch?.hasUpstream
                ? " · push with --force-with-lease to update the remote"
                : "")
          );
          patch({ running: false, stage: "push" });
        } else {
          alert.danger(`Commit failed (exit ${result.exitCode})`, "hooks output is in the wizard");
          patch({
            running: false,
            stage: "commit-fix",
            error: `Commit failed (exit ${result.exitCode})`,
          });
        }
      } catch (e) {
        alert.danger("Commit failed", errText(e));
        patch({ running: false, stage: "commit-fix", error: errText(e) });
      }
    },
    [streamRun]
  );

  /**
   * The Create button. Warnings are surfaced once, here, and confirmed —
   * never enforced. A second press with the modal open means "yes".
   */
  const validatePr = useCallback(async () => {
    // No confirm here: the push check already put the warnings in front of
    // the user, as a screen, before anything was drafted. A second prompt
    // at the end would be asking the same question twice.
    patch({ stage: "pr-conflicts", running: true, error: null, conflicts: [] });
    try {
      const check = await bridge.rpc("git.checkConflicts", {
        base: state().prBase,
      });
      if (check.mergeable) {
        await createPrNow();
      } else {
        patch({ running: false, conflicts: check.conflicts });
      }
    } catch (e) {
      patch({ running: false, error: errText(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * A protected branch stops the wizard too.
   *
   * The Commit button already refuses before opening this flow, but the
   * flow can be entered from elsewhere (a git-flow request raised by the
   * agent, or a branch switched while it was open), and push is the step
   * that cannot be undone. Checked here as well, against the settings the
   * agent guard reads, so there is one rule and not two.
   */
  const protectionOnCurrentBranch = useCallback(async (): Promise<
    string | null
  > => {
    const [{ settings }, { status }] = await Promise.all([
      bridge.rpc("settings.get", {}),
      bridge.rpc("git.status", {}),
    ]);
    return (
      settings.protectedBranches.find((pattern) =>
        branchMatches(status.branch, pattern)
      ) ?? null
    );
  }, []);

  const runPush = useCallback(async () => {
    const flags = state().flagsText.split(/\s+/).filter(Boolean);
    patch({ stage: "push" });
    try {
      const blocked = await protectionOnCurrentBranch().catch(() => null);
      if (blocked) {
        const message =
          `This branch is protected by the rule "${blocked}", so it cannot ` +
          "be pushed. Switch to a working branch, or remove the protection " +
          "in the git panel's Protected tab.";
        alert.danger("Push blocked — protected branch", message);
        patch({ running: false, stage: "push", error: message });
        return;
      }
      const result = await streamRun("git.pushRun", { flags });
      useGitStore.getState().bumpStateVersion();
      if (!result.ok) {
        alert.danger(`Push failed (exit ${result.exitCode})`, "see the wizard output");
        patch({
          running: false,
          stage: "push-fix",
          error: `Push failed (exit ${result.exitCode})`,
        });
        return;
      }
      alert.success("Pushed to origin", state().info?.branch);
      const next = state().afterPush;
      if (next === "done") {
        patch({ running: false, stage: "done" });
      } else if (next === "pr-conflicts") {
        await validatePr();
      } else {
        patch({ running: false, stage: "pr-ask" });
      }
    } catch (e) {
      const text = errText(e);
      alert.danger("Push failed", text);
      // A rejected flag is an input mistake — stay on the push screen.
      const stage = text.includes("flag not allowed") ? "push" : "push-fix";
      patch({ running: false, stage, error: text });
    }
  }, [streamRun, validatePr, protectionOnCurrentBranch]);

  /**
   * Entry point for commits made outside the wizard (e.g. from a
   * terminal) that are ahead of the remote with nothing left to commit —
   * there is otherwise no way to push them. Opens straight on the push
   * stage instead of running `startFlow`'s commit step.
   */
  const startPush = useCallback(async () => {
    useGitFlowStore.getState().openFlow("", false);
    patch({ stage: "push" });
    try {
      const { info } = await bridge.rpc("git.flowInfo", {});
      patch({ info });
    } catch (e) {
      patch({ stage: "done", error: errText(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Entry point: called by the git panel's Commit button. */
  const startFlow = useCallback(
    async (commitMessage: string, stageAllFirst: boolean) => {
      useGitFlowStore.getState().openFlow(commitMessage, stageAllFirst);
      try {
        const { info } = await bridge.rpc("git.flowInfo", {});
        patch({ info });
        if (!info.hasRemote) {
          patch({ stage: "done", error: "Connect a GitHub remote first." });
          return;
        }
        if (!info.hasCommits) {
          // Bootstrap: first commit ever — stay on the default branch,
          // push -u, and skip the PR step (nothing to compare against).
          patch({ afterPush: "done" });
          await runCommit(state().stageAllFirst);
          return;
        }
        if (info.branch === info.defaultBranch) {
          patch({ stage: "branch", suggestingBranch: true });
          const { name } = await bridge.rpc("git.suggestBranchName", {
            model: gitDraftModel(),
          });
          patch({ branchName: name, suggestingBranch: false });
          return;
        }
        await runCommit(state().stageAllFirst);
      } catch (e) {
        patch({ stage: "done", error: errText(e), suggestingBranch: false });
      }
    },
    [runCommit]
  );

  /**
   * Confirm stage: the user accepted the flow the agent was blocked from
   * running. From here it is an ordinary user-driven flow.
   */
  const confirmRequest = useCallback(async () => {
    const message = state().commitMessage.trim();
    if (!message) return;
    await startFlow(message, true);
  }, [startFlow]);

  /** Branch stage: create the feature branch, then commit on it. */
  const confirmBranch = useCallback(async () => {
    const name = state().branchName.trim();
    if (!name) return;
    patch({ running: true, error: null });
    try {
      await bridge.rpc("git.checkout", { ref: name, create: true });
      alert.success(`Created branch ${name}`);
      useGitStore.getState().bumpStateVersion();
      // The header shows the branch — keep it truthful after the switch.
      const info = state().info;
      if (info) patch({ info: { ...info, branch: name } });
      await runCommit(state().stageAllFirst);
    } catch (e) {
      patch({ running: false, error: errText(e) });
    }
  }, [runCommit]);

  /** Starts (or continues) the Sonnet 5 fix task for the current failure. */
  const startFix = useCallback(async (extraPrompt: string) => {
    const s = state();
    const kind = FIX_KIND_BY_STAGE[s.stage];
    if (!kind) return;
    try {
      let conversationId = s.fixConversationId;
      if (!conversationId) {
        const { conversation } = await bridge.rpc(
          "session.createConversation",
          { title: `Git fix: ${kind}` }
        );
        useSessionsStore.getState().addSession(conversation, false);
        conversationId = conversation.id;
        patch({ fixConversationId: conversationId });
      }
      const sessions = useSessionsStore.getState();
      sessions.addUserMessage(
        conversationId,
        newId("local"),
        extraPrompt || `Fix the failed ${kind} step`
      );
      // The failure belongs to ONE checkout. Without this the fix agent
      // treats a multi-repo workspace as its search space and reads every
      // sibling repo's .git/config looking for the one that failed.
      const repo = s.info?.repo;
      const { taskId } = await bridge.rpc("task.start", {
        conversationId,
        prompt: buildFixPrompt(
          kind,
          s.output,
          s.conflicts,
          s.prBase,
          extraPrompt,
          repo
        ),
        model: FIX_MODEL,
        effort: "high",
        scopeRoots: repo && repo !== "." ? [repo] : undefined,
      });
      sessions.taskStarted(conversationId, taskId);
    } catch (e) {
      patch({ error: errText(e) });
    }
  }, []);

  /**
   * Stop the running fix. Same contract as the composer's stop button:
   * the agent finishes its in-flight step, so the button only reports
   * "Stopping…" until a real end event (cancelled / completed / error)
   * clears it. Without this the modal's only exit from a fix that is
   * going the wrong way is closing the whole wizard.
   */
  const cancelFix = useCallback(() => {
    const conversationId = state().fixConversationId;
    if (!conversationId) return;
    const sessions = useSessionsStore.getState();
    const taskId = sessions.sessions[conversationId]?.activeTaskId;
    if (!taskId) return;
    sessions.taskCancelling(conversationId);
    void bridge.rpc("task.cancel", { taskId }).catch(() => {
      // Task already finished; the store clears on its end event.
    });
  }, []);

  /**
   * Drafts the PR title and body against ONE base.
   *
   * Always takes the base explicitly. The description is a statement about
   * a commit RANGE, and the range is `origin/<base>..HEAD` — so a draft and
   * the base it was written against are one fact, and reading the base from
   * state at some later point is how they come apart.
   */
  /**
   * Drafts the PR title and body for ONE head/base pair.
   *
   * Never runs on its own when the screen opens. The branches are the
   * question the screen exists to ask, and drafting before they are settled
   * both spends a model call on a comparison the user is about to change
   * and — as this screen proved — leaves a description standing that
   * describes some other pair entirely.
   */
  /**
   * Which forge accounts could open this PR, and which one this checkout
   * points at.
   *
   * Loaded alongside the draft because the describe step is where both are
   * chosen. The suggestion is applied only while the user has not picked
   * an account themselves — re-entering the step must not silently undo
   * their choice.
   */
  const loadPrCredentials = useCallback(async () => {
    try {
      const found = await bridge.rpc("git.prCredentials", {});
      const now = useGitFlowStore.getState();
      patch({
        prCredentials: found.credentials,
        prIdentity: found.identity ?? "",
        ...(now.prCredentialId === undefined && found.suggestedId
          ? { prCredentialId: found.suggestedId }
          : {}),
      });
    } catch {
      // A picker that cannot load is not a reason to block the PR: the
      // create call falls back to picking an account by itself.
    }
  }, []);

  const draftPr = useCallback(async (base: string, head?: string) => {
    void loadPrCredentials();
    patch({ prDrafting: true });
    try {
      const draft = await bridge.rpc("git.generatePrDescription", {
        base,
        head,
        // The git screen's own provider/model pick, not the chat's.
        model: gitDraftModel(),
      });
      // The user may have moved the picker again while this was in flight;
      // a late answer must not overwrite a newer one.
      const now = useGitFlowStore.getState();
      if (now.prBase !== base || (head && now.prHead !== head)) return;
      patch({
        prTitle: draft.title,
        prBody: draft.body,
        prDrafting: false,
        prDraftedFor: base,
      });
    } catch (e) {
      patch({ prDrafting: false, error: errText(e) });
    }
  }, [loadPrCredentials]);

  /** PR step 1: user said yes — draft description + load branches. */
  const beginPr = useCallback(async () => {
    const base = state().info?.defaultBranch ?? "main";
    patch({ stage: "pr-compare", prDrafting: false, prBase: base });
    try {
      const [{ branches }, { status }] = await Promise.all([
        bridge.rpc("git.remoteBranches", {}),
        bridge.rpc("git.status", {}),
      ]);
      const head = state().info?.branch ?? "";
      patch({
        remoteBranches: branches,
        prHead: head,
        prWarnings: head
          ? prWarningsFor({
              head,
              branches,
              status,
              info: state().info ?? { hasUpstream: false },
            })
          : [],
        prDrafting: false,
      });
    } catch (e) {
      patch({ prDrafting: false, error: errText(e) });
    }
  }, []);

  /**
   * Entry point for "New pull request" in the Requests pane.
   *
   * Opens straight on the description step, the way GitHub's own button
   * does: the branch already exists and its commits are already made, so
   * the only question left is what the request says. A branch that has
   * never been pushed is pushed first — GitHub cannot open a request for
   * commits it has not seen, and sending the user back to do it by hand
   * would be a worse answer than doing it.
   */
  const startPr = useCallback(async () => {
    useGitFlowStore.getState().openFlow("", false);
    patch({ stage: "pr-compare", prDrafting: false, afterPush: "pr-ask" });
    try {
      const [{ info }, { branches }, { status }] = await Promise.all([
        bridge.rpc("git.flowInfo", {}),
        bridge.rpc("git.remoteBranches", {}),
        bridge.rpc("git.status", {}),
      ]);
      patch({ info, remoteBranches: branches });
      if (!info.hasRemote) {
        patch({
          stage: "done",
          prDrafting: false,
          error: "Connect a GitHub remote first.",
        });
        return;
      }
      // Two branches, the way GitHub's compare page does it — and nothing
      // is pushed to get here. A branch with no remote copy is a warning
      // to confirm, not a wall: GitHub opens the request from what it can
      // see, and being told that is better than being made to push first.
      const head = info.branch;
      const base =
        info.defaultBranch && info.defaultBranch !== head
          ? info.defaultBranch
          : (branches.find((b) => b !== head) ?? info.defaultBranch ?? "main");
      patch({
        prHead: head,
        prBase: base,
        prWarnings: prWarningsFor({ head, branches, status, info }),
        // Not drafted yet, on purpose — see draftPr.
        prDrafting: false,
      });
    } catch (e) {
      patch({ stage: "done", prDrafting: false, error: errText(e) });
    }
  }, []);

  const createPrNow = useCallback(async () => {
    const s = state();
    patch({ stage: "pr-create" });
    try {
      const result = await streamRun("git.createPr", {
        base: s.prBase,
        head: s.prHead || undefined,
        title: s.prTitle,
        body: s.prBody,
        ...(s.prCredentialId ? { credentialId: s.prCredentialId } : {}),
      });
      if (result.ok) {
        alert.success("Pull request created", result.url);
        patch({ running: false, stage: "done", prUrl: result.url ?? null });
        // The Requests pane learns about it now, not on its next poll.
        useGitStore.getState().bumpStateVersion();
        useGitStore.getState().nudgeRequests();
      } else {
        alert.danger(`PR creation failed (exit ${result.exitCode})`, "see the wizard output");
        patch({
          running: false,
          stage: "pr-fix",
          error: `PR creation failed (exit ${result.exitCode})`,
          // gh may have failed for a reason no code edit can fix (wrong
          // account, missing scope, org SSO). The compare page is the same
          // PR, opened by hand.
          prCompareUrl: result.fallbackUrl ?? null,
        });
      }
    } catch (e) {
      patch({ running: false, stage: "pr-fix", error: errText(e) });
    }
  }, [streamRun]);

  /** Conflict stage: really merge the base so the AI can resolve files. */
  const resolveConflicts = useCallback(async () => {
    const base = state().prBase;
    try {
      const result = await streamRun("git.mergeRun", { base });
      useGitStore.getState().bumpStateVersion();
      if (result.ok) {
        alert.success(`Merged origin/${base}`, "no conflicts");
        // Base merged cleanly after all — push the merge and re-validate.
        patch({ afterPush: "pr-conflicts" });
        await runPush();
        return;
      }
      alert.warning(`Merging origin/${base} left conflicts`, "the wizard's AI fix can resolve them");
      patch({
        running: false,
        stage: "conflict-fix",
        commitMessage: `Merge origin/${base}`,
        error: "Merge left conflicts in the working tree",
      });
    } catch (e) {
      patch({ running: false, stage: "conflict-fix", error: errText(e) });
    }
  }, [streamRun, runPush]);

  /** After the AI resolved conflicts: commit the merge, push, re-check. */
  const commitMergeAndContinue = useCallback(async () => {
    patch({ afterPush: "pr-conflicts" });
    await runCommit(true);
  }, [runCommit]);

  /** The contextual re-run button in each fix stage. */
  const reRunAfterFix = useCallback(async () => {
    switch (state().stage) {
      case "commit-fix":
        await runCommit(true);
        break;
      case "push-fix":
        await runPush();
        break;
      case "conflict-fix":
        await commitMergeAndContinue();
        break;
      case "pr-fix":
        await createPrNow();
        break;
    }
  }, [runCommit, runPush, commitMergeAndContinue, createPrNow]);

  const skipPr = useCallback(() => {
    patch({ stage: "done" });
  }, []);

  return {
    flow,
    fixSession,
    startFlow,
    startPush,
    confirmRequest,
    confirmBranch,
    runPush,
    startFix,
    cancelFix,
    reRunAfterFix,
    beginPr,
    skipPr,
    validatePr,
    resolveConflicts,
    setCommitMessage: (v: string) => patch({ commitMessage: v }),
    setBranchName: (name: string) => patch({ branchName: name }),
    setFlagsText: (v: string) => patch({ flagsText: v }),
    setPrTitle: (v: string) => patch({ prTitle: v }),
    setPrBody: (v: string) => patch({ prBody: v }),
    /** Pin the account that opens the PR; undefined means automatic. */
    selectPrCredential: (id?: string) => patch({ prCredentialId: id }),
    reloadPrCredentials: () => void loadPrCredentials(),
    /**
     * Changing the base changes what the PR IS, so the description is
     * redrafted for it.
     *
     * Without this the draft was written once against the repository's
     * DEFAULT branch and never revisited: picking `SPDNX-Dev` moved the
     * base used to create the PR and check conflicts, while the title and
     * body went on describing every commit since `main`. A branch fixing
     * tag management was proposed as a multitenancy platform migration.
     */
    startPr,
    /** Recomputes warnings and redrafts when the head branch changes. */
    setPrHead: (v: string) => {
      if (v === useGitFlowStore.getState().prHead) return;
      patch({ prHead: v });
      void bridge
        .rpc("git.status", {})
        .then(({ status }) => {
          const now = useGitFlowStore.getState();
          if (now.prHead !== v) return;
          patch({
            prWarnings: prWarningsFor({
              head: v,
              branches: now.remoteBranches,
              status,
              info: now.info ?? { hasUpstream: false },
            }),
          });
        })
        .catch(() => undefined);
      // Only if there is already a draft to keep in step. Before that the
      // user is still choosing, and drafting under them would spend a model
      // call on a comparison they are about to change.
      if (useGitFlowStore.getState().prDraftedFor) {
        void draftPr(useGitFlowStore.getState().prBase, v);
      }
    },
    setPrBase: (v: string) => {
      if (v === useGitFlowStore.getState().prBase) return;
      patch({ prBase: v });
      if (useGitFlowStore.getState().prDraftedFor) {
        void draftPr(v, useGitFlowStore.getState().prHead || undefined);
      }
    },
    /**
     * The Continue button on the compare screen.
     *
     * Validates the chosen head before spending anything on a draft: if
     * its commits are not all on the remote, the screen is REPLACED by the
     * push check, because that decision changes what the request will
     * contain. Otherwise it goes straight to drafting.
     */
    generatePr: () => {
      const now = useGitFlowStore.getState();
      // ANY warning, not only a missing push: uncommitted work is left out
      // of the request just as silently, and one screen that states both is
      // better than one gate here and another at create time.
      if (now.stage === "pr-compare" && now.prWarnings.length > 0) {
        patch({ stage: "pr-push-check" });
        return;
      }
      patch({ stage: "pr-describe" });
      void draftPr(now.prBase, now.prHead || undefined);
    },
    /** Back out of the push check to the compare form. */
    backToCompare: () => patch({ stage: "pr-compare", error: null }),
    /** "Proceed anyway": open the request from what the remote already has. */
    skipPushAndDraft: () => {
      const now = useGitFlowStore.getState();
      patch({ stage: "pr-describe" });
      void draftPr(now.prBase, now.prHead || undefined);
    },
    /**
     * "Push now": sends the branch, refreshes what is true of it, then
     * drafts. `pushRun` adds `-u origin <branch>` itself when the branch
     * has no upstream, so a never-pushed branch works from here too.
     */
    pushThenDraft: async () => {
      patch({ running: true, error: null });
      useGitFlowStore.getState().clearOutput();
      try {
        const { result } = await bridge.rpc("git.pushRun", { flags: [] }, (p) => {
          if (p.chunk) useGitFlowStore.getState().appendOutput(p.chunk);
        });
        useGitStore.getState().bumpStateVersion();
        if (!result.ok) {
          alert.danger(`Push failed (exit ${result.exitCode})`, "see the output");
          patch({ running: false, error: `Push failed (exit ${result.exitCode})` });
          return;
        }
        alert.success("Pushed to origin", useGitFlowStore.getState().prHead);
        const [{ branches }, { status }] = await Promise.all([
          bridge.rpc("git.remoteBranches", {}),
          bridge.rpc("git.status", {}),
        ]);
        const now = useGitFlowStore.getState();
        patch({
          running: false,
          remoteBranches: branches,
          stage: "pr-describe",
          prWarnings: prWarningsFor({
            head: now.prHead,
            branches,
            status,
            info: now.info ?? { hasUpstream: true },
          }),
        });
        void draftPr(now.prBase, now.prHead || undefined);
      } catch (e) {
        alert.danger("Push failed", errText(e));
        patch({ running: false, error: errText(e) });
      }
    },
    close: () => useGitFlowStore.getState().close(),
  };
}

export type GitFlowViewModel = ReturnType<typeof useGitFlowViewModel>;

/**
 * The scope rule for hook failures, and the one the fix agent got wrong:
 * told "staged backend code changes require staged test updates", it went
 * and refactored the staged source to be "more testable". That staged diff
 * is what the user already reviewed and approved — rewriting it to satisfy
 * a hook silently replaces their change with the agent's.
 *
 * The distinction the agent has to make is what the hook is complaining
 * about: a MISSING artifact (write it) versus a DEFECT in the staged code
 * (fix it there).
 */
const HOOK_SCOPE_RULE =
  "SCOPE — read what the hook is actually demanding before you edit:\n" +
  "- If it demands a MISSING ARTIFACT (a test, a changelog entry, docs, " +
  "a snapshot), then CREATE OR UPDATE ONLY THAT ARTIFACT and `git add` " +
  "it. Write the test against the staged code exactly as it is now.\n" +
  "- Do NOT modify, refactor, reformat, or restructure the already-staged " +
  "source to make it easier to test, tidier, or better factored. That " +
  "diff was reviewed and approved by the user; changing it here replaces " +
  "their work with yours, and the hook did not ask for it.\n" +
  "- Touch staged source ONLY when the hook reports a real defect IN it " +
  "(a lint or type error, a failing assertion, a formatting rule) — then " +
  "fix that exact defect and nothing else.\n" +
  "- If the artifact genuinely cannot be written without a source change " +
  "(the code under test is unreachable — unexported, no seam, no entry " +
  "point), make the SMALLEST change that opens it up, and say in one " +
  "line what you changed and why it was unavoidable.";

function buildFixPrompt(
  kind: FixKind,
  output: string,
  conflicts: string[],
  base: string,
  extra: string,
  /** The checkout that failed, workspace-relative ("." at the root). */
  repo?: string
): string {
  const intro: Record<FixKind, string> = {
    commit:
      "A `git commit` in this workspace just failed — most likely a " +
      "commit hook (lint, tests, formatting).",
    push:
      "A `git push` from this workspace just failed — a push hook or a " +
      "remote-side rejection.",
    conflict:
      `A merge of origin/${base} left conflict markers in the working ` +
      "tree. Resolve EVERY conflicted file listed below by editing it — " +
      "keep both sides' intent, remove all <<<<<<</=======/>>>>>>> markers.",
    pr: "A `gh pr create` for this workspace just failed.",
  };
  const where =
    repo && repo !== "."
      ? ` The repository is \`${repo}/\` — the workspace holds other ` +
        "checkouts, and none of them are involved. Read, search and edit " +
        `ONLY inside \`${repo}/\`.`
      : "";
  const parts = [
    intro[kind] + where,
    "",
    "Command output:",
    "```",
    output.slice(-OUTPUT_TAIL_CHARS),
    "```",
  ];
  if (kind === "conflict" && conflicts.length > 0) {
    parts.push("", "Conflicted files:", ...conflicts.map((f) => `- ${f}`));
  }
  if (extra.trim()) {
    parts.push("", `Additional instructions from the user: ${extra.trim()}`);
  }
  if (kind === "commit" || kind === "push") parts.push("", HOOK_SCOPE_RULE);
  parts.push(
    "",
    "Fix the underlying problem by editing files in the workspace. Do " +
      "NOT run `git commit`, `git push`, or `gh` yourself — the flow " +
      "re-runs the failed step after you finish. End with a one-line " +
      "summary of what you changed."
  );
  return parts.join("\n");
}

function errText(e: unknown): string {
  return String(e).replace(/^Error:\s*/, "").slice(0, 300);
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim().slice(0, 72);
}
