import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Cloud, GitBranch, GitFork, Loader2, Pencil, RefreshCw, Search, X } from "lucide-react";
import type { GitCommit } from "@atelier/protocol";
import { cn } from "@/lib/cn";
import { laneColor, type CommitGraph } from "@/lib/commit-graph";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, type SelectOption, type SelectSeparator } from "@/components/ui/select";
import {
  useHistoryViewModel,
  type HistoryViewModel,
} from "@/hooks/useHistoryViewModel";
import { CommitDetailPane } from "./history/CommitDetailPane";
import { FileViewer } from "./history/FileViewer";
import { GraphCell, ROW_H } from "./history/GraphCell";
import { Avatar, RefPills } from "./history/parts";
import { fullDate, relativeAge, shortDate } from "./history/format";

export interface HistoryPanelProps {
  /** Uncommitted file count, for the WIP row above the graph. */
  changedCount: number;
  /** Switches the git view to the Changes pane (the WIP row's action). */
  onShowChanges?: () => void;
}

/**
 * History, laid out like GitKraken: the commit graph across every branch
 * in the centre, with ref labels, message, author, date and hash as
 * columns; the selected commit's panel docked on the right; and a file
 * from that commit opening in place of the graph as a diff, a blame or
 * its own history. Arrow keys walk the graph, Esc backs out a level.
 */
export function HistoryPanel(props: HistoryPanelProps) {
  const vm = useHistoryViewModel();
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return vm.commits
      .map((c, i) => (commitMatches(c, q) ? i : -1))
      .filter((i) => i >= 0);
  }, [vm.commits, query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const typing = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "Escape") {
      if (vm.openFile) vm.closeFile();
      else if (vm.selected) vm.select(null);
      else return;
      e.preventDefault();
      return;
    }
    if (typing || vm.openFile) return;
    if (e.key === "ArrowDown" || e.key === "j") vm.step(1);
    else if (e.key === "ArrowUp" || e.key === "k") vm.step(-1);
    else return;
    e.preventDefault();
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col focus:outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <Toolbar
        vm={vm}
        query={query}
        onQuery={setQuery}
        shown={matches?.length ?? vm.commits.length}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg bg-black/10">
        <BranchSidebar vm={vm} />
        {vm.openFile ? (
          <FileViewer vm={vm} />
        ) : (
          <GraphTable
            vm={vm}
            matches={matches}
            query={query.trim()}
            changedCount={props.changedCount}
            onShowChanges={props.onShowChanges}
          />
        )}
        <CommitDetailPane vm={vm} />
      </div>
    </div>
  );
}

function Toolbar(props: {
  vm: HistoryViewModel;
  query: string;
  onQuery: (q: string) => void;
  shown: number;
}) {
  const { vm } = props;
  const refs = vm.refs.data;
  const branchOptions: Array<SelectOption | SelectSeparator> = [
    { value: "all", label: "All branches" },
    { value: "head", label: `Current · ${refs?.current ?? "HEAD"}` },
    { value: "local-heading", label: "Local branches", separator: true },
    ...(refs?.local.map((branch) => ({
      value: `refs/heads/${branch.name}`,
      label: branch.name,
      hint: branch.name === refs.current ? "Current branch" : "Local branch",
    })) ?? []),
    { value: "remote-heading", label: "Remote branches", separator: true },
    ...(refs?.remote.filter((branch) => branch.remote).map((branch) => ({
      value: `refs/remotes/${branch.ref}`,
      label: branch.ref,
      hint: "Remote-tracking branch",
    })) ?? []),
  ];
  return (
    <div className="flex shrink-0 items-center gap-2 px-1 pb-2">
      <Select
        value={vm.scope === "branch" ? vm.branchRef ?? "all" : vm.scope}
        onChange={(value) => {
          if (value === "all" || value === "head") vm.setScope(value);
          else vm.selectBranch(value);
        }}
        options={branchOptions}
        searchable
        searchPlaceholder="Find a branch…"
        className="h-7 w-48 justify-between bg-black/20 text-foreground"
      />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-black/20 px-2">
        <Search className="h-3 w-3 shrink-0 text-muted-foreground/60" />
        <Input
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          placeholder="Filter by message, author or hash…"
          className={cn(
            "h-7 min-w-0 flex-1 bg-transparent px-0 text-[11px]",
            "placeholder:text-muted-foreground/60 focus-visible:outline-none"
          )}
        />
        {props.query && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => props.onQuery("")}
            aria-label="Clear filter"
            className="h-5 w-5 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
      <Tooltip content="Refresh branch history">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={vm.refresh}
          aria-label="Refresh branch history"
          className="h-7 w-7 text-muted-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", vm.loadingLog && "animate-spin")} />
        </Button>
      </Tooltip>
      {vm.loadingLog && (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
        {props.shown} commits
      </span>
    </div>
  );
}

