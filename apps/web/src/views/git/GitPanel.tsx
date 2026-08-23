import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  Github,
  GitPullRequestArrow,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/error-text";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkspacePageBody } from "@/components/ui/workspace-page";
import { useGitFlowViewModel } from "@/hooks/useGitFlowViewModel";
import {
  useMergeConflictViewModel,
  type MergeConflictViewModel,
} from "@/hooks/useMergeConflictViewModel";
import { DiffStat, statOf, sumStats, type DiffSide } from "./DiffStat";
import { FileDiffDrawer } from "./FileDiffDrawer";
import { RepoSwitcher } from "./RepoSwitcher";
import { SyncBar } from "./SyncBar";
import { MergeBanner } from "./MergeBanner";
import { ConflictResolver } from "./ConflictResolver";
import { AiResolveModal } from "./AiResolveModal";
import { HistoryPanel } from "./HistoryPanel";
import { RequestsPanel } from "./RequestsPanel";
import { usePullRequestsViewModel } from "@/hooks/usePullRequestsViewModel";
import type { GitViewModel } from "@/hooks/useGitViewModel";
import type { GitFileStatus } from "@atelier/protocol";

export interface GitPanelProps {
  vm: GitViewModel;
}

/** Keep unusually large working trees from blocking the renderer on mount. */
const MAX_RENDERED_FILES_PER_SECTION = 200;

/**
 * The right column's panes: the working tree, the commit log, or the open
 * pull/merge requests for this checkout.
 */
type GitPane = "changes" | "history" | "requests";

/**
 * Shell around the repo view. The switcher lives here rather than inside
 * it so it stays on screen in every state — including the error one,
 * which is exactly when the user needs to move to a different project.
 */
export function GitPanel({ vm }: GitPanelProps) {
  const multi = vm.repos.length > 1;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* No tray around the columns: the shell already wraps this panel in
          an `.island`, so a padded, tinted card inside it drew a second
          border a few pixels in from the first and ate horizontal space a
          260px panel does not have. The section cards below are the only
          surface. `relative` stays — the diff drawer slides in against
          it. */}
      <WorkspacePageBody className="flex min-h-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1">
            {multi && !vm.activeRepo ? (
              <div className="flex h-full min-h-0 flex-col gap-2 p-2.5 text-sm lg:flex-row">
                <div className="shrink-0 rounded-xl bg-muted/30 p-2.5 lg:w-60 xl:w-72">
                  <RepoSwitcher
                    repos={vm.repos}
                    active={vm.activeRepo}
                    onSelect={(repo) => void vm.selectRepo(repo)}
                  />
                </div>
                <div className="min-h-0 flex-1 rounded-xl bg-muted/30">
                  <EmptyState text="Choose a project to see its git status." />
                </div>
              </div>
            ) : (
              <GitRepoView
                vm={vm}
                repoSwitcher={
                  multi ? (
                    <RepoSwitcher
                      repos={vm.repos}
                      active={vm.activeRepo}
                      onSelect={(repo) => void vm.selectRepo(repo)}
                    />
                  ) : null
                }
              />
            )}
          </div>
          {/* Slides in over the right of this panel; the file list stays
              readable beside it so the next file is one click away. */}
          <FileDiffDrawer vm={vm} />
        </div>
      </WorkspacePageBody>
    </div>
  );
}

function EmptyState({
  text,
  action,
}: {
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
      <GitBranch className="h-6 w-6 text-muted-foreground/50" />
      <p className="text-center text-xs text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}

/**
 * The empty state for a workspace with no repository anywhere: the panel
 * offers to create one instead of only reporting its absence. Not shown for
 * the multi-checkout case — there a repo already exists and the answer is to
 * pick one, not to init a second at the root.
 */
function NoRepoState({ text, vm }: { text: string; vm: GitViewModel }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const init = () => {
    setBusy(true);
    setError(null);
    void vm
      .initRepo()
      .catch((err: unknown) => setError(shortError(errorText(err))))
      .finally(() => setBusy(false));
  };

  return (
    <EmptyState
      text={text}
      action={
        <div className="flex flex-col items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={init} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitBranch className="mr-1.5 h-3.5 w-3.5" />
            )}
            Initialize repository
          </Button>
          {error && <p className="text-center text-[11px] text-destructive">{error}</p>}
        </div>
      }
    />
  );
}

