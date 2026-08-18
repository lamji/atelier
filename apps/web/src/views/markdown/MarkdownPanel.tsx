import { useState } from "react";
import {
  BookOpen,
  FileDown,
  FilePlus2,
  FolderOpen,
  Loader2,
  Plus,
} from "lucide-react";
import type { MarkdownStatus } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { exportMarkdownToPdf } from "@/lib/markdown-pdf";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { WorkspacePageBody } from "@/components/ui/workspace-page";
import { cn } from "@/lib/cn";
import { toMarkdownPath } from "@/hooks/useMarkdownViewModel";
import type { useMarkdownViewModel } from "@/hooks/useMarkdownViewModel";

const STATUS_OPTIONS = [
  { value: "todo", label: "Todo" },
  { value: "in-progress", label: "In progress" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
];

/** Accent spine colour per status — the card's left edge. */
const STATUS_SPINE: Record<MarkdownStatus, string> = {
  todo: "bg-muted-foreground/30",
  "in-progress": "bg-cyan",
  review: "bg-warning",
  done: "bg-success",
};

/** Status dot colour — the eye-catcher in each card header. */
const STATUS_DOT: Record<MarkdownStatus, string> = {
  todo: "bg-muted-foreground/50",
  "in-progress": "bg-cyan",
  review: "bg-warning",
  done: "bg-success",
};

/** Status label tint for the footer pill. */
const STATUS_PILL: Record<MarkdownStatus, string> = {
  todo: "bg-muted-foreground/10 text-muted-foreground",
  "in-progress": "bg-cyan/12 text-cyan",
  review: "bg-warning/12 text-warning",
  done: "bg-success/12 text-success",
};

/**
 * `.atelier/roadmap.md` → `roadmap.md` for the card's file chip. Nested
 * notes (`notes/my-idea.md`) keep their folder context.
 */
function displayName(path: string): string {
  return path.replace(/^\.atelier\/?/, "") || path;
}

/** Coarse "edited 3h ago" — the catalog is browsed, not audited. */
function editedLabel(mtime: number): string {
  const mins = Math.floor((Date.now() - mtime) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(mtime).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export interface MarkdownPanelProps {
  vm: ReturnType<typeof useMarkdownViewModel>;
  onOpenFile: (path: string) => void;
  compact?: boolean;
}

/**
 * Workspace markdown catalog: a stack of note cards inside a rounded
 * explorer surface. Each card is a vertical layout with a coloured status
 * spine, a rich header area, and a footer strip for metadata + actions.
 * The card doubles as a prompt template for the composer dropdown.
 */
export function MarkdownPanel({
  vm,
  onOpenFile,
  compact = false,
}: MarkdownPanelProps) {
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const submit = async () => {
    const created = await vm.create();
    if (created) onOpenFile(created);
  };

  const exportPdf = async (path: string, title: string) => {
    setExporting(path);
    setExportError(null);
    try {
      const file = await bridge.rpc("fs.readFile", { path });
      await exportMarkdownToPdf(file.content, title || path);
    } catch (e) {
      setExportError(String((e as { message?: string })?.message ?? e));
    } finally {
      setExporting(null);
    }
  };

  const count = vm.files.length;

  return (
    <div className="flex h-full flex-col">
      {/* ── Compact rail header ── */}
      {compact && (
        <div className="flex items-center gap-2.5 border-b border-border/60 px-3 py-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
            <BookOpen className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight">
              Markdown files
            </span>
            <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
              .atelier/ · {count}
            </span>
          </span>
          <Button
            size="icon"
            variant="outline"
            className="ml-auto h-7 w-7 shrink-0 rounded-full"
            title="New note"
            disabled={!vm.connected}
            onClick={() => vm.setCreating(!vm.creating)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <WorkspacePageBody
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          compact ? "p-3" : "p-5"
        )}
      >
        {/* ── Full-size page header ── */}
        {!compact && (
          <div className="mb-5 flex items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
              <BookOpen className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold leading-tight">
                Notes
              </span>
              <span className="block truncate font-mono text-[10px] text-muted-foreground/60">
                .atelier/ · {count}
              </span>
            </span>
            <Button
              size="icon"
              variant="outline"
              className="ml-auto h-8 w-8 shrink-0 rounded-lg"
              title="New note"
              disabled={!vm.connected}
              onClick={() => vm.setCreating(!vm.creating)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {/* ── Create-note form ── */}
        {vm.creating && (
          <div
            className={cn(
              "mb-4 grid gap-3 rounded-2xl bg-primary/8 p-4 shadow-sm",
              !compact && "md:grid-cols-[1fr_auto]"
            )}
          >
            <Input
              value={vm.draftName}
              onChange={(e) => vm.setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder="Name (saved under .atelier/)"
              className="h-10 text-sm"
              autoFocus
            />
            <Button
              size="sm"
              className="h-10 px-5"
              disabled={!toMarkdownPath(vm.draftName) || vm.saving}
              onClick={() => void submit()}
            >
              {vm.saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Create file"
              )}
            </Button>
          </div>
        )}

        {exportError && (
          <p className="mb-3 rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
            {exportError}
          </p>
        )}

        {/* ── Explorer surface ── */}
        <div
          className={cn(
            "flex min-h-0 flex-col overflow-hidden rounded-[20px] p-1.5 shadow-sm",
            "border border-border/40 bg-gradient-to-b from-muted/40 to-muted/15"
          )}
        >
          {/* Root folder row */}
          <div className="flex items-center gap-2 rounded-xl px-3 py-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
              <FolderOpen className="h-3.5 w-3.5" />
            </span>
            <span className="font-mono text-xs font-semibold text-foreground/80">
              .atelier/
            </span>
            <span className="shrink-0 rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              {count} note{count === 1 ? "" : "s"}
            </span>
            {count > 0 && (
              <>
                <span className="ml-auto h-px flex-1 bg-border/30" />
                <span className="shrink-0 text-[10px] text-muted-foreground/50">
                  {editedLabel(Math.max(...vm.files.map((f) => f.mtime), 0))} edited
                </span>
              </>
            )}
          </div>

          <div className="mx-2 h-px bg-border/30" />

          {/* ── Empty state ── */}
          {count === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
              <span className="relative grid h-12 w-12 place-items-center rounded-2xl bg-muted/50 text-muted-foreground/40">
                <FilePlus2 className="h-5 w-5" />
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary/30" />
              </span>
              <div className="max-w-[200px]">
                <p className="text-xs font-medium text-foreground/60">
                  No notes yet
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/50">
                  Files live in{" "}
                  <span className="font-mono text-muted-foreground/70">
                    .atelier/
                  </span>{" "}
                  and double as reusable prompts in the chat composer.
                </p>
              </div>
            </div>
          ) : (
            /* ── Note card stack ── */
            <div className="flex min-h-0 flex-col gap-2 py-2 px-1.5">
              {vm.files.map((file) => (
                <NoteCard
                  key={file.path}
                  file={file}
                  compact={compact}
                  exporting={exporting === file.path}
                  onOpen={() => onOpenFile(file.path)}
                  onExport={() => void exportPdf(file.path, file.title)}
                  onStatus={(s) => vm.setStatus(file.path, s as MarkdownStatus)}
                />
              ))}
            </div>
          )}
        </div>
      </WorkspacePageBody>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * NoteCard — a tall, layered card with status spine, header, blurb, and
 * a footer metadata strip. Designed for vertical stacking, no horizontal
 * overflow: the status Select and PDF action live in the footer, not the
 * title row.
 * ═══════════════════════════════════════════════════════════════════════════ */
function NoteCard({
  file,
  compact,
  exporting,
  onOpen,
  onExport,
  onStatus,
}: {
  file: ReturnType<typeof useMarkdownViewModel>["files"][number];
  compact: boolean;
  exporting: boolean;
  onOpen: () => void;
  onExport: () => void;
  onStatus: (s: string) => void;
}) {
  const name = displayName(file.path);

  return (
    <div
      className={cn(
        "group relative flex overflow-hidden rounded-xl transition-all duration-150",
        "border border-border/30 bg-card hover:border-border/60 hover:bg-accent/20",
        "shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)]"
      )}
    >
      {/* Left status spine */}
      <div className={cn("w-[3px] shrink-0 transition-colors", STATUS_SPINE[file.status])} />

      {/* Card body */}
      <div className="min-w-0 flex-1">
        {/* Header row: status dot + title */}
        <button
          type="button"
          className="flex w-full items-start gap-2 px-3 pt-2.5 pb-1 text-left"
          title={file.path}
          onClick={onOpen}
        >
          <span className={cn(
            "mt-1 h-2 w-2 shrink-0 rounded-full ring-2 ring-card",
            STATUS_DOT[file.status]
          )} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-snug tracking-tight">
              {file.title}
            </span>
          </span>
        </button>

        {/* Blurb + file chip */}
        <div className="px-3 pl-7">
          {file.description && (
            <p
              className={cn(
                "text-[11px] leading-relaxed text-muted-foreground/65",
                compact ? "line-clamp-1" : "line-clamp-2"
              )}
            >
              {file.description}
            </p>
          )}
          <span className="mt-1 inline-flex items-center gap-1 rounded-[4px] border border-border/40 bg-muted/30 px-1.5 py-0.5 font-mono text-[9px] tracking-tight text-muted-foreground/55">
            <span className="text-[8px] font-bold text-violet-400/80">MD</span>
            {name}
          </span>
        </div>

        {/* Footer metadata strip */}
        <div className="flex items-center gap-2 px-3 pt-2 pb-2 pl-7">
          <span className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium leading-none",
            STATUS_PILL[file.status]
          )}>
            {STATUS_OPTIONS.find((o) => o.value === file.status)?.label ?? file.status}
          </span>
          <span className="text-[9px] text-muted-foreground/40">·</span>
          <span className="shrink-0 text-[9px] text-muted-foreground/50">
            {editedLabel(file.mtime)}
          </span>

          <span className="ml-auto flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              title="Export as PDF"
              disabled={exporting}
              onClick={onExport}
              className="!h-5 !w-5 shrink-0 rounded-md text-muted-foreground/40 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
            >
              {exporting ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <FileDown className="h-2.5 w-2.5" />
              )}
            </Button>
            <Select
              value={file.status}
              onChange={onStatus}
              options={STATUS_OPTIONS}
              className={cn(
                "!h-5 rounded-md px-1.5 text-[9px] font-medium opacity-0 transition-opacity group-hover:opacity-100",
                STATUS_PILL[file.status]
              )}
              menuClassName="w-28"
            />
          </span>
        </div>
      </div>
    </div>
  );
}