import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Copy,
  FolderOpen,
  Loader2,
  PowerOff,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type {
  ConnectionGateVm,
  GateReason,
} from "@/hooks/useConnectionGateViewModel";

/** The one command that fixes every disconnected case. */
const RUN_COMMAND = "atelier run";

interface GateCopy {
  icon: typeof PowerOff;
  title: string;
  body: string;
  tone: "error" | "info";
  steps: string[];
}

function copyFor(vm: ConnectionGateVm, reason: GateReason): GateCopy {
  const project = vm.projectName ?? "this project";
  switch (reason) {
    case "supervisor-down":
      return {
        icon: PowerOff,
        title: "Atelier isn't running",
        body:
          "Nothing is serving this workspace, so no files, sessions or " +
          "agents can load. Start Atelier from the folder you want to work in.",
        tone: "error",
        steps: [
          "Open a terminal in your project folder",
          `Run ${RUN_COMMAND}`,
          "Come back here — this screen clears itself once it connects",
        ],
      };
    case "no-project":
      return {
        icon: FolderOpen,
        title: "No project open",
        body:
          "Atelier is running but no project is attached to this window. " +
          "Opening a project is done from its own folder.",
        tone: "info",
        steps: [
          "Open a terminal in your project folder",
          `Run ${RUN_COMMAND} — it registers that folder and opens it here`,
        ],
      };
    case "agent-down":
      return {
        icon: TriangleAlert,
        title: "Agent disconnected",
        body:
          `The agent for ${project} stopped responding. Restart it below, ` +
          "or relaunch Atelier from the project folder.",
        tone: "error",
        steps: [
          "Hit Restart agent — the supervisor respawns it in place",
          `If that fails, run ${RUN_COMMAND} in your project folder`,
        ],
      };
    case "agent-error":
      return {
        icon: TriangleAlert,
        title: "Agent failed to start",
        body:
          `Atelier could not start the agent for ${project}. The detail ` +
          "below comes straight from the supervisor.",
        tone: "error",
        steps: [
          "Fix the cause shown below (missing deps, port in use, bad path)",
          `Run ${RUN_COMMAND} in your project folder again`,
        ],
      };
    case "unauthorized":
      return {
        icon: ShieldAlert,
        title: "Connection rejected",
        body:
          "The token this tab holds was refused — usually a page left open " +
          "from an older Atelier run.",
        tone: "error",
        steps: [
          `Run ${RUN_COMMAND} in your project folder`,
          "Reload this page so it picks up the new token",
        ],
      };
  }
}

/**
 * Full-screen block shown whenever the workspace has no live agent behind it.
 * Every control in the app is unusable in that state, so this covers the
 * whole viewport rather than sitting inside a pane — and it says exactly what
 * to run to fix it. Connecting is NOT a blocking state: escalation is
 * debounced in the ViewModel, so boot and project switches never flash it.
 */
export function ConnectionGate({ vm }: { vm: ConnectionGateVm }) {
  return (
    <AnimatePresence>
      {vm.reason !== null && <GateOverlay vm={vm} reason={vm.reason} />}
    </AnimatePresence>
  );
}

function GateOverlay({
  vm,
  reason,
}: {
  vm: ConnectionGateVm;
  reason: GateReason;
}) {
  const copy = copyFor(vm, reason);
  const command = vm.projectPath
    ? `cd "${vm.projectPath}"\n${RUN_COMMAND}`
    : RUN_COMMAND;
  const restarts = reason === "agent-down" || reason === "agent-error";

  return (
    <motion.div
      role="alertdialog"
      aria-modal="true"
      aria-label={copy.title}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="fixed inset-0 z-[100] flex items-center justify-center
        bg-background/95 p-6 backdrop-blur-md"
    >
      <motion.div
        initial={{ scale: 0.97, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 280, damping: 26 }}
        className="w-full max-w-lg rounded-2xl bg-card/90 p-7 shadow-2xl
          ring-1 ring-border/60"
      >
        <div className="flex items-start gap-3.5">
          <span
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
              copy.tone === "error"
                ? "bg-destructive/15 text-destructive"
                : "bg-primary/12 text-primary"
            )}
          >
            <copy.icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-base font-bold tracking-tight">
              {copy.title}
            </h2>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {copy.body}
            </p>
          </div>
        </div>

        {vm.detail && (
          <pre
            className="mt-4 max-h-28 overflow-auto rounded-xl bg-destructive/10
              px-3 py-2 font-mono text-[11px] leading-relaxed text-destructive"
          >
            {vm.detail}
          </pre>
        )}

        <ol className="mt-5 space-y-2">
          {copy.steps.map((step, i) => (
            <li key={step} className="flex gap-2.5 text-xs">
              <span
                className="flex h-5 w-5 shrink-0 items-center justify-center
                  rounded-full bg-muted text-[10px] font-bold
                  text-muted-foreground"
              >
                {i + 1}
              </span>
              <span className="pt-0.5 leading-relaxed">{step}</span>
            </li>
          ))}
        </ol>

        <CommandBlock command={command} />

        <div className="mt-5 flex items-center gap-2">
          <Button
            className="flex-1"
            onClick={() => void vm.retry()}
            disabled={vm.retrying}
          >
            {vm.retrying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {restarts ? "Restart agent" : "Retry connection"}
          </Button>
          <Button variant="outline" onClick={vm.reload}>
            Reload page
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** The command to run, with a copy button — the actual fix, front and centre. */
function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="mt-4 flex items-start gap-2 rounded-xl bg-muted/60 p-3">
      <pre
        className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px]
          leading-relaxed text-foreground/90"
      >
        {command}
      </pre>
      <Button
        size="sm"
        variant="ghost"
        onClick={onCopy}
        aria-label="Copy command"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
