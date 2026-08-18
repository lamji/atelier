import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import type {
  editor as MonacoEditor,
  languages as MonacoLanguages,
  IDisposable,
} from "monaco-editor";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CircleAlert,
  Columns2,
  GitMerge,
  Loader2,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/error-text";
import { languageForPath } from "@/lib/diff-view";
import {
  blockAtOrAfter,
  parseConflicts,
  resolveAll,
  type ConflictBlock,
  type ConflictChoice,
} from "@/lib/conflict-markers";
import { MonacoDiff } from "@/components/MonacoDiff";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useThemeStore } from "@/state/theme.store";
import type { MergeConflictViewModel } from "@/hooks/useMergeConflictViewModel";

type CodeEditor = MonacoEditor.IStandaloneCodeEditor;

const AUTOSAVE_MS = 800;

const EDITOR_OPTIONS: MonacoEditor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  fontSize: 13,
  scrollBeyondLastLine: false,
  wordWrap: "off",
  glyphMargin: true,
  folding: false,
  lineNumbersMinChars: 4,
  renderLineHighlight: "line",
  automaticLayout: true,
  codeLens: true,
  wordBasedSuggestions: "off",
  quickSuggestions: false,
};

const COMPARE_OPTIONS = {
  readOnly: true,
  automaticLayout: true,
  renderSideBySide: true,
  renderOverviewRuler: false,
  minimap: { enabled: false },
  fontSize: 12,
  lineNumbersMinChars: 4,
  glyphMargin: false,
  folding: false,
  scrollBeyondLastLine: false,
  hideUnchangedRegions: { enabled: true },
} as const;

/**
 * Per-model registry the (single, global) CodeLens provider reads from:
 * the current blocks of each open resolver and the command ids that
 * apply a choice inside that editor. Monaco's provider API is global to
 * the language, so this is how a lens knows which editor it belongs to.
 */
interface LensEntry {
  blocks: () => ConflictBlock[];
  commands: Record<ConflictChoice, string>;
  oursLabel: string;
  theirsLabel: string;
}
const lensRegistry = new Map<string, LensEntry>();
let lensProvider: IDisposable | null = null;
let lensEmitter: { fire: () => void } | null = null;

function ensureLensProvider(monaco: Monaco): void {
  if (lensProvider) return;
  const emitter = new monaco.Emitter<MonacoLanguages.CodeLensProvider>();
  const provider: MonacoLanguages.CodeLensProvider = {
    onDidChange: emitter.event,
    provideCodeLenses(model) {
      const entry = lensRegistry.get(model.uri.toString());
      if (!entry) return { lenses: [], dispose: () => undefined };
      const lenses = entry.blocks().flatMap((block, i) => {
        const range = {
          startLineNumber: block.start,
          startColumn: 1,
          endLineNumber: block.start,
          endColumn: 1,
        };
        const lens = (title: string, choice: ConflictChoice) => ({
          range,
          id: `${choice}:${i}`,
          command: { id: entry.commands[choice], title, arguments: [i] },
        });
        const out = [
          lens("Accept Current", "ours"),
          lens("Accept Incoming", "theirs"),
          lens("Accept Both", "both"),
        ];
        if (block.baseSep !== null) out.push(lens("Take Base", "base"));
        return out;
      });
      return { lenses, dispose: () => undefined };
    },
  };
  lensEmitter = { fire: () => emitter.fire(provider) };
  lensProvider = monaco.languages.registerCodeLensProvider(
    { scheme: "atelier-conflict" },
    provider
  );
}

/**
 * The merge editor for ONE conflicted file. Editable Monaco with the
 * conflict regions highlighted, a CodeLens row above each conflict, keyboard
 * navigation between conflicts, an optional ours ↔ theirs compare, autosave
 * to the working tree, and "Mark resolved" which stages the result.
 */
export function ConflictResolver({
  vm,
  compact,
}: {
  vm: MergeConflictViewModel;
  /** Narrower chrome for the RightDock (explorer) placement. */
  compact?: boolean;
}) {
  const { merge, conflicts } = vm;
  const path = merge.openPath;
  const file = merge.file;
  const theme = useThemeStore((s) => s.theme);
  const monacoTheme = theme === "dark" ? "atelier-dark" : "atelier-light";
  const aiOnThisFile =
    vm.aiWorking && path !== null && (merge.aiPaths?.includes(path) ?? false);

  if (!path) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {file && !merge.loadingFile ? (
        <ResolverBody
          key={path}
          vm={vm}
          path={path}
          file={file}
          monacoTheme={monacoTheme}
          compact={compact ?? false}
          aiBusy={aiOnThisFile}
          position={{
            index: conflicts.indexOf(path),
            total: conflicts.length,
          }}
        />
      ) : (
        <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading {path}…
        </div>
      )}
    </div>
  );
}

