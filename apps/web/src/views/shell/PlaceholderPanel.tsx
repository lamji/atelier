import { motion } from "framer-motion";
import { Hourglass } from "lucide-react";

export interface PlaceholderPanelProps {
  title: string;
  phase: string;
}

/** Stub panel for modules that land in later phases. */
export function PlaceholderPanel({ title, phase }: PlaceholderPanelProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex h-11 w-11 items-center justify-center rounded-2xl bg-muted"
      >
        <Hourglass className="h-5 w-5 text-muted-foreground/70" />
      </motion.div>
      <div className="text-center">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground/60">
          Coming in {phase}
        </p>
      </div>
    </div>
  );
}
