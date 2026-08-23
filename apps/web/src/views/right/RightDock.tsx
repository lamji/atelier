import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import { MonacoDiff } from "@/components/MonacoDiff";
import {
  Activity,
  AlignLeft,
  Eye,
  FileCode2,
  FileDiff,
  ImageIcon,
  Pencil,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";
import { isImagePath } from "@/lib/image-file";
import { Tooltip } from "@/components/ui/tooltip";
import { TimelinePanel } from "@/views/timeline/TimelinePanel";
import { ProcessConsolePanel } from "@/views/console/ProcessConsolePanel";
import { GraphPane } from "@/views/knowledge/GraphPane";
import { RagInspectorPane } from "@/views/knowledge/RagInspectorPane";
import { languageForPath } from "@/lib/diff-view";
import {
  clearMentionCache,
  registerMarkdownMentions,
} from "@/lib/monaco-mentions";
import { bridge } from "@/services/bridge-client";
import { useGitMergeStore } from "@/state/git-merge.store";
import { useMergeConflictViewModel } from "@/hooks/useMergeConflictViewModel";
import { ConflictResolver } from "@/views/git/ConflictResolver";
import { useWorkspaceStore } from "@/state/workspace.store";
import { useKnowledgeViewModel } from "@/hooks/useKnowledgeViewModel";
import { useRagInspectorViewModel } from "@/hooks/useRagInspectorViewModel";
import type { SlashCommand } from "@atelier/protocol";
import type { RightTab } from "@/state/workspace.store";
import type { GitDiffView } from "@/state/git.store";
import type { TimelineEntryVm } from "@/types";
import type { ProcessConsoleVm } from "@/hooks/useProcessConsoleViewModel";

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
  appTheme: "dark" | "light";
  /** Execution timeline, shown as the Activity pane. */
  timelineEntries: TimelineEntryVm[];
  /** Streamed process output, shown as the Output pane. */
  processConsoleVm: ProcessConsoleVm;
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
  cursorStyle: "block",
  cursorBlinking: "blink",
  scrollBeyondLastLine: false,
} as const;

/** .atelier notes are user-owned, so their editor is writable. Document
 *  words as suggestions are noise in prose — only "@" mentions complete. */
const EDITABLE_FILE_OPTIONS = {
  readOnly: false,
  minimap: { enabled: false },
  fontSize: 13,
  // The caret is Monaco's own: a content widget pinned "near" the position
  // drifted away from the text cursor, and only tracked it while the editor
  // held focus. A native line caret is the cursor, so it can never disagree
  // with where typing lands. It is widened and tinted (see
  // `.atelier-file-editor` in index.css) to stay easy to find.
  cursorStyle: "line",
  cursorWidth: 2,
  cursorBlinking: "solid",
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
  // Inline diff mode packs BOTH original and modified line numbers into one
  // gutter column. 3 chars only fits one 3-digit number — past line 999 the
  // two run together (e.g. "2968" + "2968" -> "29682968"). This pane is full
  // width, so it can afford the 6 the pair needs; the changes rail cannot,
  // and turns line numbers off instead.
  lineNumbersMinChars: 6,
  glyphMargin: false,
  folding: false,
  scrollBeyondLastLine: false,
  hideUnchangedRegions: { enabled: true },
} as const;

/** Decoration for a search match in the editor: subtle outline + tinted
 *  background, the same amber family as the file-name highlight so the
 *  two read as one concept. The "active" one (first match) is darker so
 *  the user's eyes land where the editor scrolled to. */
const SEARCH_DECORATION = {
  inlineClassName:
    "rounded-[2px] bg-amber-300/25 text-foreground ring-1 ring-amber-400/40",
};
const SEARCH_DECORATION_ACTIVE = {
  inlineClassName:
    "rounded-[2px] bg-amber-300/45 text-foreground ring-1 ring-amber-500/70",
};

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
  const knowledgeVm = useKnowledgeViewModel();
  const ragVm = useRagInspectorViewModel();
  // A conflicted file opened from the explorer takes over the editor pane
  // the same way a git diff does — and outranks it, since a merge conflict
  // is the more urgent thing to be looking at.
  const conflictOpen = useGitMergeStore((s) => s.openPath !== null);

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
          {conflictOpen ? (
            <ConflictPane />
          ) : props.gitDiff !== null ? (
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
          <GraphPane vm={knowledgeVm} theme={props.appTheme} />
        </Pane>

        <Pane active={rightTab === "rag"}>
          <RagInspectorPane vm={ragVm} />
        </Pane>

        {/* The execution timeline. It was a tab in the bottom dock; as a
            full-height feed it belongs beside the editor, and moving it
            freed the dock's bar to become the terminal tab strip. */}
        <Pane active={rightTab === "activity"} mountWhenHidden={false}>
          <TimelinePanel entries={props.timelineEntries} />
        </Pane>

        {/* Stays mounted: its scroll position is the one piece of state a
            reader is in the middle of using, and remounting would drop them
            back at the bottom of a suite they had scrolled up to read. */}
        <Pane active={rightTab === "output"}>
          <ProcessConsolePanel vm={props.processConsoleVm} />
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

/**
 * Languages a bundled Monaco worker can pretty-print. Monaco ships a
 * formatter with the TypeScript, JSON, CSS and HTML workers and with
 * nothing else — `markdown`, `yaml`, `python`, `go` … have no provider, so
 * the Format action is hidden for them rather than being a button that
 * does nothing.
 */
const FORMATTABLE_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "json",
  "css",
  "scss",
  "less",
  "html",
]);

