import { useCallback, useEffect, useMemo, useRef } from "react";
import type { GitPullMode } from "@atelier/protocol";
import type { SyncModalKind } from "@/state/git-merge.store";
import { newId } from "@atelier/shared";
import { bridge } from "@/services/bridge-client";
import { errorText } from "@/lib/error-text";
import { alert } from "@/state/alerts.store";
import { useGitMergeStore } from "@/state/git-merge.store";
import { useGitStore } from "@/state/git.store";
import { useSessionsStore } from "@/state/sessions.store";
import { useWorkspaceStore } from "@/state/workspace.store";

/** Same model the commit/push repair loop uses — the user's product call. */
const AI_MODEL = "claude-sonnet-5";
/** Only the tail of the streamed pull output travels into the AI prompt. */
const OUTPUT_TAIL_CHARS = 6_000;

/**
 * ViewModel for the sync row and the merge-conflict flow: fetch/pull/push,
 * the per-file resolver, whole-side resolutions, abort/complete, and the
 * AI repair task. Every mutation ends by bumping the git store's
 * stateVersion so the panel, the explorer badges and the dock all
 * refetch from the same `git.status`.
 */
export function useMergeConflictViewModel() {
  const status = useGitStore((s) => s.status);
  const merge = useGitMergeStore();
  const aiSession = useSessionsStore((s) =>
    merge.aiConversationId
      ? (s.sessions[merge.aiConversationId] ?? null)
      : null
  );

  const conflicts = useMemo(() => status?.conflicts ?? [], [status]);
  const mergeState = status?.mergeState ?? null;
  const aiWorking = aiSession?.status === "working";

  const store = () => useGitMergeStore.getState();
  const bump = () => useGitStore.getState().bumpStateVersion();

  /**
   * Streams one sync command into the output drawer. The agent echoes the
   * resolved command line first, so the drawer shows exactly what ran.
   */
  const fetch = useCallback(async () => {
    store().startRun("fetch");
    try {
      store().appendOutput("$ git fetch --prune\n");
      const counts = await bridge.rpc("git.fetch", {});
      store().appendOutput(
        `Fetched. ${counts.behind} behind · ${counts.ahead} ahead\n`
      );
      store().set({ syncRunning: false });
      alert.success(
        "Fetched origin",
        counts.behind === 0 && counts.ahead === 0
          ? "up to date"
          : `${counts.behind} behind · ${counts.ahead} ahead`
      );
      // The pickers list refs from the local store; a fetch just moved them.
      if (store().syncModal) void loadRefsQuiet();
    } catch (e) {
      store().set({ syncRunning: false, syncError: errText(e) });
      alert.danger("Fetch failed", errText(e));
    } finally {
      bump();
    }
  }, []);

  const pull = useCallback(async (opts?: PullOptions) => {
    const chosen = opts?.mode ?? store().pullMode;
    store().startRun("pull");
    store().set({ pullMode: chosen });
    try {
      const outcome = await bridge.rpc(
        "git.pullRun",
        { mode: chosen, remote: opts?.remote, branch: opts?.branch },
        (p) => {
          if (p.chunk) store().appendOutput(p.chunk);
        }
      );
      store().appendOutput(`\n[exit ${outcome.result.exitCode}]\n`);
      const conflicted = outcome.conflicts.length > 0;
      const n = outcome.conflicts.length;
      if (outcome.result.ok) {
        alert.success(
          "Pulled from origin",
          /Already up to date/i.test(outcome.result.output)
            ? "already up to date"
            : `${chosen} · ${summarizePull(outcome.result.output)}`
        );
      } else if (conflicted) {
        alert.warning(
          `Pull stopped: ${n} conflict${n === 1 ? "" : "s"}`,
          "resolve them below, then complete the merge",
          {
            action: {
              label: "Resolve",
              run: () => useWorkspaceStore.getState().setActivityView("git"),
            },
          }
        );
      } else {
        alert.danger(
          `Pull failed (exit ${outcome.result.exitCode})`,
          lastLine(outcome.result.output)
        );
      }
      store().set({
        syncRunning: false,
        // A conflicted pull is the merge flow's normal entry, not an error;
        // the banner takes over. Anything else that failed stays visible.
        syncError:
          outcome.result.ok || conflicted
            ? null
            : `Pull failed (exit ${outcome.result.exitCode})`,
        // Fold the drawer so the conflict banner is the first thing seen.
        outputOpen: !conflicted,
        aiResolved: [],
        aiSummary: null,
        lastRun: {
          kind: "pull",
          ok: outcome.result.ok,
          exitCode: outcome.result.exitCode,
          conflicts: n,
          summary: outcome.result.ok
            ? summarizePull(outcome.result.output)
            : conflicted
              ? `${n} conflict${n === 1 ? "" : "s"} to resolve`
              : lastLine(outcome.result.output),
        },
      });
    } catch (e) {
      store().set({ syncRunning: false, syncError: errText(e) });
      alert.danger("Pull failed", errText(e));
    } finally {
      bump();
    }
  }, []);

  /** Streamed checkout from the picker (local, remote-tracking, or new). */
  const checkoutRun = useCallback(async (opts: CheckoutOptions) => {
    store().startRun("checkout");
    try {
      const { result } = await bridge.rpc(
        "git.checkoutRun",
        {
          ref: opts.ref,
          create: opts.create,
          track: opts.track,
          from: opts.from,
        },
        (p) => {
          if (p.chunk) store().appendOutput(p.chunk);
        }
      );
      store().appendOutput(`\n[exit ${result.exitCode}]\n`);
      store().set({
        syncRunning: false,
        syncError: result.ok ? null : `Checkout failed (exit ${result.exitCode})`,
        lastRun: {
          kind: "checkout",
          ok: result.ok,
          exitCode: result.exitCode,
          conflicts: 0,
          summary: lastLine(result.output),
        },
      });
      if (result.ok) {
        alert.success(
          opts.create
            ? `Branched out ${opts.ref}`
            : opts.track
              ? `Checked out ${opts.ref}`
              : `Switched to ${opts.ref}`,
          opts.create && opts.from
            ? `from ${opts.from}`
            : opts.track
              ? `tracking ${opts.track}`
              : undefined
        );
      } else {
        alert.danger(
          `${opts.create ? "Branch out" : "Checkout"} failed ` +
            `(exit ${result.exitCode})`,
          lastLine(result.output)
        );
      }
    } catch (e) {
      store().set({ syncRunning: false, syncError: errText(e) });
      alert.danger("Checkout failed", errText(e));
    } finally {
      bump();
      void loadRefs();
    }
  }, []);

  /** Refs for the pickers; cheap (no network), so refreshed on every open. */
  const loadRefs = useCallback(async () => {
    store().set({ refsLoading: true });
    try {
      const { refs } = await bridge.rpc("git.refs", {});
      store().set({ refs, refsLoading: false });
    } catch (e) {
      store().set({ refsLoading: false, syncError: errText(e) });
    }
  }, []);

  const openSync = useCallback(
    (kind: SyncModalKind) => {
      store().openSyncModal(kind);
      void loadRefs();
    },
    [loadRefs]
  );

  const closeSync = useCallback(() => store().closeSyncModal(), []);

  const loadConflict = useCallback(loadConflictFile, []);
  const openConflict = useCallback(openConflictFile, []);

  const closeConflict = useCallback(() => store().closeConflict(), []);

  /** The next unresolved file after `path`, wrapping; null when none. */
  const nextConflictAfter = useCallback(
    (path: string): string | null => {
      const list = useGitStore.getState().status?.conflicts ?? [];
      const rest = list.filter((p) => p !== path);
      if (rest.length === 0) return null;
      const idx = list.indexOf(path);
      return rest[idx === -1 ? 0 : idx % rest.length] ?? rest[0] ?? null;
    },
    []
  );

  /** Autosave: the resolver's buffer to disk, conflict left open. */
  const saveDraft = useCallback(async (path: string, content: string) => {
    await bridge.rpc("git.resolveConflict", { path, content, stage: false });
  }, []);

  /**
   * Writes + stages, which is what tells git the file is settled, then
   * moves the resolver on to the next unresolved file (or closes it).
   */
  const markResolved = useCallback(
    async (path: string, content: string) => {
      try {
        await bridge.rpc("git.resolveConflict", { path, content, stage: true });
      } catch (e) {
        alert.danger(`Could not mark ${path} resolved`, errText(e));
        throw e;
      }
      const next = nextConflictAfter(path);
      const left = useGitStore.getState().status?.conflicts.filter((p) => p !== path).length ?? 0;
      alert.success(
        `Resolved ${path}`,
        left === 0 ? "all conflicts resolved — complete the merge" : `${left} left`
      );
      if (next) openConflict(next);
      else store().closeConflict();
      bump();
    },
    [nextConflictAfter, openConflict]
  );

  const takeSide = useCallback(
    async (paths: string[], side: "ours" | "theirs") => {
      try {
        await bridge.rpc("git.resolveConflictWith", { paths, side });
      } catch (e) {
        alert.danger(`Could not take ${side}`, errText(e));
        throw e;
      }
      alert.success(
        `Took ${side === "ours" ? "our" : "their"} side`,
        paths.length === 1 ? paths[0] : `${paths.length} files`
      );
      const open = store().openPath;
      if (open && paths.includes(open)) {
        const next = nextConflictAfter(open);
        if (next && !paths.includes(next)) openConflict(next);
        else store().closeConflict();
      }
      bump();
    },
    [nextConflictAfter, openConflict]
  );

  /** Undo a resolution: markers come back, the file is unmerged again. */
  const restore = useCallback(
    async (path: string) => {
      try {
        await bridge.rpc("git.restoreConflict", { path });
      } catch (e) {
        alert.danger(`Could not restore ${path}`, errText(e));
        throw e;
      }
      alert.info(`Restored conflict markers in ${path}`);
      store().set({
        aiResolved: store().aiResolved.filter((p) => p !== path),
      });
      if (store().openPath === path) void loadConflict(path);
      bump();
    },
    [loadConflict]
  );

  const abort = useCallback(async () => {
    const kind = useGitStore.getState().status?.mergeState?.kind ?? "merge";
    try {
      await bridge.rpc("git.mergeAbort", {});
    } catch (e) {
      alert.danger(`Could not abort the ${kind}`, errText(e));
      throw e;
    }
    alert.warning(`${capitalize(kind)} aborted`, "working tree restored");
    store().closeConflict();
    store().set({ aiResolved: [], aiSummary: null, syncError: null });
    bump();
  }, []);

  /** Finishes the merge/rebase; streamed like a pull. */
  const complete = useCallback(async (message?: string) => {
    const kind = useGitStore.getState().status?.mergeState?.kind ?? "merge";
    store().startRun("continue");
    try {
      const { result } = await bridge.rpc(
        "git.mergeContinueRun",
        message ? { message } : {},
        (p) => {
          if (p.chunk) store().appendOutput(p.chunk);
        }
      );
      store().appendOutput(`\n[exit ${result.exitCode}]\n`);
      if (result.ok) {
        store().closeConflict();
        store().set({
          syncRunning: false,
          aiResolved: [],
          aiSummary: null,
          outputOpen: false,
        });
        alert.success(
          kind === "merge" ? "Merge committed" : `${capitalize(kind)} continued`,
          lastLine(result.output)
        );
      } else {
        store().set({
          syncRunning: false,
          syncError: `Could not complete (exit ${result.exitCode})`,
        });
        alert.danger(
          `Could not complete the ${kind} (exit ${result.exitCode})`,
          lastLine(result.output)
        );
      }
    } catch (e) {
      store().set({ syncRunning: false, syncError: errText(e) });
      alert.danger(`Could not complete the ${kind}`, errText(e));
    } finally {
      bump();
    }
  }, []);

  /**
   * Starts (or continues) the Sonnet repair task for `paths`. Runs in a
   * dedicated conversation, confined to the checkout, and edits files
   * only — staging and completing stay with the user (and with the
   * post-run scan below, which stages the files it left marker-free).
   */
  const aiResolve = useCallback(
    async (paths: string[], extraPrompt = "") => {
      if (paths.length === 0) return;
      const s = store();
      const info = useGitStore.getState().status;
      try {
        let conversationId = s.aiConversationId;
        if (!conversationId) {
          const { conversation } = await bridge.rpc(
            "session.createConversation",
            { title: "Merge: resolve conflicts" }
          );
          useSessionsStore.getState().addSession(conversation, false);
          conversationId = conversation.id;
          store().set({ aiConversationId: conversationId });
        }
        const sessions = useSessionsStore.getState();
        const label =
          paths.length === 1
            ? `Resolve the conflict in ${paths[0]}`
            : `Resolve ${paths.length} conflicted files`;
        sessions.addUserMessage(
          conversationId,
          newId("local"),
          extraPrompt ? `${label} — ${extraPrompt}` : label
        );
        const repo = await activeRepoLabel();
        const { taskId } = await bridge.rpc("task.start", {
          conversationId,
          prompt: buildResolvePrompt({
            paths,
            ours: info?.mergeState?.ours ?? info?.branch ?? "HEAD",
            theirs: info?.mergeState?.theirs ?? "incoming",
            kind: info?.mergeState?.kind ?? "merge",
            output: s.syncOutput,
            extra: extraPrompt,
            repo,
          }),
          model: AI_MODEL,
          effort: "high",
          scopeRoots: repo && repo !== "." ? [repo] : undefined,
        });
        sessions.taskStarted(conversationId, taskId);
        store().set({ aiPaths: paths, aiSummary: null });
        alert.info(
          "AI resolver started",
          paths.length === 1 ? paths[0] : `${paths.length} files`
        );
      } catch (e) {
        store().set({ syncError: errText(e), aiPaths: null });
        alert.danger("Could not start the AI resolver", errText(e));
      }
    },
    []
  );

  const cancelAi = useCallback(() => {
    const conversationId = store().aiConversationId;
    if (!conversationId) return;
    const sessions = useSessionsStore.getState();
    const taskId = sessions.sessions[conversationId]?.activeTaskId;
    if (!taskId) return;
    sessions.taskCancelling(conversationId);
    void bridge.rpc("task.cancel", { taskId }).catch(() => {
      // Already finished; the store clears on its end event.
    });
  }, []);

  const setPullMode = useCallback((mode: GitPullMode) => {
    store().set({ pullMode: mode });
  }, []);

  const toggleOutput = useCallback(() => {
    store().set({ outputOpen: !store().outputOpen });
  }, []);

  const clearError = useCallback(() => store().set({ syncError: null }), []);

  return {
    status,
    conflicts,
    mergeState,
    merge,
    aiSession,
    aiWorking,
    fetch,
    pull,
    checkoutRun,
    openSync,
    closeSync,
    loadRefs,
    openConflict,
    closeConflict,
    reloadConflict: loadConflict,
    nextConflictAfter,
    saveDraft,
    markResolved,
    takeSide,
    restore,
    abort,
    complete,
    aiResolve,
    cancelAi,
    setPullMode,
    toggleOutput,
    clearError,
  };
}

