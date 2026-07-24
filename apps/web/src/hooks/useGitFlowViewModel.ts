import { useCallback } from "react";
import type { MethodParams } from "@atelier/protocol";
import { newId } from "@atelier/shared";
import { bridge } from "@/services/bridge-client";
import { useGitFlowStore } from "@/state/git-flow.store";
import { useGitStore } from "@/state/git.store";
import { useSessionsStore } from "@/state/sessions.store";

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
        const result = await streamRun("git.commitRun", {
          message: state().commitMessage,
          stageAll,
        });
        useGitStore.getState().bumpStateVersion();
        if (result.ok) {
          patch({ running: false, stage: "push" });
        } else {
          patch({
            running: false,
            stage: "commit-fix",
            error: `Commit failed (exit ${result.exitCode})`,
          });
        }
      } catch (e) {
        patch({ running: false, stage: "commit-fix", error: errText(e) });
      }
    },
    [streamRun]
  );

  const validatePr = useCallback(async () => {
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

  const runPush = useCallback(async () => {
    const flags = state().flagsText.split(/\s+/).filter(Boolean);
    patch({ stage: "push" });
    try {
      const result = await streamRun("git.pushRun", { flags });
      useGitStore.getState().bumpStateVersion();
      if (!result.ok) {
        patch({
          running: false,
          stage: "push-fix",
          error: `Push failed (exit ${result.exitCode})`,
        });
        return;
      }
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
      // A rejected flag is an input mistake — stay on the push screen.
      const stage = text.includes("flag not allowed") ? "push" : "push-fix";
      patch({ running: false, stage, error: text });
    }
  }, [streamRun, validatePr]);

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
          const { name } = await bridge.rpc("git.suggestBranchName", {});
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
      const { taskId } = await bridge.rpc("task.start", {
        conversationId,
        prompt: buildFixPrompt(kind, s.output, s.conflicts, s.prBase, extraPrompt),
        model: FIX_MODEL,
        effort: "high",
      });
      sessions.taskStarted(conversationId, taskId);
    } catch (e) {
      patch({ error: errText(e) });
    }
  }, []);

  /** PR step 1: user said yes — draft description + load branches. */
  const beginPr = useCallback(async () => {
    const base = state().info?.defaultBranch ?? "main";
    patch({ stage: "pr-describe", prDrafting: true, prBase: base });
    try {
      const [{ branches }, draft] = await Promise.all([
        bridge.rpc("git.remoteBranches", {}),
        bridge.rpc("git.generatePrDescription", { base }),
      ]);
      patch({
        remoteBranches: branches,
        prTitle: draft.title,
        prBody: draft.body,
        prDrafting: false,
      });
    } catch (e) {
      patch({ prDrafting: false, error: errText(e) });
    }
  }, []);

  const createPrNow = useCallback(async () => {
    const s = state();
    patch({ stage: "pr-create" });
    try {
      const result = await streamRun("git.createPr", {
        base: s.prBase,
        title: s.prTitle,
        body: s.prBody,
      });
      if (result.ok) {
        patch({ running: false, stage: "done", prUrl: result.url ?? null });
      } else {
        patch({
          running: false,
          stage: "pr-fix",
          error: `PR creation failed (exit ${result.exitCode})`,
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
        // Base merged cleanly after all — push the merge and re-validate.
        patch({ afterPush: "pr-conflicts" });
        await runPush();
        return;
      }
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
    confirmRequest,
    confirmBranch,
    runPush,
    startFix,
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
    setPrBase: (v: string) => patch({ prBase: v }),
    close: () => useGitFlowStore.getState().close(),
  };
}

export type GitFlowViewModel = ReturnType<typeof useGitFlowViewModel>;

function buildFixPrompt(
  kind: FixKind,
  output: string,
  conflicts: string[],
  base: string,
  extra: string
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
  const parts = [
    intro[kind],
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
