import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentStatus } from "@atelier/protocol";

export interface AuthProbe {
  status: AgentStatus;
  detail?: string;
}

/**
 * Best-effort check for Claude Code subscription credentials. The SDK reads
 * the login produced by `claude /login`; we only detect its presence so the
 * UI can guide the user before the first real query fails.
 */
export function probeAuth(): AuthProbe {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      status: "idle",
      detail:
        "ANTHROPIC_API_KEY is set and will shadow your Claude subscription " +
        "login — unset it to use your subscription.",
    };
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".claude", "credentials.json"),
    path.join(home, ".claude.json"),
  ];
  if (candidates.some((p) => fs.existsSync(p))) {
    return { status: "idle" };
  }
  return {
    status: "waiting-auth",
    detail: "No Claude Code login found. Run `claude` and use /login first.",
  };
}

/** Detects auth failures surfaced by the SDK at query time. */
export function isAuthError(error: unknown): boolean {
  const text = String(
    (error as { message?: string } | undefined)?.message ?? error
  ).toLowerCase();
  return (
    text.includes("not logged in") ||
    text.includes("/login") ||
    text.includes("authentication") ||
    text.includes("unauthorized")
  );
}