/** Live local and remote refs. Selecting a row reads that ref's ancestry. */
function BranchSidebar({ vm }: { vm: HistoryViewModel }) {
  const refs = vm.refs.data;
  const selected = vm.scope === "branch" ? vm.branchRef : vm.scope;
  const [localOpen, setLocalOpen] = useState(true);
  const [remoteOpen, setRemoteOpen] = useState<Record<string, boolean>>({});
  const remoteGroups = new Map<string, NonNullable<typeof refs>["remote"]>();
  for (const branch of refs?.remote.filter((item) => item.remote) ?? []) {
    const group = remoteGroups.get(branch.remote) ?? [];
    group.push(branch);
    remoteGroups.set(branch.remote, group);
  }

  return (
    <aside className="hidden min-h-0 w-48 shrink-0 flex-col border-r border-border/60 bg-card/25 min-[1300px]:flex">
      <div className="border-b border-border/60 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Branches
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        <div className="space-y-0.5">
          <BranchItem icon={GitFork} label="All branches" active={selected === "all"} onClick={() => vm.setScope("all")} />
          <BranchItem icon={GitBranch} label="Current branch" active={selected === "head"} onClick={() => vm.setScope("head")} />
        </div>
        <div>
          <BranchGroupToggle
            label="Local"
            count={refs?.local.length ?? 0}
            open={localOpen}
            onClick={() => setLocalOpen((open) => !open)}
          />
          {localOpen && refs?.local.map((branch) => {
            const ref = `refs/heads/${branch.name}`;
            return <BranchItem key={ref} icon={GitBranch} label={branch.name} active={selected === ref} current={branch.name === refs.current} onClick={() => vm.selectBranch(ref)} />;
          })}
        </div>
        {[...remoteGroups].map(([remote, branches]) => {
          const open = remoteOpen[remote] ?? true;
          return (
            <div key={remote}>
              <BranchGroupToggle
                label={remote}
                count={branches.length}
                open={open}
                onClick={() => setRemoteOpen((state) => ({ ...state, [remote]: !open }))}
              />
              {open && branches.map((branch) => {
                const ref = `refs/remotes/${branch.ref}`;
                return <BranchItem key={ref} icon={Cloud} label={branch.branch} active={selected === ref} onClick={() => vm.selectBranch(ref)} />;
              })}
            </div>
          );
        })}
        {vm.refs.loading && !refs && (
          <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Reading branches…
          </div>
        )}
        {vm.refs.error && <div role="alert" className="px-2 text-xs text-destructive">{vm.refs.error}</div>}
      </div>
    </aside>
  );
}

