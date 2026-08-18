import { Database, Loader2, ScanSearch, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { useRagInspectorViewModel } from "@/hooks/useRagInspectorViewModel";

export interface RagInspectorPaneProps {
  vm: ReturnType<typeof useRagInspectorViewModel>;
}

/**
 * RAG Inspector: run a retrieval against the knowledge engine and see the
 * scored chunks, matched symbols, and strategy exactly as the agent does.
 */
export function RagInspectorPane({ vm }: RagInspectorPaneProps) {
  return (
    <div className="flex h-full flex-col bg-card">
      <div className="border-b border-border-subtle px-3 py-3">
        <div className="mb-3 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ScanSearch className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">RAG inspector</p>
            <p className="text-[11px] text-muted-foreground">
              Current workspace index
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={vm.query}
            onChange={(e) => vm.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void vm.run();
            }}
            placeholder='Ask the index, e.g. "where are git commits handled?"'
            className="h-8 rounded-lg text-xs"
            disabled={!vm.connected}
          />
          <Button
            size="sm"
            className="h-8 gap-1.5 rounded-lg px-3"
            disabled={!vm.connected || vm.loading || !vm.query.trim()}
            onClick={() => void vm.run()}
          >
            {vm.loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Retrieve
          </Button>
        </div>
      </div>

      {vm.retrieval === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Database className="h-6 w-6 text-muted-foreground/50" />
          <p className="max-w-64 text-center text-xs text-muted-foreground">
            No retrieval loaded.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <div className="rounded-lg border border-border-subtle bg-muted/25 p-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-muted-foreground">
                Strategy
              </span>
              <Badge variant="secondary" className="text-[10px]">
                {vm.retrieval.strategy}
              </Badge>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {vm.retrieval.graphNodes.map((node) => (
                <Badge
                  key={node.id}
                  variant="outline"
                  className="font-mono text-[10px]"
                  title={node.path}
                >
                  {node.label} · {node.kind}
                </Badge>
              ))}
            </div>
          </div>

          {vm.retrieval.chunks.length === 0 ? (
            <p className="rounded-lg border border-border-subtle px-3 py-6 text-center text-xs text-muted-foreground">
              No chunks matched. Is the workspace indexed?
            </p>
          ) : (
            vm.retrieval.chunks.map((chunk) => (
              <button
                key={chunk.id}
                onClick={() => vm.openChunk(chunk.path)}
                className="block w-full rounded-lg border border-border-subtle bg-card p-2.5 text-left shadow-sm transition-colors hover:bg-muted/45"
              >
                <div className="flex items-center gap-2">
                  {chunk.kind === "lesson" ? (
                    <span className="shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning dark:text-warning">
                      lesson
                    </span>
                  ) : (
                    <span className="truncate font-mono text-[11px] font-medium">
                      {chunk.path}
                      {chunk.startRow !== undefined &&
                        `:${chunk.startRow + 1}-${(chunk.endRow ?? chunk.startRow) + 1}`}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-primary">
                    {chunk.score.toFixed(3)}
                  </span>
                </div>
                <pre className="mt-1.5 max-h-32 overflow-hidden whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-muted-foreground">
                  {chunk.preview}
                </pre>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
