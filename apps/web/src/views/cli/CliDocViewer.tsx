import { useEffect, useMemo, useState } from "react";
import { BookOpen, Loader2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { bridge } from "@/services/bridge-client";
import { useCliConsoleStore } from "@/services/cli-console";
import { useThemeStore } from "@/state/theme.store";
import { FilePane } from "@/views/right/RightDock";
import {
  docsForSession,
  refreshCliDocs,
  sessionKeys,
  useCliDocsStore,
} from "@/services/cli-docs";

/**
 * The documentation a session wrote with `/document` or `$document`, laid
 * over the main view.
 *
 * A report is a markdown file in the workspace, so it is shown by the same
 * file pane every other `.md` opens in — preview first, source one click
 * away — rather than by a second renderer of its own.
 *
 * An overlay rather than a replacement for the pane underneath: the terminal
 * stays mounted and running, so closing this lands back in the session
 * exactly as it was left.
 */
export function CliDocViewer(props: { conversationId: string }) {
  const { conversationId } = props;
  const docs = useCliDocsStore((s) => s.docs);
  const close = useCliDocsStore((s) => s.close);
  const binding = useCliConsoleStore((s) => s.chats[conversationId]);
  const resumed = useCliConsoleStore((s) => s.resumed);
  const mine = useMemo(
    () => docsForSession(docs, sessionKeys(conversationId, binding, resumed)),
    [docs, conversationId, binding, resumed]
  );
  const [pickedId, setPickedId] = useState<string | null>(null);
  const selected = mine.find((doc) => doc.id === pickedId) ?? mine[0] ?? null;
  const selectedPath = selected?.path ?? null;
  const selectedId = selected?.id ?? null;
  const selectedWrittenAt = selected?.createdAt ?? null;
  const dark = useThemeStore((s) => s.theme === "dark");
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The list may be older than the report the user came here to read.
  useEffect(() => {
    void refreshCliDocs();
  }, [conversationId]);

  // A different report starts from nothing; the same one rewritten keeps
  // showing what it said until the new text has arrived.
  useEffect(() => {
    setBody(null);
  }, [selectedPath]);

  // Re-read when the report is written again: the session that wrote it
  // keeps it up to date, so the copy on screen would otherwise go stale.
  useEffect(() => {
    if (!selectedPath) return;
    let cancelled = false;
    setError(null);
    bridge
      .rpc("fs.readFile", { path: selectedPath })
      .then(({ content }) => {
        if (!cancelled) setBody(content);
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPath, selectedWrittenAt]);

  // Escape goes back, like every other surface laid over the main view.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-panel dark:bg-editor">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {selected?.title ?? "Documentation"}
        </span>
        {selected && (
          <span
            className="hidden shrink-0 truncate text-[11px] text-muted-foreground md:block"
            title={selected.path}
          >
            {selected.id}
          </span>
        )}
        <button
          type="button"
          title="Back to session (Esc)"
          aria-label="Close documentation"
          onClick={close}
          className="tool-btn"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        {mine.length > 1 && (
          <nav
            aria-label="Documentation from this session"
            className="w-56 shrink-0 space-y-0.5 overflow-y-auto border-r border-border p-2"
          >
            {mine.map((doc) => (
              <button
                key={doc.id}
                type="button"
                onClick={() => setPickedId(doc.id)}
                aria-current={doc.id === selectedId}
                title={doc.path}
                className={cn(
                  "block w-full rounded-lg px-2 py-1.5 text-left text-xs",
                  doc.id === selectedId
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50"
                )}
              >
                <span className="block truncate">{doc.title}</span>
                <span className="block truncate text-[11px] opacity-70">
                  {new Date(doc.createdAt).toLocaleString()}
                </span>
              </button>
            ))}
          </nav>
        )}
        <div className="min-w-0 flex-1">
          {!selected ? (
            <p className="px-6 py-4 text-sm text-muted-foreground">
              This session has no documentation yet. Run /document in Claude
              or $document in Codex to write some.
            </p>
          ) : error ? (
            <p className="m-4 rounded-lg bg-destructive/10 px-2 py-1 text-xs text-destructive">
              {error}
            </p>
          ) : body === null ? (
            <p className="flex items-center gap-2 px-6 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading {selected.path}…
            </p>
          ) : (
            <FilePane
              key={selected.path}
              selectedPath={selected.path}
              fileContent={body}
              language="markdown"
              monacoTheme={dark ? "atelier-dark" : "atelier-light"}
              initialView="preview"
            />
          )}
        </div>
      </div>
    </div>
  );
}