/** Formatting a huge generated file (a lockfile, a bundled vendor blob)
 *  costs seconds of worker time for a file nobody is editing by hand. */
const FORMAT_MAX_BYTES = 400_000;

/**
 * Runs Monaco's own format-document action. The action is always
 * registered, but it no-ops until the language's worker has registered its
 * provider — which happens asynchronously the first time a language is
 * used. On open we therefore retry a few times; an already-formatted file
 * simply comes back unchanged each time, which is cheap.
 */
async function formatDocument(
  editor: Parameters<NonNullable<React.ComponentProps<typeof Editor>["onMount"]>>[0],
  attempts = 1
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const model = editor.getModel();
    if (!model) return;
    const before = model.getVersionId();
    await editor.getAction("editor.action.formatDocument")?.run();
    if (model.getVersionId() !== before) return;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
  }
}

/** Every opened text file is user-editable — the explorer pane is a real
 *  editor, not just a preview of what the agent produced. */
function isEditablePath(path: string | null): boolean {
  return path !== null;
}

/** The file pane is just a Monaco view — except for markdown, where the
 *  user expects a rendered preview. Both tabs share the same body so the
 *  scroll position, autosave state and dirty flag carry over. */
function isMarkdownPath(path: string | null): boolean {
  return path?.toLowerCase().endsWith(".md") ?? false;
}

/** HTML files get the same Editor/Preview treatment as markdown: source in
 *  Monaco, sandboxed iframe in Preview. .htm is the legacy short form. */
function isHtmlPath(path: string | null): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

function isPreviewablePath(path: string | null): boolean {
  return isMarkdownPath(path) || isHtmlPath(path);
}

