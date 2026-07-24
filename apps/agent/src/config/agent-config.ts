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
  /**
   * Built web UI directory to serve over HTTP on the same port (packaged
   * mode). Undefined in dev, where Vite serves the UI separately.
   */
  webDistPath?: string;
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
  const webDistEnv = process.env.ATELIER_WEB_DIST;
  const webDistPath =
    webDistEnv && fs.existsSync(webDistEnv) ? webDistEnv : undefined;
  return {
    workspaceRoot,
    dataDir,
    host: "127.0.0.1",
    port: Number(process.env.ATELIER_PORT ?? 43110),
    agentVersion: "0.1.0",
    webDistPath,
  };
}