/**
 * Git view for ONE checkout. The left rail is everything you act with —
 * repo, branch, sync, commit box — and the right column is everything you
 * look at, split into two panes: Changes (conflicts, staged, unstaged) and
 * History. Clicking a file opens its diff.
 */
function GitRepoView({
  vm,
  repoSwitcher,
}: GitPanelProps & { repoSwitcher?: ReactNode }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Which pane the right column shows. Not forced back to Changes during a
  // merge: the conflict count rides on the tab, so the user is told without
  // having the log yanked out from under them.
  const [pane, setPane] = useState<GitPane>("changes");
  // Same store as the shell-mounted modal (GitFlowHost) — this instance
  // only starts the flow; the host renders it.
  const flowVm = useGitFlowViewModel();
  // Sync row + merge-conflict flow. Its resolver takes over the right
  // column while a conflicted file is open.
  const mergeVm = useMergeConflictViewModel();
  // Open PRs/MRs, polled. Mounted here rather than inside the Requests
  // pane so the check keeps running — and the tab keeps its unseen dot —
  // while the user is on Changes.
  const prVm = usePullRequestsViewModel();

  if (vm.error) {
    // No checkouts found anywhere is the one failure the user can fix from
    // here; every other git error is reported as-is.
    return vm.repos.length === 0 ? (
      <NoRepoState text={shortError(vm.error)} vm={vm} />
    ) : (
      <EmptyState text={shortError(vm.error)} />
    );
  }
  if (!vm.status) {
    return (
      <p className="pt-8 text-center text-xs text-muted-foreground">
        Loading git status…
      </p>
    );
  }
  // A merge in flight is shown even without a remote: local branch merges
  // conflict too, and hiding the resolver behind "connect to GitHub" would
  // strand the user mid-merge.
  if (!vm.status.hasRemote && !vm.status.mergeState) {
    return <NoRemoteState onConnect={vm.connectGitHub} />;
  }

  const conflictSet = new Set(vm.status.conflicts);
  const inMerge = vm.status.mergeState !== null;
  // Unmerged paths render in the Conflicts section only — an "UU" file
  // satisfies both isStaged and isUnstaged and would otherwise show twice.
  const staged = vm.status.files.filter(
    (f) => isStaged(f) && !conflictSet.has(f.path)
  );
  const unstaged = vm.status.files.filter(
    (f) => isUnstaged(f) && !conflictSet.has(f.path)
  );

  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    void fn()
      .catch((err: unknown) => setActionError(shortError(errorText(err))))
      .finally(() => setBusy(false));
  };

  /**
   * Commit runs through the wizard (streamed hooks, push, PR). With
   * nothing staged, the wizard stages everything on its first commit.
   * The message box clears — the wizard holds the message from here.
   */
  const doCommit = () => {
    const msg = message.trim();
    if (!msg) return;
    void flowVm.startFlow(msg, staged.length === 0);
    setMessage("");
  };

  /**
   * AI-drafts a commit message from the changes and drops it into the
   * textarea — the user can still edit it before committing.
   */
  const doGenerate = () => {
    setGenerating(true);
    setActionError(null);
    vm.generateCommitMessage()
      .then((msg) => setMessage(msg))
      .catch((err: unknown) => setActionError(shortError(errorText(err))))
      .finally(() => setGenerating(false));
  };

  const doDiscard = (paths: string[]) => {
    const what =
      paths.length === 1 ? paths[0] : `${paths.length} files`;
    const ok = window.confirm(
      `Discard changes in ${what}?\n\n` +
        "Tracked files are restored; untracked files are DELETED. " +
        "This cannot be undone."
    );
    if (ok) act(() => vm.discard(paths));
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-2.5 text-sm lg:flex-row">
      <aside className="flex shrink-0 flex-col gap-2 rounded-xl bg-muted/30 p-2.5 lg:w-60 xl:w-72">
        {repoSwitcher}
        <BranchSection
          status={vm.status}
          busy={busy}
          onOpenCheckout={() => mergeVm.openSync("checkout")}
          onRefresh={vm.refresh}
        />

        <SyncBar
          vm={mergeVm}
          disabled={busy}
          ahead={vm.status.ahead}
          onPush={() => void flowVm.startPush()}
        />

        <TreePulse
          staged={staged}
          unstaged={unstaged}
          conflicts={conflictSet.size}
        />

        {actionError && (
          <p className="rounded-lg bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
            {actionError}
          </p>
        )}

        {inMerge ? (
          <MergeBanner vm={mergeVm} />
        ) : (
          <CommitBox
            message={message}
            onMessageChange={setMessage}
            generating={generating}
            busy={busy}
            stagedCount={staged.length}
            unstagedCount={unstaged.length}
            onCommit={doCommit}
            onGenerate={doGenerate}
          />
        )}
      </aside>
      {mergeVm.merge.openPath ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-muted/30">
          <ConflictResolver vm={mergeVm} />
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-muted/30 p-2">
        <PaneTabs
          tab={pane}
          onSelect={setPane}
          changedCount={staged.length + unstaged.length}
          conflictCount={conflictSet.size}
          commitCount={vm.commits.length}
          requestCount={prVm.requests.length}
          unseenRequests={prVm.unseen.size}
          requestsAvailable={prVm.available}
        />
        {pane === "requests" ? (
          <RequestsPanel vm={prVm} branch={vm.status.branch} />
        ) : pane === "history" ? (
          <HistoryPanel commits={vm.commits} />
        ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {(inMerge || conflictSet.size > 0) && (
          <ConflictSection vm={mergeVm} busy={busy} onError={setActionError} />
        )}
        <FileSection
          title="Staged"
          files={staged}
          side="index"
          emptyText="Nothing staged."
          busy={busy}
          onOpen={(path) => void vm.openDiff(path, true)}
          rowActions={[
            {
              icon: Minus,
              title: "Unstage",
              run: (path) => act(() => vm.unstage([path])),
            },
          ]}
          headerActions={
            staged.length > 1
              ? [
                  {
                    label: "Unstage all",
                    run: () => act(() => vm.unstage(staged.map((f) => f.path))),
                  },
                ]
              : []
          }
        />

        <FileSection
          title="Changes"
          files={unstaged}
          side="work"
          emptyText={
            vm.status.isClean ? "Working tree clean." : "No unstaged changes."
          }
          busy={busy}
          onOpen={(path) => void vm.openDiff(path, false)}
          rowActions={[
            {
              icon: Undo2,
              title: "Discard changes",
              danger: true,
              run: (path) => doDiscard([path]),
            },
            {
              icon: Plus,
              title: "Stage",
              run: (path) => act(() => vm.stage([path])),
            },
          ]}
          headerActions={
            unstaged.length > 1
              ? [
                  {
                    label: "Discard all",
                    danger: true,
                    run: () => doDiscard(unstaged.map((f) => f.path)),
                  },
                  {
                    label: "Stage all",
                    run: () => act(() => vm.stage(unstaged.map((f) => f.path))),
                  },
                ]
              : []
          }
        />

        </div>
        )}
      </div>
      )}
    </div>
  );
}

