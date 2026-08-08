import { useState } from "react";
import { BookOpen, FileDown, Loader2, Plus } from "lucide-react";
import type { MarkdownStatus } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";
import { exportMarkdownToPdf } from "@/lib/markdown-pdf";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { toMarkdownPath } from "@/hooks/useMarkdownViewModel";
import type { useMarkdownViewModel } from "@/hooks/useMarkdownViewModel";

const STATUS_OPTIONS = [
  { value: "todo", label: "Todo" },
  { value: "in-progress", label: "In progress" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
];

/** Badge tint per status; /15 backgrounds hold up in both themes. */
const STATUS_BADGE: Record<MarkdownStatus, string> = {
  todo: "bg-muted-foreground/15 text-muted-foreground",
  "in-progress": "bg-cyan/15 text-cyan",
  review: "bg-warning/15 text-warning",
  done: "bg-success/15 text-success",
};

export interface MarkdownPanelProps {
  vm: ReturnType<typeof useMarkdownViewModel>;
  onOpenFile: (path: string) => void;
}

/**
 * Workspace markdown catalog: every .md file as title + one-line blurb,
 * plus a small creation form. Files double as prompt templates for the
 * composer's prompt-file dropdown.
 */
export function MarkdownPanel({ vm, onOpenFile }: MarkdownPanelProps) {
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const submit = async () => {
    const created = await vm.create();
    if (created) onOpenFile(created);
  };

  /**
   * Exports the file as a PDF. The content is read at click time rather
   * than held in the list: the catalog carries titles and blurbs, and the
   * body may have changed in the editor since it was listed.
   */
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

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center gap-2">
        <BookOpen className="h-4 w-4 text-primary/80" />
        <h2 className="text-sm font-semibold">Markdown</h2>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 gap-1 px-2"
          disabled={!vm.connected}
          onClick={() => vm.setCreating(!vm.creating)}
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      {vm.creating && (
        <div className="space-y-2 rounded-xl bg-muted/40 p-2.5">
          <Input
            value={vm.draftName}
            onChange={(e) => vm.setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder="Name (saved under .atelier/)"
            className="h-8 text-xs"
            autoFocus
          />
          <Button
            size="sm"
            className="h-8 w-full"
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
        <p className="rounded-lg bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          {exportError}
        </p>
      )}

      <div className="min-h-0 flex-1">
        {vm.files.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">
            No markdown files yet. Files are saved under{" "}
            <span className="font-mono">.atelier/</span> and double as
            reusable prompts in the chat composer.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {vm.files.map((file) => (
              <li key={file.path} className="rounded-lg bg-muted/40 px-2.5 py-2">
                <div className="flex items-start gap-2">
                  <button
                    className="block min-w-0 flex-1 text-left"
                    title={file.path}
                    onClick={() => onOpenFile(file.path)}
                  >
                    <span className="block truncate text-[12px] font-medium">
                      {file.title}
                    </span>
                    {file.description && (
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/70">
                        {file.description}
                      </span>
                    )}
                    <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/60">
                      {file.path}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Export as PDF"
                    disabled={!vm.connected || exporting === file.path}
                    onClick={() => void exportPdf(file.path, file.title)}
                    className="!h-5 !w-5 shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    {exporting === file.path ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <FileDown className="h-3 w-3" />
                    )}
                  </Button>
                  <Select
                    value={file.status}
                    onChange={(v) =>
                      vm.setStatus(file.path, v as MarkdownStatus)
                    }
                    options={STATUS_OPTIONS}
                    className={cn(
                      "h-5 shrink-0 rounded-full px-2 text-[10px] font-medium",
                      STATUS_BADGE[file.status]
                    )}
                    menuClassName="w-28"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
