import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDownToLine,
  Check,
  CircleAlert,
  Cloud,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequestArrow,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type { GitPullMode, GitRefs } from "@atelier/protocol";
import { cn } from "@/lib/cn";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { useWorkspaceStore } from "@/state/workspace.store";
import {
  useMergeConflictViewModel,
  type MergeConflictViewModel,
  type RebaseOptions,
} from "@/hooks/useMergeConflictViewModel";
import type { SyncModalKind } from "@/state/git-merge.store";

const TITLES: Record<SyncModalKind, string> = {
  pull: "Pull from",
  checkout: "Checkout",
  rebase: "Rebase onto",
};

const ICONS: Record<SyncModalKind, typeof GitBranch> = {
  pull: ArrowDownToLine,
  checkout: GitBranch,
  rebase: GitPullRequestArrow,
};

/**
 * Which side wins a conflicting hunk, in the rebaser's terms. Git's own
 * -X flags are named from the replay's point of view — during a rebase
 * "ours" is the branch you are landing ON — so the wording here is the
 * thing people mean and the agent does the inversion.
 */
const KEEP_MODES: Array<{
  value: RebaseOptions["keep"];
  label: string;
  hint: string;
}> = [
  {
    value: "mine",
    label: "Keep my changes",
    hint: "conflicting hunks resolve to this branch (-X theirs)",
  },
  {
    value: "base",
    label: "Keep the base's changes",
    hint: "conflicting hunks resolve to the branch below (-X ours)",
  },
  {
    value: "none",
    label: "Stop and let me resolve",
    hint: "every conflict opens in the resolver",
  },
];

const PULL_MODES: Array<{ value: GitPullMode; label: string; hint: string }> = [
  { value: "merge", label: "Merge", hint: "merge commit when diverged" },
  { value: "rebase", label: "Rebase", hint: "replay your commits on top" },
  { value: "ff-only", label: "Fast-forward only", hint: "refuse when diverged" },
];

/**
 * The "pull from / checkout" pickers. (No push picker: pushing is the
 * commit → push → PR wizard's job.) Shell-mounted; opened by
 * the sync row and the branch line. Two screens: configure (remote +
 * branch + options) and run (a terminal pane streaming the real command,
 * then a one-line verdict with the next sensible action).
 */
