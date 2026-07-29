import { memo, useCallback, useEffect, useRef, useState } from "react";
import Editor, { DiffEditor, type Monaco } from "@monaco-editor/react";
import { Activity, FileCode2, FileDiff, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { GraphPane } from "@/views/knowledge/GraphPane";
import { RagInspectorPane } from "@/views/knowledge/RagInspectorPane";
import { languageForPath } from "@/lib/diff-view";
import { registerMarkdownMentions } from "@/lib/monaco-mentions";
import { bridge } from "@/services/bridge-client";
import type { SlashCommand } from "@atelier/protocol";
import type { RightTab } from "@/state/workspace.store";
import type { GitDiffView } from "@/state/git.store";
import type { useKnowledgeViewModel } from "@/hooks/useKnowledgeViewModel";
import type { useRagInspectorViewModel } from "@/hooks/useRagInspectorViewModel";

export interface RightDockProps {
  /** Which pane is visible; the tab bar itself lives in the app header. */
  rightTab: RightTab;
  /** The chat surface (or connect screen), rendered as the Chat pane. */
  chatPane: React.ReactNode;
  skillDetail: { command: SlashCommand; content: string } | null;
  onCloseSkillDetail: () => void;
  // editor
  selectedPath: string | null;
  fileContent: string | null;
  language: string;
  monacoTheme: string;
  // git file diff (takes over the editor pane while open)
  gitDiff: GitDiffView | null;
  onCloseGitDiff: () => void;
  // knowledge
  knowledgeVm: ReturnType<typeof useKnowledgeViewModel>;
  ragVm: ReturnType<typeof useRagInspectorViewModel>;
  appTheme: "dark" | "light";
}

/**
 * Read-only file view options. Hoisted out of render: @monaco-editor/react
 * pushes `options` into the editor whenever the object identity changes, so
 * an inline literal made every parent render re-apply them.
 */
const FILE_EDITOR_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
} as const;

/** .atelier notes are user-owned, so their editor is writable. Document
 *  words as suggestions are noise in prose — only "@" mentions complete. */
const EDITABLE_FILE_OPTIONS = {
  readOnly: false,
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
  wordWrap: "on",
  wordBasedSuggestions: "off",
} as const;

const GIT_DIFF_EDITOR_OPTIONS = {
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
} as const;

/**
 * The right-side dock: panes only — the tab bar lives in the app header.
 *
 * Panes that own expensive live state stay mounted (Monaco, xterm, the 3D
 * graph) so switching tabs doesn't rebuild them; the graph is told when it
 * is hidden so it can stop rendering. Stateless panes (activity, RAG) mount
 * only while visible, so their lists cost nothing when they aren't on screen.
 */
export function RightDock(props: RightDockProps) {
  const { rightTab } = props;

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <Pane active={rightTab === "chat"}>
          {props.skillDetail ? (
            <SkillDetailPane
              detail={props.skillDetail}
              onClose={props.onCloseSkillDetail}
            />
          ) : (
            props.chatPane
          )}
        </Pane>

        <Pane active={rightTab === "editor"}>
          {props.gitDiff !== null ? (
            <GitDiffPane
              gitDiff={props.gitDiff}
              monacoTheme={props.monacoTheme}
              onClose={props.onCloseGitDiff}
            />
          ) : (
            <FilePane
              selectedPath={props.selectedPath}
              fileContent={props.fileContent}
              language={props.language}
              monacoTheme={props.monacoTheme}
            />
          )}
        </Pane>

        <Pane active={rightTab === "graph"}>
          <GraphPane
            vm={props.knowledgeVm}
            theme={props.appTheme}
            active={rightTab === "graph"}
          />
        </Pane>

        <Pane active={rightTab === "rag"} mountWhenHidden={false}>
          <RagInspectorPane vm={props.ragVm} />
        </Pane>
      </div>
    </div>
  );
}

