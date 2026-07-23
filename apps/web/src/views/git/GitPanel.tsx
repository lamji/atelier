import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  Github,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useGitFlowViewModel } from "@/hooks/useGitFlowViewModel";
import type { GitViewModel } from "@/hooks/useGitViewModel";
import { GitFlowModal } from "./GitFlowModal";
import type { GitFileStatus } from "@atelier/protocol";

export interface GitPanelProps {
  vm: GitViewModel;
}

/**
 * Left-column Git view: branch switcher, commit box on top, collapsible
 * staged/unstaged sections with stage/unstage/discard actions, and recent
 * history. Clicking a file opens its diff in the editor pane.
 */
export function GitPanel({ vm }: GitPanelProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const flowVm = useGitFlowViewModel();

  if (vm.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
        <GitBranch className="h-6 w-6 text-muted-foreground/50" />
        <p className="text-center text-xs text-muted-foreground">
          {shortError(vm.error)}
        </p>
      </div>
    );
  }
  if (!vm.status) {
    return (
      <p className="pt-8 text-center text-xs text-muted-foreground">
        Loading git status…
      </p>
    );
  }
  if (!vm.status.hasRemote) {
    return <NoRemoteState onConnect={vm.connectGitHub} />;
  }

  const staged = vm.status.files.filter((f) => isStaged(f));
  const unstaged = vm.status.files.filter((f) => isUnstaged(f));

  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    void fn()
      .catch((err: unknown) => setActionError(shortError(String(err))))
      .finally(() => setBusy(false));
  };

  /**
   * Commit runs through the wizard (streamed hooks, push, PR). With
   * nothing staged, the wizard stages everything on its first commit.
   */
  const doCommit = () => {
    const msg = message.trim();
    if (!msg) return;
    void flowVm.startFlow(msg, staged.length === 0);
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
      .catch((err: unknown) => setActionError(shortError(String(err))))
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
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2 text-sm">
      <BranchSection
        status={vm.status}
        branches={vm.branches}
        busy={busy}
        onCheckout={(ref) => act(() => vm.checkout(ref))}
        onRefresh={vm.refresh}
      />

      {actionError && (
        <p className="rounded-lg bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {actionError}
        </p>
      )}

      <div className="space-y-1.5">
        <div className="relative">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message"
            rows={2}
            className="min-h-0 resize-none pr-8 text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doCommit();
            }}
          />
          <button
            onClick={doGenerate}
            disabled={generating || busy}
            title="Generate commit message from changes (AI)"
            className="absolute right-1.5 top-1.5 rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-primary disabled:opacity-50"
          >
            {generating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <Button
          size="sm"
          className="w-full"
          disabled={
            busy ||
            message.trim() === "" ||
            (staged.length === 0 && unstaged.length === 0)
          }
          onClick={doCommit}
          title={
            staged.length === 0
              ? "Nothing staged — all changes will be staged and committed"
              : undefined
          }
        >
          <Check className="mr-1.5 h-3.5 w-3.5" />
          Commit{" "}
          {staged.length > 0
            ? `(${staged.length})`
            : unstaged.length > 0
              ? `all (${unstaged.length})`
              : ""}
        </Button>
      </div>

      <FileSection
        title="Staged"
        files={staged}
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

      <HistorySection commits={vm.commits} />

      <GitFlowModal vm={flowVm} />
    </div>
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
      .catch((err: unknown) => setError(shortError(String(err))))
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
  branches: GitViewModel["branches"];
  busy: boolean;
  onCheckout: (ref: string) => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { status } = props;
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-accent/60"
          title="Switch branch"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          <span className="truncate font-medium">{status.branch}</span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {status.ahead > 0 && `↑${status.ahead}`}
              {status.behind > 0 && ` ↓${status.behind}`}
            </span>
          )}
        </button>
        <button
          onClick={props.onRefresh}
          title="Refresh"
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="mt-0.5 space-y-0.5 pl-6">
          {props.branches.map((b) => (
            <button
              key={b.name}
              disabled={props.busy || b.current}
              onClick={() => {
                setOpen(false);
                props.onCheckout(b.name);
              }}
              className={cn(
                "flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1 text-left text-xs",
                b.current
                  ? "font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              )}
            >
              <span className="truncate">{b.name}</span>
              {b.current && <Check className="ml-auto h-3 w-3 shrink-0" />}
            </button>
          ))}
        </div>
      )}
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
  emptyText: string;
  busy: boolean;
  onOpen: (path: string) => void;
  rowActions: RowAction[];
  headerActions: HeaderAction[];
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div className="flex items-center gap-1 px-1 py-1">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
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
          props.files.map((f) => (
            <div
              key={f.path}
              className="group flex items-center gap-0.5 rounded-md pr-1 hover:bg-accent/60"
            >
              <button
                onClick={() => props.onOpen(f.path)}
                title={f.path}
                className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left"
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
              {props.rowActions.map((a) => (
                <button
                  key={a.title}
                  onClick={() => a.run(f.path)}
                  disabled={props.busy}
                  title={a.title}
                  className={cn(
                    "shrink-0 rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100",
                    a.danger ? "hover:text-destructive" : "hover:text-foreground"
                  )}
                >
                  <a.icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          ))
        ))}
    </div>
  );
}

function HistorySection(props: { commits: GitViewModel["commits"] }) {
  const [open, setOpen] = useState(true);
  if (props.commits.length === 0) return null;
  return (
    <div className="min-h-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-1 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        History
      </button>
      {open &&
        props.commits.map((c) => (
          <div
            key={c.hash}
            className="flex items-start gap-1.5 px-2 py-1"
            title={c.hash}
          >
            <GitCommitHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            <div className="min-w-0">
              <p className="truncate text-xs">{c.message}</p>
              <p className="truncate text-[10px] text-muted-foreground/70">
                {c.hash.slice(0, 7)} · {c.author} · {formatDate(c.date)}
              </p>
            </div>
          </div>
        ))}
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
  if (c === "A" || c === "?") return "text-emerald-500";
  if (c === "D") return "text-destructive";
  if (c === "R") return "text-sky-500";
  return "text-amber-500";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function shortError(err: string): string {
  return err.replace(/^Error:\s*/, "").slice(0, 200);
}
