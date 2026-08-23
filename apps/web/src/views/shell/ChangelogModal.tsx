import { Sparkles, X } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

export interface ChangelogModalProps {
  entry: { version: string; notes: string | null; url: string | null } | null;
  onClose: () => void;
}

/**
 * What changed, shown once after an upgrade.
 *
 * The notes are the release's own body — the text written for the release
 * rather than a second description maintained in the app, which would drift
 * from it immediately. Closing acknowledges the version, so this never
 * appears twice for the same build.
 */
export function ChangelogModal({ entry, onClose }: ChangelogModalProps) {
  if (!entry) return null;

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/40 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`What's new in ${entry.version}`}
      onClick={onClose}
    >
      <div
        className={cn(
          "flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden",
          "rounded-2xl border border-border-subtle bg-card shadow-pop"
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border-subtle px-5 py-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
            <Sparkles className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold leading-tight">
              Atelier updated to {entry.version}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              Here is what changed in this version
            </span>
          </span>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close"
            onClick={onClose}
            className="h-8 w-8 shrink-0 rounded-lg"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {entry.notes ? (
            <div className="chat-md text-sm">
              <Markdown remarkPlugins={[remarkGfm]}>{entry.notes}</Markdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              This release published no notes.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-3">
          {entry.url && (
            <a
              href={entry.url}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              View the release on GitHub
            </a>
          )}
          <Button size="sm" className="ml-auto" onClick={onClose}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