const SkillDetailPane = memo(function SkillDetailPane(props: {
  detail: { command: SlashCommand; content: string };
  onClose: () => void;
}) {
  const { command, content } = props.detail;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-sm font-semibold">
            /{command.name}
          </p>
          {command.description && (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {command.description}
            </p>
          )}
        </div>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
          {command.scope}
        </span>
        <button
          type="button"
          onClick={props.onClose}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground"
          title="Close"
          aria-label="Close skill detail"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="chat-md mx-auto max-w-4xl">
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
      </div>
    </div>
  );
});

/** Monaco view of the selected workspace file. */
/** Idle → typing debounce → save; errors keep the edit queued for retry. */
type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

const AUTOSAVE_MS = 800;

/** Only the app's own markdown cache is user-editable; source files stay
 *  read-only — the agent edits those, and its edits belong to the chat. */
function isEditablePath(path: string | null): boolean {
  return path?.startsWith(".atelier/") ?? false;
}

const FilePane = memo(function FilePane(props: {
  selectedPath: string | null;
  fileContent: string | null;
  language: string;
  monacoTheme: string;
}) {
  const editable = isEditablePath(props.selectedPath);
  const [saveState, setSaveState] = useState<SaveState>("clean");
  const pendingRef = useRef<{ path: string; content: string } | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const flush = useCallback(async () => {
    window.clearTimeout(timerRef.current);
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setSaveState("saving");
    try {
      await bridge.rpc("fs.writeFile", pending);
      // Typing during the await re-queues; don't claim "Saved" over it.
      setSaveState(pendingRef.current ? "dirty" : "saved");
    } catch {
      // Keep the edit queued so Ctrl+S / the next change retries it.
      pendingRef.current = pendingRef.current ?? pending;
      setSaveState("error");
    }
  }, []);

  // Leaving the file (or unmounting) flushes its pending edit; the queued
  // {path, content} pair keeps the write pointed at the right file.
  useEffect(() => {
    setSaveState("clean");
    return () => void flush();
  }, [props.selectedPath, flush]);

  const onChange = (value: string | undefined) => {
    if (!editable || value === undefined || !props.selectedPath) return;
    pendingRef.current = { path: props.selectedPath, content: value };
    setSaveState("dirty");
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  const onMount = (
    editor: Parameters<NonNullable<React.ComponentProps<typeof Editor>["onMount"]>>[0],
    monaco: Monaco
  ) => {
    registerMarkdownMentions(monaco);
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => void flush()
    );
  };

  if (props.fileContent === null) {
    return <Empty icon={FileCode2} text="Select a file in the explorer." />;
  }
  return (
    <div className="flex h-full flex-col">
      <p className="flex items-center gap-2 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        <span className="truncate">{props.selectedPath}</span>
        {editable && saveState !== "clean" && (
          <span
            className={cn(
              "shrink-0 text-[10px]",
              saveState === "error"
                ? "text-destructive"
                : "text-muted-foreground/60"
            )}
          >
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "Saved"
                : saveState === "error"
                  ? "Save failed"
                  : "Unsaved"}
          </span>
        )}
      </p>
      <div className="min-h-0 flex-1">
        <Editor
          path={props.selectedPath ?? undefined}
          value={props.fileContent}
          language={props.language}
          theme={props.monacoTheme}
          onChange={editable ? onChange : undefined}
          onMount={onMount}
          options={editable ? EDITABLE_FILE_OPTIONS : FILE_EDITOR_OPTIONS}
        />
      </div>
    </div>
  );
});

/** Full-height DiffEditor for a git working-tree/index diff of one file. */
const GitDiffPane = memo(function GitDiffPane(props: {
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
          options={GIT_DIFF_EDITOR_OPTIONS}
        />
      </div>
    </div>
  );
});

/**
 * One dock pane. `mountWhenHidden` panes (the default) are kept in the tree
 * and hidden with display:none so heavy surfaces keep their state; the rest
 * are unmounted while inactive.
 */
function Pane(props: {
  active: boolean;
  mountWhenHidden?: boolean;
  children: React.ReactNode;
}) {
  const keep = props.mountWhenHidden ?? true;
  if (!props.active && !keep) return null;
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