export function GitSyncModal() {
  const vm = useMergeConflictViewModel();
  const kind = vm.merge.syncModal;
  return (
    <AnimatePresence>
      {kind && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !vm.merge.syncRunning) vm.closeSync();
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="modal-surface island flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden"
          >
            <Header kind={kind} vm={vm} />
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
              {vm.merge.syncModalPhase === "run" ? (
                <RunScreen kind={kind} vm={vm} />
              ) : (
                <ConfigureScreen key={kind} kind={kind} vm={vm} />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Header({ kind, vm }: { kind: SyncModalKind; vm: MergeConflictViewModel }) {
  const Icon = ICONS[kind];
  const branch = vm.merge.refs?.current ?? vm.status?.branch ?? "";
  return (
    <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
      <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-primary/15 text-primary">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="text-sm font-medium">{TITLES[kind]}</span>
      {branch && (
        <Tooltip content="Current branch">
          <span className="flex min-w-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            <GitBranch className="h-3 w-3 shrink-0 text-primary/70" />
            <span className="truncate">{branch}</span>
          </span>
        </Tooltip>
      )}
      <span className="ml-auto flex items-center gap-1">
        <Tooltip content="Fetch, then refresh the list">
          <button
            onClick={() => void vm.fetch()}
            disabled={vm.merge.syncRunning}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-50"
          >
            {vm.merge.syncRunning && vm.merge.syncKind === "fetch" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </button>
        </Tooltip>
        <Tooltip content={vm.merge.syncRunning ? "Running — output keeps streaming in the panel" : "Close"}>
          <button
            onClick={vm.closeSync}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

// ── configure ────────────────────────────────────────────────────────────

function ConfigureScreen({ kind, vm }: { kind: SyncModalKind; vm: MergeConflictViewModel }) {
  const refs = vm.merge.refs;
  if (!refs) {
    return (
      <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Reading branches…
      </p>
    );
  }
  if (kind === "checkout") return <CheckoutForm refs={refs} vm={vm} />;
  if (kind === "rebase") return <RebaseForm refs={refs} vm={vm} />;
  if (refs.remotes.length === 0) {
    return (
      <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        This repository has no remotes. Connect one from the Changes panel first.
      </p>
    );
  }
  return <PullForm refs={refs} vm={vm} />;
}

/** The remote the current branch tracks, and the branch name there. */
function upstreamOf(refs: GitRefs): { remote: string; branch: string } | null {
  const up = refs.local.find((b) => b.name === refs.current)?.upstream;
  if (!up) return null;
  const hit = refs.remote.find((r) => r.ref === up);
  return hit ? { remote: hit.remote, branch: hit.branch } : null;
}

function PullForm({ refs, vm }: { refs: GitRefs; vm: MergeConflictViewModel }) {
  const upstream = useMemo(() => upstreamOf(refs), [refs]);
  const [remote, setRemote] = useState(upstream?.remote ?? refs.remotes[0]?.name ?? "origin");
  const [branch, setBranch] = useState<string>(
    upstream?.branch ?? preferBranch(refs, remote)
  );
  const [mode, setMode] = useState<GitPullMode>(vm.merge.pullMode);
  const [query, setQuery] = useState("");

  const branches = useMemo(
    () => refs.remote.filter((r) => r.remote === remote).map((r) => r.branch),
    [refs, remote]
  );
  const shown = branches.filter((b) => b.toLowerCase().includes(query.toLowerCase()));

  return (
    <>
      <Field label="Remote">
        <Select
          value={remote}
          onChange={(v) => {
            setRemote(v);
            setBranch(preferBranch(refs, v));
          }}
          options={refs.remotes.map((r) => ({ value: r.name, label: r.name, hint: r.url }))}
        />
      </Field>
      <Field label="Branch" hint={`${branches.length} on ${remote}`}>
        <BranchList
          items={shown.map((b) => ({ id: b, label: b, meta: `${remote}/${b}` }))}
          selected={branch}
          onSelect={setBranch}
          query={query}
          onQuery={setQuery}
          empty={branches.length === 0 ? "No branches known for this remote — fetch first." : "No match."}
        />
      </Field>
      <Field label="Strategy">
        <div className="flex gap-1 rounded-lg bg-secondary/60 p-0.5">
          {PULL_MODES.map((m) => (
            <Tooltip key={m.value} content={m.hint}>
              <button
                onClick={() => setMode(m.value)}
                aria-pressed={mode === m.value}
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-[11px]",
                  mode === m.value
                    ? "bg-background font-medium shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {m.label}
              </button>
            </Tooltip>
          ))}
        </div>
      </Field>
      <Footer
        onCancel={vm.closeSync}
        primary={`Pull ${remote}/${branch || "…"}`}
        icon={ArrowDownToLine}
        disabled={!branch}
        onRun={() => void vm.pull({ mode, remote, branch })}
      />
    </>
  );
}

function CheckoutForm({ refs, vm }: { refs: GitRefs; vm: MergeConflictViewModel }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [newName, setNewName] = useState("");
  const localNames = new Set(refs.local.map((b) => b.name));

  const items = useMemo(() => {
    const q = query.toLowerCase();
    const local = refs.local
      .filter((b) => b.name.toLowerCase().includes(q))
      .map((b) => ({
        id: `local:${b.name}`,
        label: b.name,
        meta: b.name === refs.current ? "current" : (b.upstream ?? "local"),
        current: b.name === refs.current,
      }));
    // A remote branch already checked out locally is reachable via its
    // local row; listing it twice would offer two ways to do one thing.
    const remote = refs.remote
      .filter((r) => !localNames.has(r.branch) && r.ref.toLowerCase().includes(q))
      .map((r) => ({
        id: `remote:${r.ref}`,
        label: r.branch,
        meta: `${r.remote} · creates local branch`,
        remoteIcon: true,
      }));
    return [...local, ...remote];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, query]);

  // The selected row is the BASE for a branch-out and the TARGET for a
  // plain checkout — one selection, and the button says which it is. With
  // nothing selected the base is HEAD, the branch you are on.
  const base = selected.startsWith("local:")
    ? selected.slice("local:".length)
    : selected.startsWith("remote:")
      ? selected.slice("remote:".length)
      : refs.current;
  const branching = newName.trim().length > 0;

  const run = () => {
    const name = newName.trim();
    if (name) {
      void vm.checkoutRun({ ref: name, create: true, from: base });
      return;
    }
    if (selected.startsWith("local:")) {
      void vm.checkoutRun({ ref: selected.slice("local:".length) });
    } else if (selected.startsWith("remote:")) {
      const ref = selected.slice("remote:".length);
      const hit = refs.remote.find((r) => r.ref === ref);
      if (hit) void vm.checkoutRun({ ref: hit.branch, track: hit.ref });
    }
  };

  const isCurrent = selected === `local:${refs.current}` && !branching;
  const primary = branching
    ? `Branch out ${newName.trim()} from ${base}`
    : isCurrent
      ? "Already on this branch"
      : `Checkout ${base}`;

  return (
    <>
      <Field
        label={branching ? "Branch out from" : "Branch"}
        hint={`${refs.local.length} local · ${refs.remote.length} remote`}
      >
        <BranchList
          items={items}
          selected={selected}
          onSelect={setSelected}
          query={query}
          onQuery={setQuery}
          tall
          empty="No branch matches."
        />
      </Field>
      {/* The base is whatever row is picked above; with nothing picked it
          falls back to the branch you are on, and says so — otherwise the
          two cases read identically and the base looks stuck on HEAD. */}
      <Field
        label="Or branch out"
        hint={selected ? `from ${base}` : `from ${base} · current`}
      >
        <div className="flex items-center gap-1.5">
          <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="feature/short-name"
            className="h-8 font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) run();
            }}
          />
        </div>
      </Field>
      <Footer
        onCancel={vm.closeSync}
        primary={primary}
        icon={branching ? GitBranchPlus : GitBranch}
        disabled={isCurrent || (!branching && !selected)}
        onRun={run}
      />
    </>
  );
}

/**
 * Replay this branch on top of another.
 *
 * The list is the same one the checkout picker uses, minus the branch you
 * are standing on: rebasing onto yourself is a no-op git would refuse
 * anyway. The current branch is never the target here — it is always what
 * moves — so the row says what it will land on.
 */
function RebaseForm({ refs, vm }: { refs: GitRefs; vm: MergeConflictViewModel }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string>("");
  const [keep, setKeep] = useState<RebaseOptions["keep"]>("mine");
  const branch = refs.current;

  const items = useMemo(() => {
    const q = query.toLowerCase();
    const local = refs.local
      .filter((b) => b.name !== branch && b.name.toLowerCase().includes(q))
      .map((b) => ({
        id: `local:${b.name}`,
        label: b.name,
        meta: b.upstream ?? "local",
      }));
    const remote = refs.remote
      .filter((r) => r.ref.toLowerCase().includes(q))
      .map((r) => ({
        id: `remote:${r.ref}`,
        label: r.ref,
        meta: `${r.remote} · fetched first`,
        remoteIcon: true,
      }));
    return [...local, ...remote];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refs, query, branch]);

  const onto = selected.startsWith("local:")
    ? selected.slice("local:".length)
    : selected.startsWith("remote:")
      ? selected.slice("remote:".length)
      : "";
  const remote = selected.startsWith("remote:")
    ? refs.remote.find((r) => r.ref === onto)?.remote
    : undefined;

  const run = () => {
    if (!onto) return;
    void vm.rebaseRun({ onto, keep, remote });
  };

  return (
    <>
      <Field
        label="Base branch"
        hint={`${refs.local.length} local · ${refs.remote.length} remote`}
      >
        <BranchList
          items={items}
          selected={selected}
          onSelect={setSelected}
          query={query}
          onQuery={setQuery}
          tall
          empty="No other branch to rebase onto."
        />
      </Field>

      <Field
        label="When a hunk conflicts"
        hint={KEEP_MODES.find((m) => m.value === keep)?.hint}
      >
        <Select
          value={keep}
          onChange={(v) => setKeep(v as RebaseOptions["keep"])}
          options={KEEP_MODES.map((m) => ({
            value: m.value,
            label: m.label,
            hint: m.hint,
          }))}
          direction="up"
        />
      </Field>

      <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
        <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          Rebasing rewrites {branch ? <b>{branch}</b> : "this branch"}'s
          commits. Uncommitted work is stashed and put back automatically
          (<span className="font-mono">--autostash</span>); already-pushed
          commits will need a force-push afterwards.
        </span>
      </p>

      <Footer
        onCancel={vm.closeSync}
        primary={onto ? `Rebase onto ${onto}` : "Pick a base branch"}
        icon={GitPullRequestArrow}
        disabled={!onto}
        onRun={run}
      />
    </>
  );
}

/** Branch to preselect for a remote: same-named as current, else the first. */
function preferBranch(refs: GitRefs, remote: string): string {
  const names = refs.remote.filter((r) => r.remote === remote).map((r) => r.branch);
  if (names.includes(refs.current)) return refs.current;
  if (names.includes("main")) return "main";
  return names[0] ?? "";
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">{props.label}</span>
        {props.hint && <span className="text-[10px] text-muted-foreground/70">{props.hint}</span>}
      </div>
      {props.children}
    </div>
  );
}

interface BranchItem {
  id: string;
  label: string;
  meta?: string;
  current?: boolean;
  remoteIcon?: boolean;
}

/** Filterable radio list of branches — the same list widget in all three pickers. */
function BranchList(props: {
  items: BranchItem[];
  selected: string;
  onSelect: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
  empty: string;
  compact?: boolean;
  tall?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-white/10">
      <div className="relative border-b border-white/5">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
        <input
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          placeholder="Filter branches…"
          spellCheck={false}
          className="h-7 w-full bg-transparent pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground/60"
        />
      </div>
      <div
        role="listbox"
        className={cn(
          "overflow-y-auto",
          props.tall ? "max-h-56" : props.compact ? "max-h-24" : "max-h-40"
        )}
      >
        {props.items.length === 0 ? (
          <p className="px-2 py-2 text-[11px] text-muted-foreground/70">{props.empty}</p>
        ) : (
          props.items.map((item) => {
            const active = item.id === props.selected;
            return (
              <button
                key={item.id}
                role="option"
                aria-selected={active}
                onClick={() => props.onSelect(item.id)}
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent/60",
                  active && "bg-primary/10"
                )}
              >
                {item.remoteIcon ? (
                  <Cloud className="h-3 w-3 shrink-0 text-muted-foreground" />
                ) : (
                  <GitBranch
                    className={cn(
                      "h-3 w-3 shrink-0",
                      item.current ? "text-primary" : "text-muted-foreground"
                    )}
                  />
                )}
                <span className={cn("truncate font-mono", item.current && "text-primary")}>
                  {item.label}
                </span>
                {item.meta && (
                  <span className="ml-auto shrink-0 truncate text-[10px] text-muted-foreground/70">
                    {item.meta}
                  </span>
                )}
                {active && <Check className="h-3 w-3 shrink-0 text-primary" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function Footer(props: {
  onCancel: () => void;
  primary: string;
  icon: typeof GitBranch;
  disabled?: boolean;
  onRun: () => void;
}) {
  return (
    <div className="mt-1 flex items-center justify-end gap-2">
      <Button size="sm" variant="ghost" onClick={props.onCancel}>
        Cancel
      </Button>
      <Button size="sm" disabled={props.disabled} onClick={props.onRun}>
        <props.icon className="mr-1.5 h-3.5 w-3.5" />
        <span className="max-w-[18rem] truncate">{props.primary}</span>
      </Button>
    </div>
  );
}

// ── run ─────────────────────────────────────────────────────────────────

function RunScreen({ kind, vm }: { kind: SyncModalKind; vm: MergeConflictViewModel }) {
  const { merge } = vm;
  const running = merge.syncRunning;
  const result = merge.lastRun;
  const conflicted = (result?.conflicts ?? 0) > 0;
  const command = firstCommand(merge.syncOutput) ?? `git ${kind}`;

  return (
    <>
      <TerminalPane title={command} output={merge.syncOutput} running={running} />

      <div
        className={cn(
          "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs",
          running
            ? "bg-secondary/40 text-muted-foreground"
            : result?.ok
              ? "bg-success/10 text-success"
              : conflicted
                ? "bg-warning/10 text-warning"
                : "bg-destructive/10 text-destructive"
        )}
      >
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : result?.ok ? (
          <Check className="h-3.5 w-3.5 shrink-0" />
        ) : conflicted ? (
          <GitMerge className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <CircleAlert className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {running
            ? "Running…"
            : result?.ok
              ? `Done${result.summary ? ` · ${result.summary}` : ""}`
              : conflicted
                ? `${RUN_NOUN[kind]} stopped — ${result?.summary}`
                : `Failed (exit ${result?.exitCode ?? "?"})${result?.summary ? ` · ${result.summary}` : ""}`}
        </span>
      </div>

      <div className="flex items-center justify-end gap-2">
        {!running && !result?.ok && !conflicted && (
          <Button size="sm" variant="secondary" onClick={() => vm.merge.set({ syncModalPhase: "configure" })}>
            Back
          </Button>
        )}
        {conflicted ? (
          <Button
            size="sm"
            onClick={() => {
              vm.closeSync();
              useWorkspaceStore.getState().setActivityView("git");
            }}
          >
            <GitMerge className="mr-1.5 h-3.5 w-3.5" />
            Resolve conflicts
          </Button>
        ) : (
          <Button size="sm" variant={running ? "secondary" : "default"} onClick={vm.closeSync}>
            {running ? "Hide (keeps running)" : "Done"}
          </Button>
        )}
      </div>
    </>
  );
}

/** How the result line names the command that just stopped on conflicts. */
const RUN_NOUN: Record<SyncModalKind, string> = {
  pull: "Pull",
  checkout: "Checkout",
  rebase: "Rebase",
};

/** The `$ git …` echo the agent writes first — the pane's title bar text. */
function firstCommand(output: string): string | null {
  const line = output.split("\n").find((l) => l.startsWith("$ "));
  return line ? line.slice(2).trim() : null;
}

/**
 * A small terminal: title bar with traffic lights and the command, dark
 * mono body that follows the stream, a blinking block cursor while the
 * process is alive. It shows the real interleaved stdout/stderr — nothing
 * is summarised away, so a hook or a credential prompt is seen as it happens.
 */
function TerminalPane(props: { title: string; output: string; running: boolean }) {
  const { ref, onScroll } = useStickToBottom<HTMLPreElement>([props.output]);
  const lines = props.output.replace(/\n$/, "").split("\n");
  return (
    <div className="overflow-hidden rounded-xl bg-[#0b1214] ring-1 ring-white/10 shadow-inner">
      <div className="flex items-center gap-2 border-b border-white/5 bg-white/[0.03] px-3 py-1.5">
        <span className="flex gap-1">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="min-w-0 flex-1 truncate text-center font-mono text-[10.5px] text-neutral-400">
          {props.title}
        </span>
        <span className="w-9 text-right text-[10px] text-neutral-500">
          {props.running ? "live" : "exit"}
        </span>
      </div>
      <pre
        ref={ref}
        onScroll={onScroll}
        className="max-h-64 min-h-32 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-200"
      >
        {lines.map((line, i) => (
          <span key={i} className="block">
            {line.startsWith("$ ") ? (
              <>
                <span className="text-success">$</span>
                <span className="text-neutral-100">{line.slice(1)}</span>
              </>
            ) : /^\[exit -?\d+\]$/.test(line) ? (
              <span className={line === "[exit 0]" ? "text-success/80" : "text-destructive/80"}>
                {line}
              </span>
            ) : /CONFLICT|error:|fatal:|rejected/i.test(line) ? (
              <span className="text-destructive">{line}</span>
            ) : (
              line || " "
            )}
          </span>
        ))}
        {props.running && (
          <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-neutral-300 align-middle" />
        )}
      </pre>
    </div>
  );
}
