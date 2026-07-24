import { useEffect } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import { Activity, FileCode2, FileDiff, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { TerminalPanel } from "@/views/terminal/TerminalPanel";
import { TimelinePanel } from "@/views/timeline/TimelinePanel";
import { GraphPane } from "@/views/knowledge/GraphPane";
import { RagInspectorPane } from "@/views/knowledge/RagInspectorPane";
import type { Diff, TerminalSession } from "@atelier/protocol";
import type { RightTab } from "@/state/workspace.store";
import type { GitDiffView } from "@/state/git.store";
import type { TimelineEntryVm } from "@/types";
import type { useKnowledgeViewModel } from "@/hooks/useKnowledgeViewModel";
import type { useRagInspectorViewModel } from "@/hooks/useRagInspectorViewModel";

export interface RightDockProps {
  /** Which pane is visible; the tab bar itself lives in the app header. */
  rightTab: RightTab;
  /** The chat surface (or connect screen), rendered as the Chat pane. */
  chatPane: React.ReactNode;
  // editor
  selectedPath: string | null;
  fileContent: string | null;
  language: string;
  monacoTheme: string;
  // diffs
  diffs: Diff[];
  activeDiff: Diff | null;
  onShowDiff: (diffId: string) => void;
  // git file diff (takes over the editor pane while open)
  gitDiff: GitDiffView | null;
  onCloseGitDiff: () => void;
  // terminal
  terminalSessions: TerminalSession[];
  activeTermId: string | null;
  onSelectTerm: (termId: string) => void;
  onCreateTerm: () => void;
  onKillTerm: (termId: string) => void;
  onMountTerm: (termId: string, container: HTMLElement) => void;
  onRefitTerm: (termId: string) => void;
  // activity
  timelineEntries: TimelineEntryVm[];
  // knowledge
  knowledgeVm: ReturnType<typeof useKnowledgeViewModel>;
  ragVm: ReturnType<typeof useRagInspectorViewModel>;
  appTheme: "dark" | "light";
}

/**
 * The right-side dock: panes only — the tab bar lives in the app header.
 * Panes stay mounted (hidden with CSS) so Monaco and xterm keep their
 * state across switches.
 */
export function RightDock(props: RightDockProps) {
  const { rightTab, activeTermId, onRefitTerm } = props;

  useEffect(() => {
    if (rightTab === "terminal" && activeTermId) {
      requestAnimationFrame(() => onRefitTerm(activeTermId));
    }
  }, [rightTab, activeTermId, onRefitTerm]);

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <Pane active={props.rightTab === "chat"}>{props.chatPane}</Pane>

        <Pane active={props.rightTab === "editor"}>
          {props.gitDiff !== null ? (
            <GitDiffPane
              gitDiff={props.gitDiff}
              monacoTheme={props.monacoTheme}
              onClose={props.onCloseGitDiff}
            />
          ) : props.fileContent !== null ? (
            <div className="flex h-full flex-col">
              <p className="truncate px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                {props.selectedPath}
              </p>
              <div className="min-h-0 flex-1">
                <Editor
                  path={props.selectedPath ?? undefined}
                  value={props.fileContent}
                  language={props.language}
                  theme={props.monacoTheme}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                  }}
                />
              </div>
            </div>
          ) : (
            <Empty icon={FileCode2} text="Select a file in the explorer." />
          )}
        </Pane>

        <Pane active={props.rightTab === "diffs"}>
          {props.diffs.length > 0 ? (
            <DiffList
              diffs={props.diffs}
              activeDiffId={props.activeDiff?.id ?? null}
              monacoTheme={props.monacoTheme}
              active={props.rightTab === "diffs"}
            />
          ) : (
            <Empty icon={FileDiff} text="Agent edits appear here as diffs." />
          )}
        </Pane>

        <Pane active={props.rightTab === "terminal"}>
          <TerminalPanel
            sessions={props.terminalSessions}
            activeTermId={props.activeTermId}
            onSelect={props.onSelectTerm}
            onCreate={props.onCreateTerm}
            onKill={props.onKillTerm}
            onMount={props.onMountTerm}
            onRefit={props.onRefitTerm}
          />
        </Pane>

        <Pane active={props.rightTab === "graph"}>
          <GraphPane vm={props.knowledgeVm} theme={props.appTheme} />
        </Pane>

        <Pane active={props.rightTab === "rag"}>
          <RagInspectorPane vm={props.ragVm} />
        </Pane>

        <Pane active={props.rightTab === "activity"}>
          <TimelinePanel entries={props.timelineEntries} />
        </Pane>
      </div>
    </div>
  );
}