function BranchGroupToggle({ label, count, open, onClick }: {
  label: string;
  count: number;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${label} branches`}
      className="h-7 w-full justify-start gap-1 px-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70"
    >
      <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", !open && "-rotate-90")} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="tabular-nums">{count}</span>
    </Button>
  );
}

function BranchItem({ icon: Icon, label, active, current, onClick }: {
  icon: typeof GitBranch;
  label: string;
  active: boolean;
  current?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={cn(
        "h-7 w-full justify-start gap-2 px-2 text-left text-xs font-normal",
        active ? "bg-primary/15 text-primary hover:bg-primary/20" : "text-muted-foreground hover:text-foreground"
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {current && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-label="Checked out" />}
    </Button>
  );
}

/** Column widths, shared by the header and the rows so they line up. */
const COL = {
  refs: "w-44",
  author: "w-32",
  date: "w-32",
  sha: "w-16",
};

function GraphTable(props: {
  vm: HistoryViewModel;
  matches: number[] | null;
  query: string;
  changedCount: number;
  onShowChanges?: () => void;
}) {
  const { vm, matches } = props;
  const indices = useMemo(
    () => matches ?? vm.commits.map((_, i) => i),
    [matches, vm.commits]
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: indices.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 20,
  });

  // Keep the keyboard selection on screen.
  useEffect(() => {
    if (!vm.selected) return;
    const commitIdx = vm.commits.findIndex((c) => c.hash === vm.selected);
    const rowIdx = indices.indexOf(commitIdx);
    if (rowIdx >= 0) virtual.scrollToIndex(rowIdx, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm.selected]);

  if (vm.logError && vm.commits.length === 0) {
    return <Empty text={vm.logError} error />;
  }
  if (vm.commits.length === 0) {
    return <Empty text={vm.loadingLog ? "Reading history…" : "No commits yet."} />;
  }

  // Lanes only mean something over the unfiltered log.
  const graph = matches ? null : vm.graph;
  const graphW = graph ? 20 + (graph.width - 1) * 16 : 28;

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-white/5",
          "px-2 py-1 text-[9px] font-semibold uppercase tracking-wider",
          "text-muted-foreground/60"
        )}
      >
        <span className={cn(COL.refs, "hidden shrink-0 @2xl:block")}>Branch / Tag</span>
        <span className="shrink-0" style={{ width: graphW }}>Graph</span>
        <span className="min-w-0 flex-1">Commit message</span>
        <span className={cn(COL.author, "hidden shrink-0 @3xl:block")}>Author</span>
        <span className={cn(COL.date, "hidden shrink-0 @xl:block")}>Date</span>
        <span className={cn(COL.sha, "hidden shrink-0 @4xl:block")}>SHA</span>
      </div>

      {props.changedCount > 0 && !matches && (
        <button
          onClick={props.onShowChanges}
          className={cn(
            "flex shrink-0 items-center gap-2 border-b border-white/5",
            "px-2 text-left hover:bg-accent/40"
          )}
          style={{ height: ROW_H }}
        >
          <span className={cn(COL.refs, "hidden shrink-0 @2xl:block")} />
          <span className="flex shrink-0 justify-start" style={{ width: graphW }}>
            <span
              className={cn(
                "ml-[3px] flex h-[18px] w-[18px] items-center justify-center",
                "rounded-full border-2 border-dashed",
                "border-muted-foreground/60"
              )}
            >
              <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
            </span>
          </span>
          <span className="truncate text-xs italic text-muted-foreground">
            {"// WIP"} — {props.changedCount} changed file
            {props.changedCount === 1 ? "" : "s"}
          </span>
        </button>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {indices.length === 0 ? (
          <Empty text={`No commit matches “${props.query}”.`} />
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((item) => {
              const i = indices[item.index]!;
              return (
                <CommitRow
                  key={vm.commits[i]!.hash}
                  top={item.start}
                  commit={vm.commits[i]!}
                  index={i}
                  graph={graph}
                  graphW={graphW}
                  selected={vm.selected === vm.commits[i]!.hash}
                  onSelect={vm.select}
                />
              );
            })}
          </div>
        )}
        {vm.canLoadMore && !matches && (
          <div className="flex justify-center py-2">
            <button
              onClick={vm.loadMore}
              disabled={vm.loadingLog}
              className={cn(
                "rounded-md bg-white/5 px-3 py-1 text-[11px]",
                "text-muted-foreground hover:bg-accent hover:text-foreground",
                "disabled:opacity-50"
              )}
            >
              {vm.loadingLog ? "Loading…" : "Load older commits"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function CommitRow(props: {
  top: number;
  commit: GitCommit;
  index: number;
  graph: CommitGraph | null;
  graphW: number;
  selected: boolean;
  onSelect: (hash: string) => void;
}) {
  const { commit, graph } = props;
  const row = graph?.rows[props.index];
  const color = row ? laneColor(row.color) : null;
  const head = isHead(commit.refs);
  const tip =
    `${commit.hash.slice(0, 12)} · ${commit.author} · ` +
    fullDate(commit.date);

  return (
    <div
      role="row"
      aria-selected={props.selected}
      onClick={() => props.onSelect(commit.hash)}
      className={cn(
        "absolute left-0 flex w-full cursor-default items-center gap-2 px-2",
        !props.selected && "hover:bg-accent/40"
      )}
      style={{
        top: props.top,
        height: ROW_H,
        background:
          props.selected && color ? `${color}2e` : props.selected ? "var(--accent)" : undefined,
        boxShadow: props.selected && color ? `inset 2px 0 0 ${color}` : undefined,
      }}
    >
      <span className={cn(COL.refs, "hidden shrink-0 overflow-hidden @2xl:flex")}>
        <RefPills refs={commit.refs} color={color} />
      </span>
      <span className="flex shrink-0 items-center" style={{ width: props.graphW }}>
        {row && graph ? (
          <GraphCell row={row} width={graph.width} author={commit.author} head={head} />
        ) : (
          <Avatar name={commit.author} size={18} />
        )}
      </span>
      <Tooltip content={tip}>
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="@2xl:hidden">
            <RefPills refs={commit.refs} color={color} />
          </span>
          <span className={cn("truncate text-xs", row?.merge && "text-muted-foreground")}>
            {commit.message}
          </span>
          {commit.body && (
            <span
              aria-label="Has a description"
              className={cn(
                "shrink-0 rounded bg-white/10 px-1 text-[9px] font-bold",
                "leading-[15px] text-muted-foreground"
              )}
            >
              …
            </span>
          )}
        </span>
      </Tooltip>
      <span className={cn(COL.author, "hidden shrink-0 items-center gap-1.5 @3xl:flex")}>
        <Avatar name={commit.author} size={16} />
        <span className="truncate text-[11px] text-muted-foreground">{commit.author}</span>
      </span>
      <span
        className={cn(
          COL.date,
          "hidden shrink-0 truncate text-[11px] tabular-nums",
          "text-muted-foreground @xl:block"
        )}
        title={relativeAge(commit.date)}
      >
        {shortDate(commit.date)}
      </span>
      <span
        className={cn(
          COL.sha,
          "hidden shrink-0 font-mono text-[10px]",
          "text-muted-foreground/70 @4xl:block"
        )}
      >
        {commit.hash.slice(0, 7)}
      </span>
    </div>
  );
}

function Empty({ text, error }: { text: string; error?: boolean }) {
  return (
    <p
      className={cn(
        "flex-1 px-2 py-8 text-center text-[11px]",
        error ? "text-destructive" : "text-muted-foreground/60"
      )}
    >
      {text}
    </p>
  );
}

/** Checked out here: "HEAD -> branch", or a bare "HEAD" when detached. */
function isHead(refs: string | undefined): boolean {
  if (!refs) return false;
  return refs.split(",").some((r) => {
    const t = r.trim();
    return t === "HEAD" || t.startsWith("HEAD ->");
  });
}

function commitMatches(c: GitCommit, q: string): boolean {
  return (
    c.message.toLowerCase().includes(q) ||
    // The body is where a release note says which migration ran.
    (c.body?.toLowerCase().includes(q) ?? false) ||
    c.author.toLowerCase().includes(q) ||
    (c.refs?.toLowerCase().includes(q) ?? false) ||
    c.hash.toLowerCase().startsWith(q)
  );
}