export type MergeConflictViewModel = ReturnType<typeof useMergeConflictViewModel>;

export interface PullOptions {
  mode?: GitPullMode;
  remote?: string;
  branch?: string;
}

export interface CheckoutOptions {
  ref: string;
  create?: boolean;
  /** Remote ref to check out as a local tracking branch ("origin/feat"). */
  track?: string;
  /** Start point a created branch branches out of; HEAD when omitted. */
  from?: string;
}

async function loadRefsQuiet(): Promise<void> {
  try {
    const { refs } = await bridge.rpc("git.refs", {});
    useGitMergeStore.getState().set({ refs });
  } catch {
    // The picker keeps its previous list.
  }
}

/** Loads all three sides for the resolver (no-op if the user moved on). */
export async function loadConflictFile(path: string): Promise<void> {
  const store = useGitMergeStore.getState();
  try {
    const { file } = await bridge.rpc("git.conflictFile", { path });
    if (useGitMergeStore.getState().openPath === path) {
      store.set({ file, loadingFile: false });
    }
  } catch (e) {
    if (useGitMergeStore.getState().openPath === path) {
      store.set({ loadingFile: false, syncError: errText(e) });
    }
  }
}

/**
 * Opens the resolver on `path`. Exported as a plain function so the file
 * explorer can route a click on a conflicted file here without pulling in
 * the whole view model.
 */
