import { motion } from "framer-motion";
import { Cable } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ConnectionState } from "@/types";

export interface ConnectPanelProps {
  state: ConnectionState;
  port: string;
  token: string;
  onPortChange: (v: string) => void;
  onTokenChange: (v: string) => void;
  onConnect: () => void;
}

/** Manual fallback when bridge.json injection isn't available. */
export function ConnectPanel(props: ConnectPanelProps) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm rounded-2xl bg-muted/50 p-6"
      >
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/12">
          <Cable className="h-5 w-5 text-primary" />
        </div>
        <h2 className="text-base font-semibold">Connect to Local Agent</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          Start the agent with <code className="rounded bg-muted px-1">pnpm dev:agent</code>,
          then restart this dev server — or paste the port and token from
          <code className="ml-1 rounded bg-muted px-1">%LOCALAPPDATA%\atelier\bridge.json</code>.
        </p>
        <div className="mt-4 space-y-2.5">
          <Input
            placeholder="Port (e.g. 43110)"
            value={props.port}
            onChange={(e) => props.onPortChange(e.target.value)}
          />
          <Input
            placeholder="Token"
            type="password"
            value={props.token}
            onChange={(e) => props.onTokenChange(e.target.value)}
          />
          <Button className="w-full" onClick={props.onConnect}>
            Connect
          </Button>
        </div>
        <p className="mt-3 text-center text-[11px] text-muted-foreground/70">
          state: {props.state}
        </p>
      </motion.div>
    </div>
  );
}
