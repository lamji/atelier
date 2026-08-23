import { useState, type ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Braces,
  Clock3,
  Database,
  FileCode2,
  GraduationCap,
  Layers3,
  Loader2,
  Network,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { WorkspacePageBody } from "@/components/ui/workspace-page";
import { cn } from "@/lib/cn";
import type { useKnowledgeViewModel } from "@/hooks/useKnowledgeViewModel";
import { WikiModal } from "./WikiModal";

export interface KnowledgePanelProps {
  vm: ReturnType<typeof useKnowledgeViewModel>;
  onOpenRag: () => void;
}

/**
 * Left-column Knowledge view: live index stats, indexing progress, the
 * re-index action, recent knowledge updates, and shortcuts into the Graph
 * and RAG Inspector panes.
 */
export function KnowledgePanel({ vm, onOpenRag }: KnowledgePanelProps) {
  const [reindexing, setReindexing] = useState(false);
  const [wikiSyncing, setWikiSyncing] = useState(false);
  const [wikiOpen, setWikiOpen] = useState(false);
  const { stats, indexing } = vm;
  const indexPct =
    indexing && indexing.total > 0
      ? Math.min(100, Math.round((indexing.done / indexing.total) * 100))
      : 0;
  const featureCount = Math.max(vm.features.length, stats?.features ?? 0);
  const lastIndexed =
    stats?.lastIndexedAt != null
      ? new Date(stats.lastIndexedAt).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "Never";

  const resyncWiki = () => {
    setWikiSyncing(true);
    void vm.refreshWiki().finally(() => setWikiSyncing(false));
  };

  const runReindex = async (force: boolean) => {
    setReindexing(true);
    try {
      await vm.reindex(force);
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Two independent scroll areas once there is room for two columns:
          the left column holds the controls for everything on the right —
          index state, graph/inspector/scan links, force re-index — and
          scrolling them away with the stats put them out of reach exactly
          when a long right-hand column made them wanted. Below xl the
          grid collapses to one column and scrolls as one page again. */}
      <WorkspacePageBody className="min-h-0 flex-1 overflow-y-auto p-5 xl:overflow-hidden">
        <div
          className={cn(
            "grid min-h-full gap-4",
            "xl:h-full xl:min-h-0 xl:grid-cols-[260px_minmax(0,1fr)]"
          )}
        >
          <aside className="space-y-3 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
            <section className="rounded-lg border border-border-subtle bg-card p-3 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-semibold">Index state</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {vm.connected ? "Connected" : "Waiting for workspace"}
                  </p>
                </div>
                <span
                  className={cn(
                    "h-2.5 w-2.5 rounded-full",
                    vm.connected ? "bg-success" : "bg-muted-foreground/40"
                  )}
                  aria-hidden
                />
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <MiniMetric label="Last sync" value={lastIndexed} />
                <MiniMetric label="Features" value={featureCount} />
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-border-subtle bg-card shadow-sm">
              <PanelLink
                icon={Network}
                label="Code graph"
                detail="Workspace, file, symbol"
                disabled={!vm.connected}
                onClick={() => vm.openGraph("workspace")}
              />
              <PanelLink
                icon={ScanSearch}
                label="RAG inspector"
                detail="Query retrieved chunks"
                disabled={!vm.connected}
                onClick={onOpenRag}
              />
              <PanelLink
                icon={Sparkles}
                label={
                  vm.featureScan
                    ? vm.featureScan.phase === "discover"
                      ? "Discovering routes"
                      : `Scanning ${vm.featureScan.done}/${vm.featureScan.total}`
                    : "Feature scan"
                }
                detail="Route and endpoint summaries"
                disabled={!vm.connected || vm.featureScan !== null}
                busy={vm.featureScan !== null}
                onClick={() => void vm.scanFeatures()}
              />
            </section>

            <button
              onClick={() => void runReindex(true)}
              disabled={!vm.connected || reindexing}
              className={cn(
                "flex w-full items-center justify-between rounded-lg border border-border-subtle bg-card px-3 py-2.5 text-left",
                "text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              )}
            >
              Force full re-index
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </aside>

          <main className="min-w-0 space-y-4 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
            <section className="rounded-lg border border-border-subtle bg-card shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Activity className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">Live knowledge sync</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {indexing?.currentPath ?? "No active indexing job"}
                    </p>
                  </div>
                </div>
                <span className="rounded-md bg-muted px-2 py-1 text-[11px] font-medium tabular-nums text-muted-foreground">
                  {indexing && indexing.total > 0
                    ? `${indexing.done}/${indexing.total}`
                    : "Idle"}
                </span>
                <Tooltip content="Scan for drift and index changed files">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 rounded-lg px-3"
                    disabled={!vm.connected || reindexing}
                    onClick={() => void runReindex(false)}
                  >
                    {reindexing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Sync
                  </Button>
                </Tooltip>
              </div>
              <div className="px-4 py-3">
                <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-medium capitalize text-foreground/80">
                    {indexing
                      ? indexing.phase === "embed"
                        ? "Embedding"
                        : indexing.phase
                      : "Ready"}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {indexing ? `${indexPct}%` : "Current"}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full bg-primary transition-all",
                      indexing == null && "opacity-40"
                    )}
                    style={{ width: indexing ? `${indexPct}%` : "100%" }}
                  />
                </div>
              </div>
            </section>

            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Stat icon={FileCode2} label="Files" value={stats?.files} />
              <Stat icon={Braces} label="Symbols" value={stats?.symbols} />
              <Stat icon={Workflow} label="Call edges" value={stats?.edges} />
              <Stat icon={ScanSearch} label="Chunks" value={stats?.chunks} />
              <Stat icon={Sparkles} label="Embedded" value={stats?.embedded} />
              <Stat
                icon={Network}
                label="Features"
                value={featureCount}
                busy={vm.featureScan !== null}
              />
              <Stat icon={GraduationCap} label="Lessons" value={stats?.lessons} />
              <Stat
                icon={Clock3}
                label="Updates"
                value={vm.recentUpdates.length}
              />
            </section>

            <div className="grid gap-4 2xl:grid-cols-2">
              <KnowledgeList
                icon={Layers3}
                title="Features"
                meta={
                  vm.featureScan && vm.featureScan.total > 0
                    ? `${vm.featureScan.done}/${vm.featureScan.total}`
                    : `${featureCount}`
                }
                empty="No feature summaries yet."
                emptyWhen={vm.features.length === 0 && vm.featureScan == null}
              >
                {vm.features.slice(0, 8).map((feature) => (
                  <Tooltip key={feature.id} content={feature.summary}>
                    <li className="rounded-md px-2.5 py-2 transition-colors hover:bg-muted/60">
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                          {feature.name}
                        </span>
                        <StatusBadge status={feature.status} />
                      </div>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        {feature.summary}
                      </p>
                    </li>
                  </Tooltip>
                ))}
              </KnowledgeList>

              <KnowledgeList
                icon={BookOpen}
                title="Feature wiki"
                meta={
                  vm.wikiLint.length > 0
                    ? `${vm.wikiPages.length} · ${vm.wikiLint.length} lint`
                    : `${vm.wikiPages.length}`
                }
                onTitleClick={() => setWikiOpen(true)}
                titleHint="Browse the wiki — read any page here"
                action={
                  <Tooltip content="Re-read the wiki from disk and re-run its lint">
                    <button
                      onClick={resyncWiki}
                      disabled={!vm.connected || wikiSyncing}
                      aria-label="Resync the feature wiki"
                      className={cn(
                        "rounded-md p-1 text-muted-foreground transition-colors",
                        "hover:bg-accent/60 hover:text-foreground disabled:opacity-40"
                      )}
                    >
                      {wikiSyncing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </Tooltip>
                }
                empty="No feature pages yet — a change task compiles the first one."
                emptyWhen={vm.wikiPages.length === 0}
              >
                {vm.wikiPages.slice(0, 8).map((page) => {
                  const findings = vm.wikiLint.filter((f) => f.slug === page.slug);
                  return (
                    <Tooltip key={page.slug} content={page.path}>
                      <li
                        className="cursor-pointer rounded-md px-2.5 py-2 transition-colors hover:bg-muted/60"
                        onClick={() => void vm.openWikiPage(page.path)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
                            {page.title}
                          </span>
                          <StatusBadge status={page.status} />
                        </div>
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                          {page.sources} source(s)
                          {page.moved.length > 0 && ` · ${page.moved.length} moved`}
                          {page.links.length > 0 &&
                            ` · ${page.links.map((l) => `[[${l}]]`).join(" ")}`}
                          {findings.length > 0 && ` · ${findings.length} lint`}
                        </p>
                      </li>
                    </Tooltip>
                  );
                })}
              </KnowledgeList>

              <KnowledgeList
                icon={GraduationCap}
                title="Lessons"
                meta={`${vm.lessons.length}`}
                empty="No learned lessons saved yet."
                emptyWhen={vm.lessons.length === 0}
              >
                {vm.lessons.slice(0, 6).map((lesson) => (
                  <Tooltip key={lesson.id} content={lesson.body}>
                    <li className="rounded-md px-2.5 py-2 transition-colors hover:bg-muted/60">
                      <div className="flex items-start gap-2">
                        <GraduationCap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                        <p className="min-w-0 text-[12px] leading-snug">
                          {lesson.title}
                        </p>
                      </div>
                      <p className="mt-1 truncate pl-5 text-[11px] text-muted-foreground">
                        {lesson.kind}
                        {lesson.links.length > 0 && ` · ${lesson.links.join(", ")}`}
                        {lesson.useCount > 0 && ` · used ${lesson.useCount}x`}
                      </p>
                    </li>
                  </Tooltip>
                ))}
              </KnowledgeList>
            </div>

            <section className="rounded-lg border border-border-subtle bg-card shadow-sm">
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                <div className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4 text-primary" />
                  <h3 className="text-sm font-semibold">Recent updates</h3>
                </div>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {vm.recentUpdates.length}
                </span>
              </div>
              {vm.recentUpdates.length === 0 ? (
                <p className="px-4 py-6 text-[12px] text-muted-foreground">
                  Knowledge deltas appear here as code changes.
                </p>
              ) : (
                <ul className="divide-y divide-border-subtle">
                  {vm.recentUpdates.map((update) => (
                    <li
                      key={update.ts + (update.files[0] ?? "")}
                      className="grid gap-2 px-4 py-2.5 md:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-[11px]">
                          {update.files[0] ?? "embedding backfill"}
                          {update.files.length > 1 &&
                            ` +${update.files.length - 1} more`}
                        </p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          {formatDelta("sym", update.symbolsDelta)}
                          {" · "}
                          {formatDelta("edge", update.edgesDelta)}
                          {" · "}
                          {update.embeddingsDelta} embedded
                        </p>
                      </div>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {new Date(update.ts).toLocaleTimeString(undefined, {
                          hour12: false,
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </main>
        </div>
      </WorkspacePageBody>

      <WikiModal
        open={wikiOpen}
        pages={vm.wikiPages}
        lint={vm.wikiLint}
        onClose={() => setWikiOpen(false)}
        onOpenInEditor={(path) => void vm.openWikiPage(path)}
        onResync={vm.refreshWiki}
      />
    </div>
  );
}

function Stat(props: {
  icon: typeof Database;
  label: string;
  value: number | undefined;
  busy?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border-subtle bg-card px-3 py-3 shadow-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <props.icon className="h-3.5 w-3.5" />
        <span className="text-[11px]">{props.label}</span>
        {props.busy && (
          <Loader2 className="ml-auto h-3 w-3 animate-spin text-primary" />
        )}
      </div>
      <p className="mt-2 text-xl font-semibold tabular-nums">
        {props.value ?? "—"}
      </p>
    </div>
  );
}

function MiniMetric(props: { label: string; value: number | string }) {
  return (
    <div className="rounded-md bg-muted/45 px-2.5 py-2">
      <p className="text-[10px] text-muted-foreground">{props.label}</p>
      <p className="mt-0.5 truncate text-[12px] font-semibold tabular-nums">
        {props.value}
      </p>
    </div>
  );
}

function PanelLink(props: {
  icon: typeof Database;
  label: string;
  detail: string;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "flex w-full items-center gap-3 border-b border-border-subtle px-3 py-3 text-left last:border-b-0",
        "transition-colors hover:bg-muted/55 disabled:opacity-50 disabled:hover:bg-transparent"
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {props.busy ? (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        ) : (
          <props.icon className="h-4 w-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-semibold">
          {props.label}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {props.detail}
        </span>
      </span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

function KnowledgeList(props: {
  icon: typeof Database;
  title: string;
  meta: string;
  empty: string;
  emptyWhen: boolean;
  /** Makes the title a button — for a list that has more behind it. */
  onTitleClick?: () => void;
  titleHint?: string;
  /** Extra control in the header, beside the count. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const heading = (
    <div className="flex items-center gap-2">
      <props.icon className="h-4 w-4 text-primary" />
      <h3 className="text-sm font-semibold">{props.title}</h3>
      {props.onTitleClick && (
        <ArrowRight className="h-3 w-3 text-muted-foreground/60" />
      )}
    </div>
  );
  return (
    <section className="rounded-lg border border-border-subtle bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        {props.onTitleClick ? (
          <Tooltip content={props.titleHint ?? props.title}>
            <button
              type="button"
              onClick={props.onTitleClick}
              className="-mx-1 rounded-md px-1 py-0.5 text-left hover:bg-accent/60"
            >
              {heading}
            </button>
          </Tooltip>
        ) : (
          heading
        )}
        <span className="flex items-center gap-1.5">
          <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {props.meta}
          </span>
          {props.action}
        </span>
      </div>
      {props.emptyWhen ? (
        <p className="px-4 py-6 text-[12px] text-muted-foreground">
          {props.empty}
        </p>
      ) : (
        <ul className="p-2">{props.children}</ul>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold",
        status === "fresh"
          ? "bg-success/15 text-success"
          : status === "stale"
            ? "bg-warning/15 text-warning"
            : "bg-muted text-muted-foreground"
      )}
    >
      {status}
    </span>
  );
}

function formatDelta(noun: string, n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n} ${noun}${Math.abs(n) === 1 ? "" : "s"}`;
}