export function openConflictFile(path: string): void {
  useGitMergeStore.getState().openConflict(path);
  void loadConflictFile(path);
}

/**
 * Shell-level effects for the merge flow — mounted ONCE (MergeConflictHost)
 * so they keep running while the user is on another view:
 *
 *  - when the AI task ends, scan the files it was given and stage the ones
 *    it left marker-free, so they show as resolved without a manual step;
 *  - raise the alert pill when NEW conflicts appear and the git view is
 *    not already showing them.
 */
export function useMergeConflictEffects(): void {
  const aiConversationId = useGitMergeStore((s) => s.aiConversationId);
  const aiPaths = useGitMergeStore((s) => s.aiPaths);
  const aiStatus = useSessionsStore((s) =>
    aiConversationId ? (s.sessions[aiConversationId]?.status ?? null) : null
  );
  const wasWorking = useRef(false);

  useEffect(() => {
    const working = aiStatus === "working";
    const justEnded = wasWorking.current && !working;
    wasWorking.current = working;
    if (!justEnded || !aiPaths) return;

    const store = useGitMergeStore.getState();
    store.set({ aiPaths: null });
    void (async () => {
      try {
        const { clean, dirty } = await bridge.rpc("git.scanConflictMarkers", {
          paths: aiPaths,
        });
        if (clean.length > 0) await bridge.rpc("git.stage", { paths: clean });
        const s = useGitMergeStore.getState();
        const summary = summarizeAi(clean.length, dirty.length);
        s.set({
          aiResolved: [...new Set([...s.aiResolved, ...clean])],
          aiSummary: summary,
        });
        (dirty.length === 0 && clean.length > 0 ? alert.success : alert.warning)(
          "AI resolver finished",
          summary,
          {
            action: {
              label: "Review",
              run: () => useWorkspaceStore.getState().setActivityView("git"),
            },
          }
        );
        if (s.openPath && aiPaths.includes(s.openPath)) {
          const path = s.openPath;
          const { file } = await bridge.rpc("git.conflictFile", { path });
          if (useGitMergeStore.getState().openPath === path) s.set({ file });
        }
      } catch (e) {
        useGitMergeStore.getState().set({ syncError: errText(e) });
        alert.danger("Could not verify the AI resolution", errText(e));
      } finally {
        useGitStore.getState().bumpStateVersion();
      }
    })();
  }, [aiStatus, aiPaths]);

  // ── tracked conflicts (for "n of N resolved" + the resolved list) ────
  const statusConflicts = useGitStore((s) => s.status?.conflicts ?? null);
  const mergeKind = useGitStore((s) => s.status?.mergeState?.kind ?? null);
  useEffect(() => {
    if (statusConflicts === null) return;
    const store = useGitMergeStore.getState();
    if (mergeKind === null) {
      if (store.trackedConflicts.length > 0) store.set({ trackedConflicts: [] });
      return;
    }
    const merged = [...new Set([...store.trackedConflicts, ...statusConflicts])];
    if (merged.length !== store.trackedConflicts.length) {
      store.set({ trackedConflicts: merged });
    }
  }, [statusConflicts, mergeKind]);

  // ── conflict alert ────────────────────────────────────────────────────
  const liveConflicts = useGitStore(
    (s) => s.live?.conflicts ?? s.status?.conflicts.length ?? 0
  );
  const activityView = useWorkspaceStore((s) => s.activityView);
  useEffect(() => {
    const store = useGitMergeStore.getState();
    if (liveConflicts === 0) {
      if (store.alertVisible || store.alertSeenCount !== 0) {
        store.set({ alertVisible: false, alertSeenCount: 0 });
      }
      return;
    }
    if (activityView === "git") {
      // Already looking at it — the banner does the talking.
      if (store.alertVisible) store.set({ alertVisible: false });
      store.set({ alertSeenCount: liveConflicts });
      return;
    }
    if (liveConflicts > store.alertSeenCount) {
      store.set({ alertVisible: true });
    }
  }, [liveConflicts, activityView]);
}

