import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  Columns2,
  FileClock,
  FileDiff,
  FileQuestion,
  Loader2,
  Rows2,
  ScanText,
} from "lucide-react";
import type { GitBlameLine, GitCommit } from "@atelier/protocol";
import { cn } from "@/lib/cn";
import { languageForPath } from "@/lib/diff-view";
import { MonacoDiff } from "@/components/MonacoDiff";
import { Tooltip } from "@/components/ui/tooltip";
import { useThemeStore } from "@/state/theme.store";
import type { FileMode, HistoryViewModel, Load } from "@/hooks/useHistoryViewModel";
import { Avatar } from "./parts";
import { fullDate, relativeAge, shortDate, splitPath } from "./format";

const MODES: { mode: FileMode; label: string; icon: typeof FileDiff }[] = [
  { mode: "diff", label: "Diff", icon: FileDiff },
  { mode: "blame", label: "Blame", icon: ScanText },
  { mode: "history", label: "History", icon: FileClock },
];

/**
 * A file from the selected commit, opened in place of the graph the way
 * GitKraken does it: the commit panel stays docked on the right, so the
 * next file is one click away, and the header switches the same file
 * between its diff, its blame and its history.
 */
export function FileViewer({ vm }: { vm: HistoryViewModel }) {
  const open = vm.openFile;
  const [split, setSplit] = useState(false);
  if (!open) return null;
  const { dir, name } = splitPath(open.file.path);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-2 py-1.5">
        <Tooltip content="Back to the graph (Esc)">
          <button
            onClick={vm.closeFile}
            className={cn(
              "flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px]",
              "text-muted-foreground hover:bg-accent/60",
              "hover:text-foreground"
            )}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Graph
          </button>
        </Tooltip>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs">
            <span className="text-muted-foreground/70">{dir}</span>
            <span className="font-medium">{name}</span>
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {open.file.oldPath ? `renamed from ${open.file.oldPath} · ` : ""}
            at {open.hash.slice(0, 7)}
            {vm.selectedCommit ? ` · ${vm.selectedCommit.message}` : ""}
          </p>
        </div>
        {open.mode === "diff" && (
          <Tooltip content={split ? "Inline diff" : "Side-by-side diff"}>
            <button
              onClick={() => setSplit((v) => !v)}
              aria-label="Toggle diff layout"
              className={cn(
                "rounded-md p-1.5 text-muted-foreground hover:bg-accent/60",
                "hover:text-foreground"
              )}
            >
              {split ? (
                <Rows2 className="h-3.5 w-3.5" />
              ) : (
                <Columns2 className="h-3.5 w-3.5" />
              )}
            </button>
          </Tooltip>
        )}
        <div className="flex shrink-0 rounded-lg bg-black/20 p-0.5">
          {MODES.map(({ mode, label, icon: Icon }) => (
            <button
              key={mode}
              onClick={() => vm.setMode(mode)}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px]",
                open.mode === mode
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {open.mode === "diff" ? (
          <DiffView vm={vm} split={split} />
        ) : open.mode === "blame" ? (
          <BlameView
            load={vm.blame}
            focusHash={open.hash}
            onPick={(hash) => vm.select(hash)}
          />
        ) : (
          <FileHistoryView
            load={vm.fileHistory}
            current={open.hash}
            onPick={(commit) => {
              vm.select(commit.hash);
              vm.openFileAt(commit.hash, { ...open.file, status: "M" }, "diff");
            }}
          />
        )}
      </div>
    </div>
  );
}

function DiffView({ vm, split }: { vm: HistoryViewModel; split: boolean }) {
  const theme = useThemeStore((s) => s.theme);
  const path = vm.openFile?.file.path ?? "";
  const binary = vm.openFile?.file.binary;
  const options = useMemo(
    () => ({
      readOnly: true,
      automaticLayout: true,
      renderSideBySide: split,
      renderOverviewRuler: false,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbersMinChars: split ? 4 : 6,
      glyphMargin: false,
      folding: false,
      scrollBeyondLastLine: false,
      hideUnchangedRegions: { enabled: true },
    }),
    [split]
  );

  if (binary) return <Centered icon>Binary file — no text diff to show.</Centered>;
  if (vm.diff.error) return <Centered error>{vm.diff.error}</Centered>;
  if (!vm.diff.data) return <Centered loading>Loading diff…</Centered>;
  return (
    <MonacoDiff
      original={vm.diff.data.before}
      modified={vm.diff.data.after}
      language={languageForPath(path)}
      theme={theme === "dark" ? "atelier-dark" : "atelier-light"}
      options={options}
    />
  );
}

const BLAME_ROW = 20;

/**
 * Blame as GitKraken lays it out: each run of lines from one commit gets
 * its author, age and subject once, at the top of the run, and a bar
 * whose strength is how recent the change is. Lines the open commit
 * itself wrote are tinted, so "what did this commit do here" is visible
 * in the whole file, not just the diff. Clicking a run opens its commit.
 */
function BlameView(props: {
  load: Load<GitBlameLine[]>;
  focusHash: string;
  onPick: (hash: string) => void;
}) {
  const lines = props.load.data ?? [];
  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => BLAME_ROW,
    overscan: 30,
  });

  const heat = useMemo(() => {
    const times = lines.map((l) => new Date(l.date).getTime()).filter(Number.isFinite);
    const min = Math.min(...times);
    const max = Math.max(...times);
    return (iso: string) => {
      const t = new Date(iso).getTime();
      if (!Number.isFinite(t) || max === min) return 1;
      return (t - min) / (max - min);
    };
  }, [lines]);

  if (props.load.error) return <Centered error>{props.load.error}</Centered>;
  if (!props.load.data) return <Centered loading>Running blame…</Centered>;
  if (lines.length === 0) return <Centered icon>Empty file.</Centered>;

  const digits = String(lines.length).length;
  return (
    <div ref={parentRef} className="h-full overflow-auto font-mono text-[12px]">
      <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {virtual.getVirtualItems().map((item) => {
          const line = lines[item.index]!;
          const prev = lines[item.index - 1];
          const first = !prev || prev.hash !== line.hash;
          const mine = line.hash === props.focusHash;
          const uncommitted = /^0+$/.test(line.hash);
          return (
            <div
              key={item.key}
              className={cn(
                "absolute left-0 flex w-full min-w-max items-stretch",
                first && item.index > 0 && "border-t border-white/5",
                mine && "bg-primary/10"
              )}
              style={{ top: item.start, height: BLAME_ROW }}
            >
              <button
                onClick={() => !uncommitted && props.onPick(line.hash)}
                className={cn(
                  "flex w-72 shrink-0 items-center gap-1.5 px-2 text-left",
                  "font-sans hover:bg-accent/50"
                )}
                title={blameTitle(line)}
              >
                {first && (
                  <>
                    <Avatar name={line.author} size={14} />
                    <span className="w-10 shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {uncommitted ? "now" : relativeAge(line.date)}
                    </span>
                    <span className="truncate text-[11px] text-foreground/85">
                      {uncommitted ? "Not committed yet" : line.summary}
                    </span>
                  </>
                )}
              </button>
              <span
                className="w-[3px] shrink-0 bg-primary"
                style={{ opacity: 0.15 + heat(line.date) * 0.85 }}
              />
              <span
                className="shrink-0 select-none px-2 text-right text-muted-foreground/50"
                style={{ width: `${digits + 2}ch` }}
              >
                {line.line}
              </span>
              <span className="whitespace-pre pr-4 leading-[20px]">{line.content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function blameTitle(line: GitBlameLine): string {
  const who = `${line.hash.slice(0, 7)} · ${line.author}`;
  return `${who} · ${fullDate(line.date)}
${line.summary}`;
}

function FileHistoryView(props: {
  load: Load<GitCommit[]>;
  current: string;
  onPick: (commit: GitCommit) => void;
}) {
  if (props.load.error) return <Centered error>{props.load.error}</Centered>;
  if (!props.load.data) return <Centered loading>Reading file history…</Centered>;
  const commits = props.load.data;
  if (commits.length === 0) return <Centered icon>No history for this file.</Centered>;
  return (
    <div className="h-full overflow-y-auto">
      <p className="px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {commits.length} commit{commits.length === 1 ? "" : "s"} touched this file
      </p>
      <ol className="relative">
        {commits.map((c) => (
          <li key={c.hash}>
            <button
              onClick={() => props.onPick(c)}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-1.5 text-left",
                c.hash === props.current ? "bg-primary/15" : "hover:bg-accent/50"
              )}
            >
              <Avatar name={c.author} size={20} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs">{c.message}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {c.author} · {shortDate(c.date)}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                {c.hash.slice(0, 7)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Centered(props: {
  children: React.ReactNode;
  loading?: boolean;
  error?: boolean;
  icon?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center gap-2 px-6 text-center text-xs",
        props.error ? "text-destructive" : "text-muted-foreground"
      )}
    >
      {props.loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {props.icon && <FileQuestion className="h-4 w-4" />}
      {props.children}
    </div>
  );
}
