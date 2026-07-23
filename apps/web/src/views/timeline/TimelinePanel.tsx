import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  CheckCircle2,
  FileDiff,
  FileText,
  GitBranch,
  ListChecks,
  Network,
  Play,
  TerminalSquare,
  Webhook,
  Wrench,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { TimelineEntryVm } from "@/types";

export interface TimelinePanelProps {
  entries: TimelineEntryVm[];
}

export function TimelinePanel({ entries }: TimelinePanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {entries.length === 0 && (
          <p className="pt-8 text-center text-xs text-muted-foreground/70">
            Agent actions appear here as they happen.
          </p>
        )}
        <div className="space-y-1">
          <AnimatePresence initial={false}>
            {entries.map((entry) => (
              <TimelineCard key={entry.key} entry={entry} />
            ))}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

interface TopicStyle {
  icon: typeof Activity;
  tone: "default" | "primary" | "success" | "destructive";
}

function styleFor(topic: string): TopicStyle {
  if (topic.startsWith("tool.failed") || topic === "task.error") {
    return { icon: XCircle, tone: "destructive" };
  }
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

function TimelineCard({ entry }: { entry: TimelineEntryVm }) {
  const { icon: Icon, tone } = styleFor(entry.topic);
  const time = new Date(entry.ts).toLocaleTimeString(undefined, {
    hour12: false,
  });
  const detail = summarize(entry);

  return (
    <motion.div
      layout="position"
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
}

function summarize(entry: TimelineEntryVm): string {
  const p = entry.payload as Record<string, unknown> | null;
  if (!p) return "";
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
