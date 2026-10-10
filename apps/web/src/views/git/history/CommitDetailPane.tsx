import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileClock,
  Loader2,
  ScanText,
  X,
} from "lucide-react";
import type { GitCommitFile } from "@atelier/protocol";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { FileMode, HistoryViewModel } from "@/hooks/useHistoryViewModel";
import { Avatar, RefPills } from "./parts";
import { fullDate, splitPath } from "./format";

/** name-status letter → label and tone. */
const STATUS: Record<string, { label: string; tone: string }> = {
  A: { label: "Added", tone: "text-success bg-success/15" },
  M: { label: "Modified", tone: "text-warning bg-warning/15" },
  D: { label: "Deleted", tone: "text-destructive bg-destructive/15" },
  R: { label: "Renamed", tone: "text-cyan bg-cyan/15" },
  C: { label: "Copied", tone: "text-cyan bg-cyan/15" },
  T: { label: "Type changed", tone: "text-muted-foreground bg-white/10" },
};

/**
 * The selected commit, docked right of the graph like GitKraken's commit
 * panel: who and when, the whole message, the parents to walk to, and
 * the files it changed. A file opens its diff in the centre; its hover
 * buttons go straight to blame or the file's own history.
 */
export function CommitDetailPane({ vm }: { vm: HistoryViewModel }) {
  const commit = vm.selectedCommit;
  const hash = vm.selected;
  const [bodyOpen, setBodyOpen] = useState(true);
  if (!hash) return null;

  const files = vm.files.data?.files ?? [];
  const parents = vm.files.data?.parents ?? commit?.parents ?? [];
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  const open = (file: GitCommitFile, mode: FileMode) =>
    vm.openFileAt(hash, file, mode);

  return (
    <aside
      className={cn(
        "flex min-h-0 w-[22rem] shrink-0 flex-col overflow-hidden",
        "border-l border-white/5 bg-card/40"
      )}
    >
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
          commit
        </span>
        <HashChip hash={hash} />
        <span className="flex-1" />
        <Tooltip content="Close (Esc)">
          <button
            onClick={() => vm.select(null)}
            aria-label="Close commit details"
            className="rounded p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-2.5 px-3 py-3">
          {commit ? (
            <>
              <h2 className="text-[13px] font-semibold leading-snug">
                {commit.message}
              </h2>
              {commit.body && (
                <div>
                  <button
                    onClick={() => setBodyOpen((v) => !v)}
                    className={cn(
                      "flex items-center gap-1 text-[10px] uppercase tracking-wide",
                      "text-muted-foreground/70 hover:text-foreground"
                    )}
                  >
                    {bodyOpen ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    Description
                  </button>
                  {bodyOpen && (
                    // Pre-wrap, not markdown: a commit message is plain
                    // text, and markdown would eat bullets and indents.
                    <pre
                      className={cn(
                        "mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap",
                        "break-words rounded-md bg-black/15 px-2 py-1.5 font-sans",
                        "text-[11.5px] leading-relaxed text-muted-foreground"
                      )}
                    >
                      {commit.body}
                    </pre>
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <Avatar name={commit.author} size={28} />
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium">{commit.author}</p>
                  <p className="truncate text-[10px] text-muted-foreground">
                    authored {fullDate(commit.date)}
                    {commit.email ? ` · ${commit.email}` : ""}
                  </p>
                </div>
              </div>
              <RefPills refs={commit.refs} color={null} max={8} wrap />
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              This commit is outside the loaded graph.
            </p>
          )}

          {parents.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
              <span className="uppercase tracking-wide text-muted-foreground/70">
                {parents.length > 1 ? "parents" : "parent"}
              </span>
              {parents.map((p) => (
                <button
                  key={p}
                  onClick={() => vm.select(p)}
                  className={cn(
                    "rounded bg-white/5 px-1.5 py-0.5 font-mono hover:bg-accent",
                    "hover:text-foreground"
                  )}
                >
                  {p.slice(0, 7)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div
          className={cn(
            "sticky top-0 z-10 flex items-center gap-2 border-y",
            "border-white/5 bg-card/95 px-3 py-1.5 backdrop-blur"
          )}
        >
          <span
            className={cn(
              "text-[10px] font-semibold uppercase tracking-wide",
              "text-muted-foreground/80"
            )}
          >
            {files.length} file{files.length === 1 ? "" : "s"} changed
          </span>
          <span className="flex-1" />
          <span className="text-[10px] tabular-nums text-success">+{added}</span>
          <span className="text-[10px] tabular-nums text-destructive">−{removed}</span>
        </div>

        {vm.files.loading && files.length === 0 ? (
          <p className="flex items-center gap-2 px-3 py-4 text-[11px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading files…
          </p>
        ) : vm.files.error ? (
          <p className="px-3 py-4 text-[11px] text-destructive">{vm.files.error}</p>
        ) : (
          <ul className="py-1">
            {files.map((file) => (
              <FileRow
                key={`${file.oldPath ?? ""}>${file.path}`}
                file={file}
                active={
                  vm.openFile?.hash === hash &&
                  vm.openFile.file.path === file.path
                }
                onOpen={(mode) => open(file, mode)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function FileRow(props: {
  file: GitCommitFile;
  active: boolean;
  onOpen: (mode: FileMode) => void;
}) {
  const { file } = props;
  const status = STATUS[file.status] ?? STATUS.M!;
  const { dir, name } = splitPath(file.path);
  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <li
      className={cn(
        "group flex items-center gap-2 px-3 py-[3px]",
        props.active ? "bg-primary/15" : "hover:bg-accent/50"
      )}
    >
      <Tooltip content={status.label}>
        <span
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold",
            status.tone
          )}
        >
          {file.status}
        </span>
      </Tooltip>
      <button
        onClick={() => props.onOpen("diff")}
        title={title}
        className="flex min-w-0 flex-1 items-baseline gap-1 text-left"
      >
        <span className="truncate text-[11.5px]">{name}</span>
        <span className="truncate text-[10px] text-muted-foreground/60">{dir}</span>
      </button>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
        <Tooltip content="Blame at this commit">
          <button
            onClick={() => props.onOpen("blame")}
            aria-label={`Blame ${file.path}`}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <ScanText className="h-3 w-3" />
          </button>
        </Tooltip>
        <Tooltip content="File history">
          <button
            onClick={() => props.onOpen("history")}
            aria-label={`History of ${file.path}`}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <FileClock className="h-3 w-3" />
          </button>
        </Tooltip>
      </span>
      <span className="w-16 shrink-0 text-right text-[10px] tabular-nums">
        {file.binary ? (
          <span className="text-muted-foreground/60">bin</span>
        ) : (
          <>
            <span className="text-success">+{file.added}</span>{" "}
            <span className="text-destructive">−{file.removed}</span>
          </>
        )}
      </span>
    </li>
  );
}

/** Copyable short hash — the one piece of a commit people actually reuse. */
export function HashChip({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      .writeText(hash)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };
  return (
    <Tooltip content={copied ? "Copied" : `Copy ${hash}`}>
      <button
        onClick={copy}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5",
          "font-mono text-[10px] text-muted-foreground",
          "hover:bg-accent/60 hover:text-foreground"
        )}
      >
        {copied ? (
          <Check className="h-3 w-3 text-success" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
        {hash.slice(0, 7)}
      </button>
    </Tooltip>
  );
}
