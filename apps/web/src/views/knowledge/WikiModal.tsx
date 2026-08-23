import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BookOpen,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import type { WikiLintFinding, WikiPageInfo } from "@atelier/protocol";
import { cn } from "@/lib/cn";
import { bridge } from "@/services/bridge-client";
import { Button } from "@/components/ui/button";

export interface WikiModalProps {
  open: boolean;
  pages: WikiPageInfo[];
  lint: WikiLintFinding[];
  onClose: () => void;
  /** Opens the page's markdown in the editor tab. */
  onOpenInEditor: (path: string) => void;
  /** Re-reads the wiki from disk; resolves when the list is fresh. */
  onResync: () => Promise<void>;
}

/**
 * What is actually in the feature wiki.
 *
 * The panel's card lists eight titles and the freshness badge, which
 * answers "is the wiki healthy" but never "what does it say" — and the
 * only way to read a page was to open its markdown in the editor, one
 * file at a time. This is the whole shelf: every page on the left, the
 * one you picked rendered on the right, with its lint attached.
 */
export function WikiModal(props: WikiModalProps) {
  const { open, pages, lint, onClose, onOpenInEditor, onResync } = props;
  const [query, setQuery] = useState("");
  const [slug, setSlug] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter((page) =>
      [page.title, page.slug, ...page.aliases]
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [pages, query]);

  // Land on something readable: the first page, and never on a slug that
  // the filter (or a resync) has just taken off the list.
  const selected =
    shown.find((page) => page.slug === slug) ?? shown[0] ?? null;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSlug(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  // The page bodies are not in the list payload — the panel only needs
  // titles and freshness — so the selected one is read on demand.
  useEffect(() => {
    if (!open || !selected) {
      setBody(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void bridge
      .rpc("fs.readFile", { path: selected.path })
      .then((file) => {
        if (!cancelled) setBody(stripFrontmatter(file.content));
      })
      .catch(() => {
        if (!cancelled) setError(`Could not read ${selected.path}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selected?.path, selected]);

  const resync = () => {
    setSyncing(true);
    void onResync().finally(() => setSyncing(false));
  };

  const findings = selected
    ? lint.filter((finding) => finding.slug === selected.slug)
    : [];

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Feature wiki"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className={cn(
              "modal-surface island flex h-[85vh] w-full max-w-5xl",
              "flex-col overflow-hidden"
            )}
          >
            {/* Header */}
            <div className="flex shrink-0 items-center gap-3 border-b border-white/5 px-4 py-3">
              <span
                className={cn(
                  "flex h-6 w-6 shrink-0 items-center justify-center",
                  "rounded-lg bg-primary/15 text-primary"
                )}
              >
                <BookOpen className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Feature wiki</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {pages.length} page{pages.length === 1 ? "" : "s"}
                  {lint.length > 0 && ` · ${lint.length} lint finding${lint.length === 1 ? "" : "s"}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 gap-1.5 px-2.5 text-xs"
                disabled={syncing}
                onClick={resync}
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Resync
              </Button>
              <button
                onClick={onClose}
                aria-label="Close"
                className={cn(
                  "shrink-0 rounded-lg p-1.5 text-muted-foreground",
                  "hover:bg-accent/60 hover:text-foreground"
                )}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex min-h-0 flex-1">
              {/* Page list */}
              <div className="flex w-64 shrink-0 flex-col border-r border-white/5">
                <div className="relative shrink-0 border-b border-white/5">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/50" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter pages…"
                    spellCheck={false}
                    className="h-9 w-full bg-transparent pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground/50"
                  />
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                  {shown.length === 0 ? (
                    <p className="px-2 py-3 text-[11px] text-muted-foreground/70">
                      {pages.length === 0
                        ? "No pages yet — a change task compiles the first one."
                        : "No page matches."}
                    </p>
                  ) : (
                    shown.map((page) => {
                      const active = page.slug === selected?.slug;
                      const pageLint = lint.filter((f) => f.slug === page.slug);
                      return (
                        <button
                          key={page.slug}
                          onClick={() => setSlug(page.slug)}
                          className={cn(
                            "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
                            active ? "bg-primary/10" : "hover:bg-accent/60"
                          )}
                        >
                          <span className="flex items-center gap-1.5">
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                              {page.title}
                            </span>
                            <StatusDot status={page.status} />
                          </span>
                          <span className="truncate font-mono text-[10px] text-muted-foreground/60">
                            {page.sources} source{page.sources === 1 ? "" : "s"}
                            {pageLint.length > 0 && ` · ${pageLint.length} lint`}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Page body */}
              <div className="flex min-w-0 flex-1 flex-col">
                {selected ? (
                  <>
                    <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-4 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">
                          {selected.title}
                        </span>
                        <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
                          {selected.path}
                          {selected.aliases.length > 0 &&
                            ` · aka ${selected.aliases.join(", ")}`}
                        </span>
                      </span>
                      <StatusDot status={selected.status} withLabel />
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1.5 px-2 text-[11px]"
                        onClick={() => {
                          onOpenInEditor(selected.path);
                          onClose();
                        }}
                      >
                        <ExternalLink className="h-3 w-3" />
                        Edit
                      </Button>
                    </div>

                    {findings.length > 0 && (
                      <div className="shrink-0 space-y-1 px-4 pt-3">
                        {findings.map((finding, i) => (
                          <p
                            key={`${finding.kind}-${i}`}
                            className="flex items-start gap-1.5 rounded-lg bg-warning/10 px-2 py-1 text-[11px] text-warning"
                          >
                            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                            <span className="min-w-0">
                              <b className="font-medium">{finding.kind}</b> —{" "}
                              {finding.detail}
                            </span>
                          </p>
                        ))}
                      </div>
                    )}

                    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                      {loading ? (
                        <p className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Reading {selected.path}…
                        </p>
                      ) : error ? (
                        <p className="rounded-lg bg-destructive/10 px-2 py-1 text-xs text-destructive">
                          {error}
                        </p>
                      ) : (
                        <div className="chat-md text-xs leading-relaxed">
                          <Markdown remarkPlugins={[remarkGfm]}>
                            {body ?? ""}
                          </Markdown>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
                    The wiki is empty. Pages are compiled from what a change
                    task learned, so the first one arrives with the first task.
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}

/**
 * The page's own frontmatter is metadata the list already shows (status,
 * sources, links); leaving it in the rendered body would put a wall of
 * `key: value` above every page.
 */
function stripFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

function StatusDot({
  status,
  withLabel,
}: {
  status: string;
  withLabel?: boolean;
}) {
  const tone =
    status === "fresh"
      ? "bg-success/15 text-success"
      : status === "stale"
        ? "bg-warning/15 text-warning"
        : "bg-muted text-muted-foreground";
  if (!withLabel) {
    return (
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          status === "fresh"
            ? "bg-success"
            : status === "stale"
              ? "bg-warning"
              : "bg-muted-foreground/50"
        )}
        title={status}
      />
    );
  }
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold", tone)}>
      {status}
    </span>
  );
}
