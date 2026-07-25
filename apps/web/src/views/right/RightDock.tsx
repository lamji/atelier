import { useEffect } from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { Activity, FileCode2, FileDiff, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { TerminalPanel } from "@/views/terminal/TerminalPanel";
import { TimelinePanel } from "@/views/timeline/TimelinePanel";
import { GraphPane } from "@/views/knowledge/GraphPane";
import { RagInspectorPane } from "@/views/knowledge/RagInspectorPane";
import { languageForPath } from "@/lib/diff-view";
import type { TerminalSession } from "@atelier/protocol";
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
        <Tooltip content="Close diff">
          <button
            onClick={props.onClose}
            className="ml-auto shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>
      <div className="mx-auto min-h-0 w-full max-w-4xl flex-1 px-4 pb-4 pt-2">
        <DiffEditor
          original={gitDiff.before}
          modified={gitDiff.after}
          language={languageForPath(gitDiff.path)}
          theme={props.monacoTheme}
          options={{
            readOnly: true,
            automaticLayout: true,
            renderSideBySide: false,
            renderOverviewRuler: false,
            minimap: { enabled: false },
            fontSize: 13,
            // See INLINE_DIFF_EDITOR_OPTIONS in diff-view.ts: inline diff mode
            // packs both original+modified line numbers into one gutter, so
            // 3 chars is too narrow once line numbers hit 4 digits.
            lineNumbersMinChars: 6,
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