/**
 * The merge-mode file list: unresolved conflicts first (red, `!`), then the
 * files already resolved in this merge (green, ✓, with Undo). Sits above
 * Staged/Changes so the thing blocking the commit is the first thing seen.
 */
function ConflictSection(props: {
  vm: MergeConflictViewModel;
  busy: boolean;
  onError: (message: string | null) => void;
}) {
  const { vm } = props;
  const [open, setOpen] = useState(true);
  /** File the AI-resolve chatbox is open for, if any. */
  const [askAi, setAskAi] = useState<string | null>(null);
  const unresolved = vm.conflicts;
  const resolved = vm.merge.trackedConflicts.filter(
    (p) => !unresolved.includes(p)
  );
  const aiResolved = new Set(vm.merge.aiResolved);
  const aiBusy = new Set(vm.aiWorking ? (vm.merge.aiPaths ?? []) : []);
  const disabled = props.busy;

  const run = (fn: () => Promise<void>) => {
    props.onError(null);
    void fn().catch((err: unknown) => props.onError(shortError(errorText(err))));
  };

  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-1 rounded-md bg-card/95 px-1 py-0.5 backdrop-blur">
        <button
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex min-w-0 items-center gap-1 text-[12px] font-medium hover:text-foreground",
            unresolved.length > 0 ? "text-destructive" : "text-success"
          )}
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">
            Conflicts
            {unresolved.length > 0
              ? ` · ${unresolved.length}`
              : resolved.length > 0
                ? " · all resolved"
                : ""}
          </span>
        </button>
        {unresolved.length > 1 && (
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <Tooltip content="Keep our side in every conflicted file">
              <button
                onClick={() => run(() => vm.takeSide(unresolved, "ours"))}
                disabled={disabled}
                className="text-[11px] text-cyan hover:underline"
              >
                All ours
              </button>
            </Tooltip>
            <Tooltip content="Take the incoming side in every conflicted file">
              <button
                onClick={() => run(() => vm.takeSide(unresolved, "theirs"))}
                disabled={disabled}
                className="text-[11px] text-primary hover:underline"
              >
                All theirs
              </button>
            </Tooltip>
          </span>
        )}
      </div>
      {open && (
        <>
          {unresolved.map((path) => (
            <ConflictRow
              key={path}
              path={path}
              state={aiBusy.has(path) ? "ai" : "unresolved"}
              onOpen={() => vm.openConflict(path)}
              actions={[
                {
                  label: "Ours",
                  hint: "Keep our side of this file",
                  tone: "ours",
                  run: () => run(() => vm.takeSide([path], "ours")),
                },
                {
                  label: "Theirs",
                  hint: "Take the incoming side of this file",
                  tone: "theirs",
                  run: () => run(() => vm.takeSide([path], "theirs")),
                },
                {
                  icon: Sparkles,
                  hint: "Resolve this file with AI — say what to do first",
                  tone: "ai",
                  disabled: vm.aiWorking,
                  run: () => setAskAi(path),
                },
              ]}
              disabled={disabled}
            />
          ))}
          {resolved.map((path) => (
            <ConflictRow
              key={path}
              path={path}
              state="resolved"
              tag={aiResolved.has(path) ? "AI · review" : undefined}
              onOpen={() => vm.openConflict(path)}
              actions={[
                {
                  icon: FileDiff,
                  hint: "Review the resolution",
                  run: () => vm.openConflict(path),
                },
                {
                  icon: Undo2,
                  hint: "Restore the conflict markers",
                  tone: "danger",
                  run: () => run(() => vm.restore(path)),
                },
              ]}
              disabled={disabled}
            />
          ))}
          {unresolved.length === 0 && resolved.length === 0 && (
            <p className="px-2 pb-1 text-[11px] text-muted-foreground/60">
              No conflicted files.
            </p>
          )}
        </>
      )}

      <AiResolveModal
        open={askAi !== null}
        paths={askAi ? [askAi] : []}
        onClose={() => setAskAi(null)}
        onSubmit={(guidance, model) => {
          if (askAi) run(() => vm.aiResolve([askAi], guidance, model));
        }}
      />
    </div>
  );
}