function ResolverBody(props: {
  vm: MergeConflictViewModel;
  path: string;
  file: NonNullable<MergeConflictViewModel["merge"]["file"]>;
  monacoTheme: string;
  compact: boolean;
  aiBusy: boolean;
  position: { index: number; total: number };
}) {
  const { vm, path, file, aiBusy } = props;
  const [content, setContent] = useState(file.current);
  const [cursorLine, setCursorLine] = useState(1);
  const [compare, setCompare] = useState(false);
  const [saveState, setSaveState] = useState<"clean" | "dirty" | "saving" | "saved" | "error">(
    "clean"
  );
  const [busy, setBusy] = useState(false);
  const [forceAsk, setForceAsk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editorRef = useRef<CodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const contentRef = useRef(content);
  contentRef.current = content;
  /** What is on disk as far as this resolver knows; autosave targets it. */
  const lastSavedRef = useRef(file.current);
  /** Monaco commands + registry key owned by this mount, released on unmount. */
  const disposablesRef = useRef<IDisposable[]>([]);
  const modelKeyRef = useRef<string | null>(null);

  const blocks = useMemo(() => parseConflicts(content), [content]);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const current = blockAtOrAfter(blocks, cursorLine);
  const language = languageForPath(path);
  const modelPath = `atelier-conflict:///${encodeURI(path)}`;

  // A reload from the agent (AI finished, conflict restored) replaces the
  // buffer. Editing while AI works on the file is locked out below, so
  // there is no local edit to lose here.
  useEffect(() => {
    setContent(file.current);
    lastSavedRef.current = file.current;
    setSaveState("clean");
  }, [file]);

  // ── autosave ──────────────────────────────────────────────────────────
  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const pending = contentRef.current;
    if (pending === lastSavedRef.current) return;
    setSaveState("saving");
    try {
      await vm.saveDraft(path, pending);
      lastSavedRef.current = pending;
      // Typing during the await re-queues; don't claim "Saved" over it.
      setSaveState(contentRef.current === pending ? "saved" : "dirty");
    } catch {
      setSaveState("error");
    }
  }, [path, vm]);

  const onChange = (value: string | undefined) => {
    if (value === undefined) return;
    setContent(value);
    setSaveState("dirty");
    setForceAsk(false);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  // Leaving the file flushes whatever is pending.
  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimer.current);
      const pending = contentRef.current;
      if (pending !== lastSavedRef.current) void vm.saveDraft(path, pending);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // ── decorations ───────────────────────────────────────────────────────
  const paint = useCallback(() => {
    const monaco = monacoRef.current;
    const collection = decorationsRef.current;
    if (!monaco || !collection) return;
    const blocks = blocksRef.current;
    const decs: MonacoEditor.IModelDeltaDecoration[] = [];
    const whole = (
      from: number,
      to: number,
      className: string,
      glyph?: string
    ) => {
      if (to < from) return;
      decs.push({
        range: new monaco.Range(from, 1, to, 1),
        options: {
          isWholeLine: true,
          className,
          ...(glyph ? { glyphMarginClassName: glyph } : {}),
        },
      });
    };
    for (const b of blocks) {
      const oursEnd = (b.baseSep ?? b.sep) - 1;
      whole(b.start, b.start, "conflict-line-marker conflict-line-ours-head", "conflict-glyph-ours");
      whole(b.start + 1, oursEnd, "conflict-line-ours");
      if (b.baseSep !== null) {
        whole(b.baseSep, b.baseSep, "conflict-line-marker");
        whole(b.baseSep + 1, b.sep - 1, "conflict-line-base");
      }
      whole(b.sep, b.sep, "conflict-line-marker");
      whole(b.sep + 1, b.end - 1, "conflict-line-theirs");
      whole(b.end, b.end, "conflict-line-marker conflict-line-theirs-tail", "conflict-glyph-theirs");
    }
    collection.set(decs);
  }, []);
  useEffect(() => {
    paint();
    // Blocks moved: the lens row above each conflict must move with them.
    lensEmitter?.fire();
  }, [blocks, paint]);

  // ── applying a choice through the editor (keeps undo) ─────────────────
  const applyChoice = useCallback((blockIndex: number, choice: ConflictChoice) => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    const block = blocksRef.current[blockIndex];
    if (!editor || !monaco || !model || !block) return;

    const linesOf = (from: number, to: number): string[] => {
      const out: string[] = [];
      for (let n = from; n <= to; n++) out.push(model.getLineContent(n));
      return out;
    };
    const ours = linesOf(block.start + 1, (block.baseSep ?? block.sep) - 1);
    const base = block.baseSep !== null ? linesOf(block.baseSep + 1, block.sep - 1) : [];
    const theirs = linesOf(block.sep + 1, block.end - 1);
    const replacement =
      choice === "ours"
        ? ours
        : choice === "theirs"
          ? theirs
          : choice === "base"
            ? base
            : [...ours, ...theirs];

    const eol = model.getEOL();
    let range: InstanceType<Monaco["Range"]>;
    let text: string;
    if (replacement.length > 0) {
      range = new monaco.Range(
        block.start,
        1,
        block.end,
        model.getLineMaxColumn(block.end)
      );
      text = replacement.join(eol);
    } else if (block.end < model.getLineCount()) {
      // Nothing to keep: remove the block including its trailing newline.
      range = new monaco.Range(block.start, 1, block.end + 1, 1);
      text = "";
    } else if (block.start > 1) {
      range = new monaco.Range(
        block.start - 1,
        model.getLineMaxColumn(block.start - 1),
        block.end,
        model.getLineMaxColumn(block.end)
      );
      text = "";
    } else {
      range = model.getFullModelRange();
      text = "";
    }
    editor.pushUndoStop();
    editor.executeEdits("conflict-resolver", [{ range, text }]);
    editor.pushUndoStop();
    editor.focus();
  }, []);

  const applyAll = (choice: ConflictChoice) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const next = resolveAll(model.getValue(), choice);
    editor.pushUndoStop();
    editor.executeEdits("conflict-resolver", [
      { range: model.getFullModelRange(), text: next },
    ]);
    editor.pushUndoStop();
  };

  const goTo = useCallback((index: number) => {
    const editor = editorRef.current;
    const block = blocksRef.current[index];
    if (!editor || !block) return;
    editor.revealLineInCenter(block.start);
    editor.setPosition({ lineNumber: block.start, column: 1 });
    editor.focus();
  }, []);

  const step = useCallback(
    (delta: 1 | -1) => {
      const list = blocksRef.current;
      if (list.length === 0) return;
      const pos = editorRef.current?.getPosition()?.lineNumber ?? 1;
      const at = list.findIndex((b) => b.start >= pos + (delta === 1 ? 1 : 0));
      let next: number;
      if (delta === 1) next = at === -1 ? 0 : at;
      else {
        const before = list.filter((b) => b.start < pos);
        next = before.length > 0 ? list.indexOf(before[before.length - 1]!) : list.length - 1;
      }
      goTo(next);
    },
    [goTo]
  );

  const onMount = (editor: CodeEditor, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    decorationsRef.current = editor.createDecorationsCollection([]);
    ensureLensProvider(monaco);

    const stamp = Math.random().toString(36).slice(2);
    const cmd = (choice: ConflictChoice) => {
      const id = `atelier.conflict.${choice}.${stamp}`;
      disposablesRef.current.push(
        monaco.editor.registerCommand(id, (_accessor: unknown, index: number) =>
          applyChoice(index, choice)
        )
      );
      return id;
    };
    const model = editor.getModel();
    if (model) {
      modelKeyRef.current = model.uri.toString();
      lensRegistry.set(model.uri.toString(), {
        blocks: () => blocksRef.current,
        commands: {
          ours: cmd("ours"),
          theirs: cmd("theirs"),
          both: cmd("both"),
          base: cmd("base"),
        },
        oursLabel: file.oursLabel,
        theirsLabel: file.theirsLabel,
      });
      lensEmitter?.fire();
    }
    paint();
    editor.onDidChangeCursorPosition((e) => setCursorLine(e.position.lineNumber));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void flush());
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.DownArrow, () => step(1));
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.UpArrow, () => step(-1));
    // Land on the first conflict rather than line 1.
    const first = blocksRef.current[0];
    if (first) {
      editor.revealLineInCenter(first.start);
      editor.setPosition({ lineNumber: first.start, column: 1 });
    }
  };

  useEffect(() => {
    return () => {
      if (modelKeyRef.current) lensRegistry.delete(modelKeyRef.current);
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
    };
  }, []);

  // ── header actions ────────────────────────────────────────────────────
  const act = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void fn()
      .catch((e: unknown) =>
        setError(errorText(e).replace(/^Error:\s*/, "").slice(0, 200))
      )
      .finally(() => setBusy(false));
  };

  const doMarkResolved = () => {
    if (blocks.length > 0 && !forceAsk) {
      setForceAsk(true);
      return;
    }
    setForceAsk(false);
    window.clearTimeout(saveTimer.current);
    const snapshot = contentRef.current;
    lastSavedRef.current = snapshot;
    act(() => vm.markResolved(path, snapshot));
  };

  const remaining = blocks.length;
  const canFinish = !aiBusy && !busy;
  const editorOptions = useMemo(
    () => ({ ...EDITOR_OPTIONS, readOnly: aiBusy }),
    [aiBusy]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className={cn("flex items-center gap-2 px-3 pt-3", props.compact && "px-2 pt-2")}>
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
            file.resolved ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"
          )}
        >
          <GitMerge className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-medium">{path}</p>
          <p className="flex items-center gap-1.5 truncate text-[10px] text-muted-foreground">
            <SideChip tone="ours" label={file.oursLabel} />
            <span className="opacity-50">vs</span>
            <SideChip tone="theirs" label={file.theirsLabel} />
            {file.resolved && (
              <span className="ml-1 rounded-full bg-success/15 px-1.5 text-[10px] font-medium text-success">
                staged
              </span>
            )}
          </p>
        </div>

        {props.position.total > 1 && props.position.index >= 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            file {props.position.index + 1}/{props.position.total}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-secondary/60 p-0.5">
          <Tooltip content="Previous conflict (Alt+↑)">
            <button
              onClick={() => step(-1)}
              disabled={remaining === 0}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-40"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <span className="min-w-[3ch] text-center text-[10px] tabular-nums text-muted-foreground">
            {remaining === 0 ? "0" : `${current + 1}/${remaining}`}
          </span>
          <Tooltip content="Next conflict (Alt+↓)">
            <button
              onClick={() => step(1)}
              disabled={remaining === 0}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:opacity-40"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        </div>
        <Tooltip content={compare ? "Hide side-by-side compare" : "Compare ours ↔ theirs side by side"}>
          <button
            onClick={() => setCompare((v) => !v)}
            aria-pressed={compare}
            className={cn(
              "shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              compare && "bg-accent/60 text-foreground"
            )}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
        <Tooltip content="Close resolver">
          <button
            onClick={vm.closeConflict}
            className="shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      {/* Toolbar */}
      <div className={cn("flex flex-wrap items-center gap-1.5 px-3 pt-2", props.compact && "px-2")}>
        <ChoiceButton
          tone="ours"
          label={props.compact ? "All current" : "Accept all current"}
          hint={`Keep ${file.oursLabel} for every conflict`}
          disabled={remaining === 0 || aiBusy}
          onClick={() => applyAll("ours")}
        />
        <ChoiceButton
          tone="theirs"
          label={props.compact ? "All incoming" : "Accept all incoming"}
          hint={`Keep ${file.theirsLabel} for every conflict`}
          disabled={remaining === 0 || aiBusy}
          onClick={() => applyAll("theirs")}
        />
        <ChoiceButton
          tone="both"
          label="Both"
          hint="Keep current then incoming, for every conflict"
          disabled={remaining === 0 || aiBusy}
          onClick={() => applyAll("both")}
        />
        <span className="mx-0.5 h-4 w-px bg-white/10" />
        <Tooltip content="Ask Sonnet to resolve just this file">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            disabled={aiBusy || vm.aiWorking || remaining === 0}
            onClick={() => void vm.aiResolve([path])}
          >
            {aiBusy ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="mr-1 h-3 w-3 text-primary" />
            )}
            AI resolve
          </Button>
        </Tooltip>
        {file.resolved && (
          <Tooltip content="Put the conflict markers back and unstage">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busy || aiBusy}
              onClick={() => act(() => vm.restore(path))}
            >
              <Undo2 className="mr-1 h-3 w-3" />
              Restore conflict
            </Button>
          </Tooltip>
        )}

        <span className="ml-auto flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground/70">
            {saveState === "saving"
              ? "Saving…"
              : saveState === "saved"
                ? "Saved"
                : saveState === "dirty"
                  ? "Unsaved"
                  : saveState === "error"
                    ? "Save failed"
                    : ""}
          </span>
          {forceAsk ? (
            <span className="flex items-center gap-1 rounded-lg bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning">
              <CircleAlert className="h-3 w-3" />
              {remaining} marker{remaining === 1 ? "" : "s"} left — stage anyway?
              <button
                onClick={doMarkResolved}
                className="rounded px-1 font-medium hover:bg-warning/20"
              >
                Yes
              </button>
              <button
                onClick={() => setForceAsk(false)}
                className="rounded p-0.5 hover:bg-warning/20"
                aria-label="Cancel"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <Tooltip
              content={
                remaining > 0
                  ? `${remaining} conflict${remaining === 1 ? "" : "s"} still marked`
                  : file.resolved
                    ? "Write and re-stage this file"
                    : "Write the file and stage it — git then treats it as resolved"
              }
            >
              <Button
                size="sm"
                disabled={!canFinish}
                onClick={doMarkResolved}
                className={cn(remaining > 0 && "opacity-70")}
              >
                {busy ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                )}
                {file.resolved ? "Save & stage" : "Mark resolved"}
              </Button>
            </Tooltip>
          )}
        </span>
      </div>

      {error && (
        <p className="mx-3 mt-2 rounded-lg bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {error}
        </p>
      )}

      {/* Body */}
      <div className={cn("relative mt-2 flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3", props.compact && "px-2 pb-2")}>
        {compare && (
          <div className="flex min-h-0 basis-2/5 flex-col overflow-hidden rounded-xl ring-1 ring-white/5">
            <div className="grid grid-cols-2 bg-black/20 px-2 py-1 text-[10px]">
              <span className="truncate text-cyan">{file.oursLabel} (current)</span>
              <span className="truncate pl-2 text-primary">{file.theirsLabel} (incoming)</span>
            </div>
            <div className="min-h-0 flex-1">
              <MonacoDiff
                original={file.ours}
                modified={file.theirs}
                language={language}
                theme={props.monacoTheme}
                options={COMPARE_OPTIONS}
              />
            </div>
          </div>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl ring-1 ring-white/5">
          <Editor
            path={modelPath}
            value={content}
            language={language}
            theme={props.monacoTheme}
            options={editorOptions}
            onChange={onChange}
            onMount={onMount}
          />
          {aiBusy && (
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center gap-1.5 bg-primary/10 py-1 text-[11px] text-primary backdrop-blur-sm">
              <Loader2 className="h-3 w-3 animate-spin" />
              AI is resolving this file — the editor is read-only until it finishes
            </div>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground/60">
          Click a lens above a conflict to accept a side · Alt+↑/↓ jump between conflicts ·
          Ctrl+S saves · edits autosave to the working tree
        </p>
      </div>
    </div>
  );
}

function SideChip({ tone, label }: { tone: "ours" | "theirs"; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[14rem] items-center gap-1 truncate rounded-md px-1.5 py-px font-mono",
        tone === "ours" ? "bg-cyan/15 text-cyan" : "bg-primary/15 text-primary"
      )}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{label}</span>
    </span>
  );
}

function ChoiceButton(props: {
  tone: "ours" | "theirs" | "both";
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={props.hint}>
      <button
        onClick={props.onClick}
        disabled={props.disabled}
        className={cn(
          "h-6 rounded-md px-2 text-[11px] font-medium ring-1 transition-colors disabled:opacity-40",
          props.tone === "ours" &&
            "bg-cyan/10 text-cyan ring-cyan/30 hover:bg-cyan/20",
          props.tone === "theirs" &&
            "bg-primary/10 text-primary ring-primary/30 hover:bg-primary/20",
          props.tone === "both" &&
            "bg-secondary/60 text-foreground ring-white/10 hover:bg-secondary"
        )}
      >
        {props.label}
      </button>
    </Tooltip>
  );
}