/** Full-height DiffEditor for a git working-tree/index diff of one file. */
function GitDiffPane(props: {
  gitDiff: GitDiffView;
  monacoTheme: string;
  onClose: () => void;
}) {
  const { gitDiff } = props;
  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-2 px-4 pt-4">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        <p className="truncate font-mono text-xs font-medium">{gitDiff.path}</p>
        <span className="shrink-0 text-[10px] text-muted-foreground/70">
          {gitDiff.staged ? "staged" : "working tree"}
        </span>
        <button
          onClick={props.onClose}
          title="Close diff"
          className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mx-auto min-h-0 w-full max-w-4xl flex-1 px-4 pb-4 pt-2">
        <DiffEditor
          original={gitDiff.before}
          modified={gitDiff.after}
          language={languageForPath(gitDiff.path)}
          theme={props.monacoTheme}
          options={{
            readOnly: true,
            renderSideBySide: false,
            renderOverviewRuler: false,
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbersMinChars: 3,
            glyphMargin: false,
            folding: false,
            scrollBeyondLastLine: false,
            hideUnchangedRegions: { enabled: true },
          }}
        />
      </div>
    </div>
  );
}

const MAX_RENDERED_DIFFS = 10;

/**
 * All diffs in one scroll view, newest last, centered in a chat-width
 * column. Flat by design — no cards, borders, or shadows: each file is a
 * quiet path header, an added/removed stat, and the diff itself, split by
 * generous whitespace. The most recent diff auto-scrolls into view.
 */
function DiffList(props: {
  diffs: Diff[];
  activeDiffId: string | null;
  monacoTheme: string;
  active: boolean;
}) {
  const rendered = props.diffs.slice(-MAX_RENDERED_DIFFS);
  const hidden = props.diffs.length - rendered.length;
  // Follows new diffs only while you're at the bottom.
  const { ref: scrollRef, onScroll } = useStickToBottom<HTMLDivElement>([
    props.diffs.length,
    props.active,
  ]);

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-4">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
        {hidden > 0 && (
          <p className="text-center text-[11px] text-muted-foreground/60">
            {hidden} older {hidden === 1 ? "diff" : "diffs"} not shown
          </p>
        )}
        {rendered.map((diff) => (
          <section
            key={diff.id}
            className={cn(
              "scroll-mt-4",
              diff.id === props.activeDiffId && "opacity-100"
            )}
          >
            <DiffHeader diff={diff} />
            <div className="mt-2" style={{ height: diffHeight(diff) }}>
              <DiffEditor
                original={diff.before}
                modified={diff.after}
                language={languageForPath(diff.path)}
                theme={props.monacoTheme}
                options={DIFF_EDITOR_OPTIONS}
              />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Shared read-only, inline, chrome-light options for every diff view. */
const DIFF_EDITOR_OPTIONS = {
  readOnly: true,
  renderSideBySide: false,
  renderOverviewRuler: false,
  minimap: { enabled: false },
  fontSize: 12.5,
  lineNumbersMinChars: 3,
  glyphMargin: false,
  folding: false,
  scrollBeyondLastLine: false,
  hideUnchangedRegions: { enabled: true },
  guides: { indentation: false },
  scrollbar: { vertical: "hidden" as const, alwaysConsumeMouseWheel: false },
} as const;

/** Quiet file header: path + a green/red line stat. No fill, no border. */
function DiffHeader({ diff }: { diff: Diff }) {
  const { added, removed } = lineStat(diff.before, diff.after);
  return (
    <div className="flex items-center gap-2">
      <FileDiff className="h-3.5 w-3.5 shrink-0 text-primary/70" />
      <span className="truncate font-mono text-xs font-medium">{diff.path}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
        {added > 0 && <span className="text-emerald-500">+{added}</span>}
        {removed > 0 && <span className="text-destructive">−{removed}</span>}
      </span>
      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
        {new Date(diff.createdAt).toLocaleTimeString(undefined, {
          hour12: false,
        })}
      </span>
    </div>
  );
}

/** Cheap multiset line delta for the header badge (not a full LCS diff). */
function lineStat(
  before: string,
  after: string
): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let added = 0;
  for (const line of after.split("\n")) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else added += 1;
  }
  const removed = [...counts.values()].reduce((a, b) => a + b, 0);
  return { added, removed };
}

function diffHeight(diff: Diff): number {
  const lines = Math.max(
    diff.before.split("\n").length,
    diff.after.split("\n").length
  );
  return Math.min(Math.max(lines * 19 + 24, 90), 320);
}

const DIFF_LANGS: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  py: "python",
};

function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return DIFF_LANGS[ext] ?? "plaintext";
}

/**
 * Keeps children mounted; hides inactive panes with display:none so heavy
 * surfaces (Monaco, xterm) can never paint over the active pane.
 */
function Pane(props: { active: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("absolute inset-0", !props.active && "hidden")}>
      {props.children}
    </div>
  );
}

function Empty(props: { icon: typeof Activity; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <props.icon className="h-6 w-6 text-muted-foreground/50" />
      <p className="text-xs text-muted-foreground">{props.text}</p>
    </div>
  );
}