interface ConflictRowAction {
  label?: string;
  icon?: typeof Plus;
  hint: string;
  tone?: "ours" | "theirs" | "ai" | "danger";
  disabled?: boolean;
  run: () => void;
}

function ConflictRow(props: {
  path: string;
  state: "unresolved" | "resolved" | "ai";
  tag?: string;
  onOpen: () => void;
  actions: ConflictRowAction[];
  disabled: boolean;
}) {
  const unresolved = props.state !== "resolved";
  const title = unresolved
    ? `${props.path} — open the resolver`
    : `${props.path} — resolved, staged`;
  return (
    <div className="group flex items-center gap-0.5 rounded-md pr-1 hover:bg-accent/60">
      <Tooltip content={title}>
        <button
          onClick={props.onOpen}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-0.5 text-left"
        >
          <span
            className={cn(
              "flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
              props.state === "resolved"
                ? "bg-success/15 text-success"
                : "conflict-badge bg-destructive/15 text-destructive"
            )}
          >
            {props.state === "ai" ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : props.state === "resolved" ? (
              <Check className="h-2.5 w-2.5" />
            ) : (
              "!"
            )}
          </span>
          <span
            className={cn(
              "truncate text-xs",
              unresolved ? "text-destructive" : "text-foreground"
            )}
          >
            {props.path}
          </span>
          {props.tag && (
            <span className="ml-1 shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">
              {props.tag}
            </span>
          )}
        </button>
      </Tooltip>
      {props.actions.map((a) => (
        <Tooltip key={a.hint} content={a.hint}>
          <button
            onClick={a.run}
            disabled={props.disabled || a.disabled}
            className={cn(
              "shrink-0 rounded px-1 py-0.5 text-[10px] font-medium opacity-0 group-hover:opacity-100 disabled:opacity-30",
              a.tone === "ours" && "text-cyan hover:bg-cyan/15",
              a.tone === "theirs" && "text-primary hover:bg-primary/15",
              a.tone === "ai" && "text-primary hover:bg-primary/15",
              a.tone === "danger" && "text-muted-foreground hover:text-destructive",
              !a.tone && "text-muted-foreground hover:text-foreground"
            )}
          >
            {a.icon ? <a.icon className="h-3.5 w-3.5" /> : a.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * The commit message box + button. Hidden while a merge is in flight — the
 * merge banner's "Commit merge" is the commit then, and two commit buttons
 * would invite committing half a merge.
 */
function CommitBox(props: {
  message: string;
  onMessageChange: (value: string) => void;
  generating: boolean;
  busy: boolean;
  stagedCount: number;
  unstagedCount: number;
  onCommit: () => void;
  onGenerate: () => void;
}) {
  return (
    <>
    <div className="relative">
      <Textarea
        value={props.message}
        onChange={(e) => props.onMessageChange(e.target.value)}
        placeholder={props.generating ? "Drafting a message…" : "Commit message"}
        rows={2}
        disabled={props.generating}
        className="max-h-52 min-h-12 resize-y pr-8 text-xs"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) props.onCommit();
        }}
      />
      <Tooltip content="Generate commit message from changes (AI)">
        <button
          onClick={props.onGenerate}
          disabled={props.generating || props.busy}
          className="absolute right-1.5 top-1.5 rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-primary disabled:opacity-50"
        >
          {props.generating ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
        </button>
      </Tooltip>
    </div>
    <Tooltip
      content={
        props.stagedCount === 0
          ? "Nothing staged — all changes will be staged and committed"
          : undefined
      }
      disabled={props.stagedCount !== 0}
    >
      <Button
        size="sm"
        className="h-7 w-full text-xs"
        disabled={
          props.busy ||
          props.generating ||
          props.message.trim() === "" ||
          (props.stagedCount === 0 && props.unstagedCount === 0)
        }
        onClick={props.onCommit}
      >
        <Check className="mr-1.5 h-3.5 w-3.5" />
        Commit{" "}
        {props.stagedCount > 0
          ? `(${props.stagedCount})`
          : props.unstagedCount > 0
            ? `all (${props.unstagedCount})`
            : ""}
      </Button>
    </Tooltip>
    </>
  );
}

/**
 * Shown instead of the git panel when the repo has no remote configured.
 * The connect action asks the agent to create a private GitHub repo via
 * the gh CLI and set it as origin.
 */
function NoRemoteState(props: { onConnect: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = () => {
    setBusy(true);
    setError(null);
    props
      .onConnect()
      .catch((err: unknown) => setError(shortError(errorText(err))))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
      <Github className="h-8 w-8 text-muted-foreground/50" />
      <p className="text-center text-xs text-muted-foreground">
        This project doesn&apos;t have a remote / origin yet.
      </p>
      <Button size="sm" disabled={busy} onClick={connect}>
        {busy ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            Connecting…
          </>
        ) : (
          <>
            <Github className="mr-1.5 h-3.5 w-3.5" />
            Connect to GitHub
          </>
        )}
      </Button>
      {error && (
        <p className="max-w-full break-words rounded-lg bg-destructive/10 px-2 py-1 text-center text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function BranchSection(props: {
  status: NonNullable<GitViewModel["status"]>;
  busy: boolean;
  /** Opens the checkout picker (local + remote branches, or a new one). */
  onOpenCheckout: () => void;
  onRefresh: () => void;
}) {
  const { status } = props;
  const drifted = status.ahead > 0 || status.behind > 0;
  return (
    <div className="flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-1.5 ring-1 ring-inset ring-white/5">
      <Tooltip content="Checkout another branch…">
        <button
          onClick={props.onOpenCheckout}
          disabled={props.busy}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 text-left hover:bg-white/5 disabled:opacity-60"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <GitBranch className="h-3.5 w-3.5" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-[13px] font-semibold leading-tight">
                {status.branch}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            </span>
            <span className="flex items-center gap-1.5 text-[10px] leading-tight text-muted-foreground">
              {drifted ? (
                <>
                  {status.ahead > 0 && (
                    <span className="tabular-nums text-primary">
                      ↑{status.ahead}
                    </span>
                  )}
                  {status.behind > 0 && (
                    <span className="tabular-nums text-warning">
                      ↓{status.behind}
                    </span>
                  )}
                  <span>vs remote</span>
                </>
              ) : (
                <span>in sync</span>
              )}
            </span>
          </span>
        </button>
      </Tooltip>
      <Tooltip content="Refresh">
        <button
          onClick={props.onRefresh}
          className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The working tree at a glance: three counters and one bar whose green and
 * red halves are sized by the added/removed ratio. The left rail was branch
 * + commit box and then a tall column of nothing; this is the part that
 * answers "how big is this change" without reading the file list.
 */
function TreePulse(props: {
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  conflicts: number;
}) {
  const indexed = sumStats(props.staged, "index");
  const working = sumStats(props.unstaged, "work");
  const added = (indexed?.added ?? 0) + (working?.added ?? 0);
  const removed = (indexed?.removed ?? 0) + (working?.removed ?? 0);
  const churn = added + removed;
  const tiles = [
    { label: "Staged", value: props.staged.length, tone: "text-success" },
    { label: "Changed", value: props.unstaged.length, tone: "text-warning" },
    {
      label: "Conflicts",
      value: props.conflicts,
      tone:
        props.conflicts > 0 ? "text-destructive" : "text-muted-foreground/60",
    },
  ];
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-black/20 p-1.5">
      <div className="flex items-stretch gap-1.5">
        {tiles.map((t) => (
          <div
            key={t.label}
            className="flex min-w-0 flex-1 flex-col items-center justify-center rounded-lg bg-white/[0.03] py-1"
          >
            <span
              className={cn(
                "text-sm font-semibold leading-none tabular-nums",
                t.tone
              )}
            >
              {t.value}
            </span>
            <span className="mt-0.5 truncate text-[9px] uppercase tracking-wide text-muted-foreground/70">
              {t.label}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1.5 px-0.5">
        <span className="flex h-1 min-w-0 flex-1 items-stretch overflow-hidden rounded-full bg-white/5">
          {churn > 0 && (
            <>
              <span
                className="bg-success"
                style={{ width: `${(added / churn) * 100}%` }}
              />
              <span
                className="bg-destructive"
                style={{ width: `${(removed / churn) * 100}%` }}
              />
            </>
          )}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-success">
          +{added}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-destructive">
          −{removed}
        </span>
      </div>
    </div>
  );
}

interface RowAction {
  icon: typeof Plus;
  title: string;
  danger?: boolean;
  run: (path: string) => void;
}

interface HeaderAction {
  label: string;
  danger?: boolean;
  run: () => void;
}

/** Collapsible file list with hover actions per row (VSCode-style). */
function FileSection(props: {
  title: string;
  files: GitFileStatus[];
  /** Which side of each file's change this section counts and diffs. */
  side: DiffSide;
  emptyText: string;
  busy: boolean;
  onOpen: (path: string) => void;
  rowActions: RowAction[];
  headerActions: HeaderAction[];
}) {
  const [open, setOpen] = useState(true);
  const visibleFiles = props.files.slice(0, MAX_RENDERED_FILES_PER_SECTION);
  const hiddenCount = props.files.length - visibleFiles.length;
  const total = sumStats(props.files, props.side);
  return (
    <div className="border-t border-white/5 pt-1 first:border-t-0 first:pt-0">
      <div className="sticky top-0 z-10 flex items-center gap-1 rounded-md bg-card/95 px-1 py-0.5 backdrop-blur">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          <span className="truncate">
            {props.title}
            {props.files.length > 0 && ` · ${props.files.length}`}
          </span>
        </button>
        {total && (
          <DiffStat
            stat={total}
            title={`${total.added} added, ${total.removed} removed in this section`}
          />
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {props.headerActions.map((a) => (
            <button
              key={a.label}
              onClick={a.run}
              disabled={props.busy}
              className={cn(
                "text-[11px] hover:underline",
                a.danger ? "text-destructive/80" : "text-primary"
              )}
            >
              {a.label}
            </button>
          ))}
        </span>
      </div>
      {open &&
        (props.files.length === 0 ? (
          <p className="px-2 pb-1 text-[11px] text-muted-foreground/60">
            {props.emptyText}
          </p>
        ) : (
          <>
            {visibleFiles.map((f) => (
              <div
                key={f.path}
                className="group flex items-center gap-0.5 rounded-md pr-1 hover:bg-accent/60"
              >
                <Tooltip content={f.path}>
                  <button
                    onClick={() => props.onOpen(f.path)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-0.5 text-left"
                  >
                    <span
                      className={cn(
                        "w-4 shrink-0 text-center font-mono text-[11px] font-semibold",
                        statusColor(f)
                      )}
                    >
                      {statusChar(f)}
                    </span>
                    <span className="truncate text-xs">{f.path}</span>
                  </button>
                </Tooltip>
                <DiffStat
                  stat={statOf(f, props.side)}
                  onOpen={() => props.onOpen(f.path)}
                />
                {props.rowActions.map((a) => (
                  <Tooltip key={a.title} content={a.title}>
                    <button
                      onClick={() => a.run(f.path)}
                      disabled={props.busy}
                      className={cn(
                        "shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100",
                        a.danger
                          ? "hover:text-destructive"
                          : "hover:text-foreground"
                      )}
                    >
                      <a.icon className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                ))}
              </div>
            ))}
            {hiddenCount > 0 && (
              <p className="px-2 py-1 text-[11px] text-muted-foreground/60">
                {hiddenCount} more changed files not shown.
              </p>
            )}
          </>
        ))}
    </div>
  );
}

/**
 * The right column's three destinations: what is uncommitted, what is
 * committed, and what is waiting for review.
 *
 * The old strip was a full-width segmented control — three equal grey
 * slabs in a grey trough, where the only difference between selected and
 * not was a slightly lighter slab. It read as chrome, and in a 260px panel
 * it spent the whole width saying so. This rail is sized to its words
 * instead: the active tab is the only filled thing on the row, carrying a
 * left accent bar and its own count, while the others sit as quiet labels
 * that light up on hover. The width the labels give back holds the pane's
 * name on the right, so the header still says where you are once the tabs
 * stop shouting it.
 */
function PaneTabs(props: {
  tab: GitPane;
  onSelect: (tab: GitPane) => void;
  changedCount: number;
  conflictCount: number;
  commitCount: number;
  requestCount: number;
  /** Requests that showed up since this pane was last looked at. */
  unseenRequests: number;
  requestsAvailable: boolean;
}) {
  // Conflicts outrank the change count on the badge, the way the dock tile
  // does it: a red number is the one that has to be acted on.
  const tabs = [
    {
      id: "changes" as const,
      icon: FileDiff,
      label: "Changes",
      count: props.conflictCount || props.changedCount,
      danger: props.conflictCount > 0,
      dot: false,
    },
    {
      id: "history" as const,
      icon: GitCommitHorizontal,
      label: "History",
      count: props.commitCount,
      danger: false,
      dot: false,
    },
    {
      id: "requests" as const,
      icon: GitPullRequestArrow,
      label: "Requests",
      // Nothing to count is not the same as nothing to say: with no forge
      // CLI the tab still opens onto the pane that explains why.
      count: props.requestsAvailable ? props.requestCount : 0,
      danger: false,
      dot: props.unseenRequests > 0,
    },
  ];

  return (
    <div
      role="tablist"
      aria-label="Git panel"
      className="mb-1.5 flex shrink-0 items-center gap-1 border-b border-white/5 pb-1.5"
    >
      {tabs.map((t) => {
        const active = props.tab === t.id;
        return (
          <Tooltip
            key={t.id}
            content={
              t.id === "requests"
                ? props.unseenRequests > 0
                  ? `${props.unseenRequests} new since you last looked`
                  : "Open pull / merge requests, re-checked automatically"
                : t.label
            }
          >
            <button
              role="tab"
              aria-selected={active}
              onClick={() => props.onSelect(t.id)}
              className={cn(
                "relative flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5",
                "text-[11px] font-medium transition-colors",
                active
                  ? "bg-primary/10 text-foreground"
                  : "text-muted-foreground/80 hover:bg-white/5 hover:text-foreground"
              )}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary"
                />
              )}
              <t.icon
                className={cn(
                  "h-3 w-3 shrink-0",
                  active ? "text-primary" : "text-current"
                )}
              />
              {/* The label of an inactive tab is dropped below the panel's
                  narrowest width: three words plus three counts do not fit
                  a 260px column, and the icons still say which is which. */}
              <span className={cn("truncate", !active && "hidden xl:inline")}>
                {t.label}
              </span>
              {t.count > 0 && (
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1 text-[9px] leading-[14px] tabular-nums",
                    t.danger
                      ? "bg-destructive/20 text-destructive"
                      : active
                        ? "bg-primary/20 text-primary"
                        : "bg-white/5 text-muted-foreground"
                  )}
                >
                  {t.count > 99 ? "99+" : t.count}
                </span>
              )}
              {t.dot && (
                <span
                  aria-hidden
                  className={cn(
                    "absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full",
                    "bg-cyan ring-2 ring-card"
                  )}
                />
              )}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** True when the index side records a change (staged content exists). */
function isStaged(f: GitFileStatus): boolean {
  return f.index !== "" && f.index !== "?";
}

/** True when the working tree differs from the index (or is untracked). */
function isUnstaged(f: GitFileStatus): boolean {
  return f.workingDir !== "" || f.index === "?";
}

function statusChar(f: GitFileStatus): string {
  return f.workingDir || f.index || "?";
}

function statusColor(f: GitFileStatus): string {
  const c = statusChar(f);
  if (c === "A" || c === "?") return "text-success";
  if (c === "D") return "text-destructive";
  if (c === "R") return "text-cyan";
  return "text-warning";
}

function shortError(err: string): string {
  return err.replace(/^Error:\s*/, "").slice(0, 200);
}
