import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export interface AgentConfig {
  /** Directory the agent operates on (the user's project). */
  workspaceRoot: string;
  /** Directory for agent-owned data (db, bridge.json, logs). */
  dataDir: string;
  host: string;
  port: number;
  agentVersion: string;
}

function defaultDataDir(): string {
  const base =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "atelier");
}

export function loadConfig(): AgentConfig {
  const workspaceRoot = path.resolve(
    process.env.ATELIER_WORKSPACE ?? process.cwd()
  );
  const dataDir = process.env.ATELIER_DATA_DIR ?? defaultDataDir();
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    workspaceRoot,
    dataDir,
    host: "127.0.0.1",
    port: Number(process.env.ATELIER_PORT ?? 43110),
    agentVersion: "0.1.0",
  };
}