function summarizeAi(clean: number, dirty: number): string {
  if (clean === 0 && dirty === 0) return "AI made no changes.";
  if (dirty === 0) {
    return clean === 1
      ? "AI resolved the file — review it, then complete the merge."
      : `AI resolved ${clean} files — review them, then complete the merge.`;
  }
  return `AI resolved ${clean} of ${clean + dirty} — ${dirty} still ${
    dirty === 1 ? "has" : "have"
  } markers.`;
}

/**
 * The active checkout, workspace-relative ("." at the root). The repair
 * task is confined to it: a workspace holding several checkouts must not
 * become the agent's search space for a conflict in one of them.
 */
async function activeRepoLabel(): Promise<string | undefined> {
  try {
    const { active } = await bridge.rpc("git.repos", {});
    return active ?? undefined;
  } catch {
    return undefined;
  }
}

interface ResolvePromptInput {
  paths: string[];
  ours: string;
  theirs: string;
  kind: string;
  output: string;
  extra: string;
  repo?: string;
}

function buildResolvePrompt(input: ResolvePromptInput): string {
  const where =
    input.repo && input.repo !== "."
      ? ` The repository is \`${input.repo}/\` — read, search and edit ` +
        `ONLY inside \`${input.repo}/\`.`
      : "";
  const rebaseNote =
    input.kind === "rebase"
      ? "\nThis is a REBASE, so git's marker labels are swapped from what " +
        "you might expect: the block ABOVE ======= (\"ours\", HEAD) is the " +
        "upstream commit being rebased onto, and the block BELOW is the " +
        "user's own commit being replayed. Prefer keeping the user's " +
        "intent when the two genuinely clash.\n"
      : "";
  const parts = [
    `A \`git ${input.kind}\` in this workspace left conflict markers in ` +
      `the working tree.${where}`,
    "",
    `Side labels — above \`=======\`: ${input.ours} (ours / current). ` +
      `Below \`=======\`: ${input.theirs} (theirs / incoming).`,
    rebaseNote,
    "Conflicted files to resolve:",
    ...input.paths.map((p) => `- ${p}`),
    "",
    "For EACH file: read it, understand what both sides were trying to " +
      "do, and rewrite the conflicted regions so the result keeps BOTH " +
      "intents wherever they are compatible. When they truly contradict, " +
      "keep the change that is more recent or more complete and say why " +
      "in your summary. Remove every `<<<<<<<`, `|||||||`, `=======` and " +
      "`>>>>>>>` marker. Do not touch code outside the conflicted regions " +
      "except where a resolution needs a matching edit (an import, a type) " +
      "to stay consistent.",
    "",
    "Do NOT run `git commit`, `git merge --continue`, `git rebase " +
      "--continue`, `git merge --abort` or push. Do not stage files — the " +
      "app verifies each file is marker-free and stages it for the user " +
      "to review.",
  ];
  if (input.output.trim()) {
    parts.push(
      "",
      "Output of the command that produced the conflict:",
      "```",
      input.output.slice(-OUTPUT_TAIL_CHARS),
      "```"
    );
  }
  if (input.extra.trim()) {
    parts.push("", `Additional instructions from the user: ${input.extra.trim()}`);
  }
  parts.push(
    "",
    "End with a short per-file summary of how each conflict was resolved."
  );
  return parts.join("\n");
}

function errText(e: unknown): string {
  return errorText(e).replace(/^Error:\s*/, "").slice(0, 300);
}

/** Last non-empty, non-echo line of a streamed run — the one-line verdict. */
function lastLine(output: string): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("$ ") && !/^\[exit -?\d+\]$/.test(l));
  return (lines[lines.length - 1] ?? "").slice(0, 120);
}

/** "Fast-forward" / "Merge made by the 'ort' strategy" / file counts. */
function summarizePull(output: string): string {
  const stat = output.match(/(\d+ files? changed[^\n]*)/)?.[1];
  const how = /Fast-forward/.test(output)
    ? "fast-forward"
    : /Merge made by/.test(output)
      ? "merge commit"
      : /Successfully rebased/.test(output)
        ? "rebased"
        : "";
  return [how, stat].filter(Boolean).join(" · ") || lastLine(output);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
