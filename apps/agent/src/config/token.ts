import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "./agent-config.js";

export interface BridgeInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: number;
}

/**
 * Writes bridge.json so the web app (dev server plugin) can auto-connect.
 * The token is generated once and REUSED across agent restarts so a running
 * UI never ends up holding a stale token.
 */
export function createBridgeInfo(config: AgentConfig): BridgeInfo {
  const file = path.join(config.dataDir, "bridge.json");
  let token: string | null = null;
  try {
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as BridgeInfo;
    if (typeof existing.token === "string" && existing.token.length >= 32) {
      token = existing.token;
    }
  } catch {
    // first run
  }
  const info: BridgeInfo = {
    port: config.port,
    token: token ?? crypto.randomBytes(32).toString("hex"),
    pid: process.pid,
    startedAt: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(info, null, 2), "utf8");
  return info;
}

export function bridgeInfoPath(config: AgentConfig): string {
  return path.join(config.dataDir, "bridge.json");
}