const FilePane = memo(function FilePane(props: {
  selectedPath: string | null;
  fileContent: string | null;
  language: string;
  monacoTheme: string;
}) {
  const editable = isEditablePath(props.selectedPath);
  const markdown = isMarkdownPath(props.selectedPath);
  const html = isHtmlPath(props.selectedPath);
  const previewable = isPreviewablePath(props.selectedPath);
  const [saveState, setSaveState] = useState<SaveState>("clean");
  /**
   * The text Monaco actually holds. It is NOT `props.fileContent` directly:
   * autosaving a note makes the workspace watcher echo the file back, and
   * that echo lands a keystroke or two late. Feeding it straight into the
   * editor replaced the whole model — dropping the characters typed since
   * the save and throwing the caret to the end of the edit — which read as
   * the editor "jumping" mid-sentence. External content is adopted only
   * while this pane has no local edit in flight.
   */
  const [text, setText] = useState<string>(props.fileContent ?? "");
  const dirtyRef = useRef(false);
  /**
   * True while a format-on-open rewrite is being applied. The resulting
   * model change is not the user's edit, so it is queued as "Unsaved"
   * without arming the autosave timer — browsing files in the explorer
   * must not rewrite them on disk behind the user's back. Ctrl+S, or the
   * first real keystroke, is what commits it.
   */
  const formattingRef = useRef(false);
  /** Whether the queued write holds nothing but a format-on-open rewrite. */
  const formatOnlyRef = useRef(false);
  /** Monaco mounts asynchronously; format-on-open waits for this. */
  const [editorReady, setEditorReady] = useState(false);
  /** "editor" keeps the source in Monaco; "preview" renders HTML or Markdown. */
  const [view, setView] = useState<"editor" | "preview">("editor");
  const pendingRef = useRef<{ path: string; content: string } | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  // The Monaco editor instance, kept in a ref so the search-decoration
  // effect can re-paint highlights after a search query or content change
  // without re-running onMount. The previous decoration IDs are tracked
  // separately so we can clear them in one deltaDecorations call.
  const editorRef = useRef<Parameters<
    NonNullable<React.ComponentProps<typeof Editor>["onMount"]>
  >[0] | null>(null);
  const searchDecorationsRef = useRef<string[]>([]);
  /** The active file-name search, lifted out of the panel so Monaco (which
   *  lives in a different view tree) can highlight the same matches. */
  const searchQuery = useWorkspaceStore((s) => s.searchQuery);

  const flush = useCallback(async (force = false) => {
    window.clearTimeout(timerRef.current);
    const pending = pendingRef.current;
    if (!pending) return;
    // An unforced flush (leaving the file, unmounting) drops a queue that
    // only holds a format-on-open rewrite: the user never asked for it, so
    // it must not reach disk as a side effect of navigating away.
    if (formatOnlyRef.current && !force) {
      pendingRef.current = null;
      formatOnlyRef.current = false;
      dirtyRef.current = false;
      setSaveState("clean");
      return;
    }
    pendingRef.current = null;
    formatOnlyRef.current = false;
    setSaveState("saving");
    try {
      await bridge.rpc("fs.writeFile", pending);
      // Typing during the await re-queues; don't claim "Saved" over it.
      // Only a fully-drained queue makes this pane clean again; until then
      // the watcher echo must keep its hands off the model.
      dirtyRef.current = pendingRef.current !== null;
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
    setView("editor");
    return () => void flush();
  }, [props.selectedPath, flush]);

  // A new file always wins: its content is a different document, not an
  // echo of this one.
  useEffect(() => {
    dirtyRef.current = false;
    setText(props.fileContent ?? "");
    // Keyed on the path ALONE — adding fileContent here would re-arm on
    // every watcher echo and undo the guard. Content changes are the next
    // effect's job.
  }, [props.selectedPath]);

  // An agent (or another editor) changing the open file on disk is adopted
  // — unless the user is mid-edit, in which case their buffer is the truth
  // and the pending autosave will write it back.
  useEffect(() => {
    if (dirtyRef.current) return;
    setText(props.fileContent ?? "");
  }, [props.fileContent]);

  // Switching workspaces DROPS a queued edit instead of flushing it. The
  // bridge is already re-pointed at the new project's agent, and the queued
  // path is relative — retrying it there would write this project's content
  // into the same relative path of another project.
  const workspaceEpoch = useWorkspaceStore((s) => s.workspaceEpoch);
  useEffect(() => {
    window.clearTimeout(timerRef.current);
    pendingRef.current = null;
    dirtyRef.current = false;
    setSaveState("clean");
    // Cached "@" listings belong to the project we just left.
    clearMentionCache();
  }, [workspaceEpoch]);

  const onChange = (value: string | undefined) => {
    if (!editable || value === undefined || !props.selectedPath) return;
    setText(value);
    dirtyRef.current = true;
    pendingRef.current = { path: props.selectedPath, content: value };
    setSaveState("dirty");
    window.clearTimeout(timerRef.current);
    if (formattingRef.current) {
      formatOnlyRef.current = true;
      return;
    }
    // A real keystroke on top of a format adopts it: both go to disk.
    formatOnlyRef.current = false;
    timerRef.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  const onMount = (
    editor: Parameters<NonNullable<React.ComponentProps<typeof Editor>["onMount"]>>[0],
    monaco: Monaco
  ) => {
    editorRef.current = editor;
    registerMarkdownMentions(monaco);
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => void flush(true)
    );
    setEditorReady(true);
  };

  /** The header button and Shift+Alt+F run the same one-shot format. */
  const runFormat = useCallback(() => {
    const editor = editorRef.current;
    if (editor) void formatDocument(editor);
  }, []);

  /*
   * Format on open. Every file the explorer opens is pretty-printed as soon
   * as its model is live, so what you read is the formatted shape rather
   * than whatever the last writer left. The rewrite lands in the buffer
   * only — the pane goes "Unsaved" and waits for Ctrl+S or a real edit, so
   * simply browsing a file never rewrites it on disk.
   */
  useEffect(() => {
    if (!editable || !editorReady) return;
    // Never reformat a buffer the user is in the middle of typing into.
    if (dirtyRef.current) return;
    if (!FORMATTABLE_LANGUAGES.has(props.language)) return;
    if ((props.fileContent?.length ?? 0) > FORMAT_MAX_BYTES) return;
    const editor = editorRef.current;
    if (!editor) return;
    let cancelled = false;
    void (async () => {
      formattingRef.current = true;
      try {
        // The model is swapped by the `path` prop; only format the file
        // this effect was fired for.
        const uri = editor.getModel()?.uri.path ?? "";
        if (uri.endsWith(props.selectedPath ?? "")) {
          await formatDocument(editor, 3);
        }
      } finally {
        if (!cancelled) formattingRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
      formattingRef.current = false;
    };
  }, [
    props.selectedPath,
    props.language,
    props.fileContent,
    editable,
    editorReady,
  ]);

  // Unmount releases the editor ref and any decorations the search effect
  // put down — a fresh FilePane (workspace switch) starts with a clean view.
  useEffect(() => {
    return () => {
      editorRef.current = null;
      searchDecorationsRef.current = [];
    };
  }, []);

  // Paint search highlights whenever the user types in the explorer search
  // box, the open file changes, or the file's text mutates (e.g. agent
  // refresh on the bridge). An empty query clears everything; a non-empty
  // query drops all matches into one decoration set and scrolls the FIRST
  // match into view, so the user lands somewhere useful after picking a
  // result from the list.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    // Clear whatever we drew before — important when the query empties.
    searchDecorationsRef.current = editor.deltaDecorations(
      searchDecorationsRef.current,
      []
    );
    const needle = searchQuery.trim();
    if (!needle) return;
    const matches = model.findMatches(
      needle,
      true, // searchOnlyEditableRange
      false, // isRegex
      false, // matchCase
      needle, // wholeWord
      true, // captureMatches
      1000 // limitResultCount — caps to a sane number
    );
    if (matches.length === 0) return;
    const newDecorations = matches.map((m, i) => ({
      range: m.range,
      options: i === 0 ? SEARCH_DECORATION_ACTIVE : SEARCH_DECORATION,
    }));
    searchDecorationsRef.current = editor.deltaDecorations(
      [],
      newDecorations
    );
    // Center the first match in the viewport so the user does not have to
    // hunt for the highlighted region after opening a file from search.
    const first = matches[0]?.range;
    if (first) editor.revealRangeInCenterIfOutsideViewport(first);
  }, [searchQuery, text, props.selectedPath]);

  if (props.fileContent === null) {
    return <Empty icon={FileCode2} text="Select a file in the explorer." />;
  }
  if (isImagePath(props.selectedPath)) {
    return (
      <div className="flex h-full flex-col">
        <p className="flex items-center gap-2 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          <ImageIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{props.selectedPath}</span>
        </p>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/15 p-6">
          <img
            src={props.fileContent}
            alt={props.selectedPath ?? "Selected image"}
            className="block max-h-full max-w-full object-contain"
          />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {props.selectedPath}
        </span>
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
        {editable && FORMATTABLE_LANGUAGES.has(props.language) && (
          <Tooltip content="Format document (Shift+Alt+F)">
            <button
              type="button"
              onClick={runFormat}
              aria-label="Format document"
              className={cn(
                "grid h-6 w-6 shrink-0 place-items-center rounded-md",
                "text-muted-foreground/60 transition-colors",
                "hover:bg-muted/60 hover:text-foreground"
              )}
            >
              <AlignLeft className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
        {previewable && (
          <div
            role="tablist"
            aria-label={
              markdown ? "Markdown view" : "HTML view"
            }
            className="flex shrink-0 items-center gap-1 rounded-full bg-muted/60 p-0.5"
          >
            <MarkdownViewTab
              active={view === "editor"}
              icon={Pencil}
              label="Editor"
              onClick={() => setView("editor")}
            />
            <MarkdownViewTab
              active={view === "preview"}
              icon={Eye}
              label="Preview"
              onClick={() => setView("preview")}
            />
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {previewable && view === "preview" ? (
          markdown ? (
            <div className="h-full overflow-y-auto px-6 py-5">
              <div className="chat-md mx-auto max-w-3xl">
                <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
              </div>
            </div>
          ) : html ? (
            <iframe
              title={props.selectedPath ?? "HTML preview"}
              srcDoc={text}
              sandbox=""
              className="h-full w-full border-0 bg-background"
            />
          ) : null
        ) : (
          <Editor
            path={props.selectedPath ?? undefined}
            value={text}
            language={props.language}
            theme={props.monacoTheme}
            onChange={editable ? onChange : undefined}
            onMount={onMount}
            options={editable ? EDITABLE_FILE_OPTIONS : FILE_EDITOR_OPTIONS}
            className={editable ? "atelier-file-editor" : undefined}
          />
        )}
      </div>
    </div>
  );
});

/** One pill of the Editor/Preview toggle in the markdown file pane. */
function MarkdownViewTab(props: {
  active: boolean;
  icon: typeof Pencil;
  label: string;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      onClick={props.onClick}
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition-colors",
        props.active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      <Icon className="h-3 w-3" />
      {props.label}
    </button>
  );
}

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
        <MonacoDiff
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

/** The merge resolver, hosted in the editor pane (explorer / chat views). */
function ConflictPane() {
  const vm = useMergeConflictViewModel();
  return (
    <div className="h-full">
      <ConflictResolver vm={vm} compact />
    </div>
  );
}

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
