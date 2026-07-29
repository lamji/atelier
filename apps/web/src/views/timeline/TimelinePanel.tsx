import { memo, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  CheckCircle2,
  Database,
  FileDiff,
  FileText,
  GitBranch,
  FolderLock,
  History,
  ListChecks,
  Network,
  Play,
  Radar,
  TerminalSquare,
  Webhook,
  Wrench,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useStickToTop } from "@/hooks/useStickToBottom";
import type { TimelineEntryVm } from "@/types";

export interface TimelinePanelProps {
  entries: TimelineEntryVm[];
}

/**
 * The agent's raw event feed. Memoized, and each card is memoized too: the
 * panel sits inside the shell's tree, so without this every keystroke and
 * every unrelated store write re-rendered the whole list.
 */
export const TimelinePanel = memo(function TimelinePanel({
  entries,
}: TimelinePanelProps) {
  // Newest first, pinned to the top — but only while you're already there,
  // so scrolling down to read older entries isn't interrupted.
  const { ref: scrollRef, onScroll } = useStickToTop<HTMLDivElement>([entries]);
  const newestFirst = useMemo(() => [...entries].reverse(), [entries]);

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto p-2"
      >
        {entries.length === 0 && (
          <p className="pt-8 text-center text-xs text-muted-foreground/70">
            Agent actions appear here as they happen.
          </p>
        )}
        <div className="space-y-1">
          <AnimatePresence initial={false}>
            {newestFirst.map((entry) => (
              <TimelineCard key={entry.key} entry={entry} />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
});

interface TopicStyle {
  icon: typeof Activity;
  tone: "default" | "primary" | "success" | "destructive";
}

function styleFor(topic: string): TopicStyle {
  if (
    topic.startsWith("tool.failed") ||
    topic === "task.error" ||
    topic === "hook.blocked"
  ) {
    return { icon: XCircle, tone: "destructive" };
  }
  if (topic === "summary.created") {
    return { icon: CheckCircle2, tone: "success" };
  }
  if (topic.startsWith("validation.")) {
    return { icon: ListChecks, tone: "primary" };
  }
  if (topic === "impact.radius" || topic === "edit.impact") {
    return { icon: Radar, tone: "destructive" };
  }
  if (topic === "intent.resolved" || topic === "impact.analyzed") {
    return { icon: Network, tone: "primary" };
  }
  if (topic === "session.recalled") return { icon: History, tone: "primary" };
  if (topic === "scope.locked") return { icon: FolderLock, tone: "primary" };
  if (topic === "task.completed") return { icon: CheckCircle2, tone: "success" };
  if (topic === "task.started") return { icon: Play, tone: "primary" };
  if (topic.startsWith("tool.")) return { icon: Wrench, tone: "primary" };
  if (topic.startsWith("diff.") || topic === "edit.applied") {
    return { icon: FileDiff, tone: "primary" };
  }
  if (topic.startsWith("file.")) return { icon: FileText, tone: "default" };
  if (topic.startsWith("terminal.")) {
    return { icon: TerminalSquare, tone: "default" };
  }
  if (topic.startsWith("db.")) return { icon: Database, tone: "primary" };
  if (topic.startsWith("git.")) return { icon: GitBranch, tone: "default" };
  if (topic.startsWith("knowledge.")) return { icon: Network, tone: "default" };
  if (topic.startsWith("hook.")) return { icon: Webhook, tone: "default" };
  if (topic.startsWith("pipeline.") || topic.startsWith("plan.")) {
    return { icon: ListChecks, tone: "primary" };
  }
  return { icon: Activity, tone: "default" };
}

const TONE_CLASSES: Record<TopicStyle["tone"], string> = {
  default: "text-muted-foreground bg-muted",
  primary: "text-primary bg-primary/12",
  success: "text-success bg-success/12",
  destructive: "text-destructive bg-destructive/12",
};

const TimelineCard = memo(function TimelineCard({
  entry,
}: {
  entry: TimelineEntryVm;
}) {
  const { icon: Icon, tone } = styleFor(entry.topic);
  const time = new Date(entry.ts).toLocaleTimeString(undefined, {
    hour12: false,
  });
  const detail = summarize(entry);

  return (
    // No `layout` here: hundreds of layout-projected nodes forced a measure
    // pass on every commit, and the list only ever grows at one end.
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="flex items-start gap-2 rounded-lg bg-muted/50 px-2 py-1.5"
    >
      <span
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md",
          TONE_CLASSES[tone]
        )}
      >
        <Icon className="h-3 w-3" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate font-mono text-[11px] font-medium">
            {entry.topic}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
            {time}
          </span>
        </span>
        {detail && (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
    </motion.div>
  );
});

function summarize(entry: TimelineEntryVm): string {
  const p = entry.payload as Record<string, unknown> | null;
  if (!p) return "";
  // Typed pipeline cards.
  switch (entry.topic) {
    case "pipeline.stage.started":
      return `stage: ${String(p.stage)}`;
    case "pipeline.stage.completed": {
      const ok = p.ok ? "✓" : "✗";
      const detail = typeof p.detail === "string" ? ` — ${p.detail}` : "";
      return `${ok} ${String(p.stage)} (${Number(p.durationMs)}ms)${detail}`;
    }
    case "intent.resolved":
      return `${String(p.kind)}: ${String(p.summary ?? "").slice(0, 120)}`;
    case "knowledge.retrieved": {
      const chunks = Array.isArray(p.chunks) ? p.chunks.length : 0;
      return `${String(p.strategy)} · ${chunks} chunks`;
    }
    case "scope.locked": {
      const roots = Array.isArray(p.roots) ? p.roots.map(String) : [];
      if (roots.length === 0) return "no scope lock";
      const repo = typeof p.repo === "string" && p.repo ? ` · git: ${p.repo}` : "";
      return `${roots.map((r) => `${r}/`).join(", ")}${repo}`;
    }
    case "session.recalled": {
      const labels = Array.isArray(p.labels) ? p.labels.map(String) : [];
      const head =
        `${Number(p.chunks ?? 0)} memory chunk(s) · ` +
        `${Number(p.summaries ?? 0)} summary(ies) · ` +
        `${Number(p.turns ?? 0)} turn(s) · ~${Number(p.tokens ?? 0)} tok`;
      return labels.length > 0 ? `${head} — ${labels.join("; ")}` : head;
    }
    case "impact.analyzed": {
      const files = Array.isArray(p.affectedFiles) ? p.affectedFiles.length : 0;
      const risks = Array.isArray(p.riskNotes) ? p.riskNotes.length : 0;
      return `${files} dependent file(s)` + (risks ? ` · ${risks} risk note(s)` : "");
    }
    case "impact.radius":
      return String(p.summary ?? "");
    case "edit.impact":
      return `${String(p.symbol ?? "")} · ${String(p.reach ?? "")} · ${String(p.summary ?? "").slice(0, 90)}`;
    case "plan.created": {
      const steps = Array.isArray(p.steps) ? p.steps.length : 0;
      return `${String(p.goal ?? "").slice(0, 100)} · ${steps} steps`;
    }
    case "plan.step.updated":
      return `${String(p.status)}${p.note ? ` — ${String(p.note)}` : ""}`;
    case "validation.result": {
      const findings = Array.isArray(p.findings) ? p.findings.length : 0;
      return `${String(p.kind)}: ${p.ok ? "green" : `${findings} finding(s)`} (${Number(p.durationMs)}ms)`;
    }
    case "summary.created":
      return String(p.text ?? "").slice(0, 160);
    case "hook.blocked":
      return `${String(p.name)}: ${String(p.reason ?? "").slice(0, 120)}`;
    case "review.checked": {
      const similar = Array.isArray(p.similar) ? p.similar.length : 0;
      const companions = Array.isArray(p.companionFiles)
        ? p.companionFiles.length
        : 0;
      const scanned = `${similar} similar file(s), ${companions} companion(s)`;
      if (!p.verdict) return scanned;
      const attempt = p.attempt ? ` #${Number(p.attempt)}` : "";
      const findings = Array.isArray(p.findings) ? p.findings : [];
      const detail =
        p.verdict === "pass"
          ? "passed"
          : `FAILED — ${findings.slice(0, 2).join("; ").slice(0, 120) ||
              "no findings reported"}`;
      return `review${attempt} ${detail} · ${scanned}`;
    }
    case "git.flow.requested":
      return `awaiting confirmation — ${String(p.command ?? "").slice(0, 120)}`;
    case "db.approval.requested":
      return `${String(p.operation)} — ${String(p.command ?? "").slice(0, 100)}`;
    case "db.approval.resolved":
      return String(p.outcome);
    case "knowledge.lesson.saved": {
      const lesson = p.lesson as Record<string, unknown> | undefined;
      return String(lesson?.title ?? "").slice(0, 120);
    }
  }
  if (typeof p.prompt === "string") return p.prompt.slice(0, 140);
  if (typeof p.name === "string") {
    const path =
      typeof (p.input as Record<string, unknown> | undefined)?.path === "string"
        ? ` · ${String((p.input as Record<string, unknown>).path)}`
        : "";
    return `${p.name}${path}`;
  }
  if (typeof p.path === "string") return String(p.path);
  if (typeof p.message === "string") return p.message.slice(0, 140);
  if (typeof p.detail === "string") return p.detail.slice(0, 140);
  if (typeof p.status === "string") return String(p.status);
  if (typeof p.durationMs === "number") return `${p.durationMs} ms`;
  return "";
}
