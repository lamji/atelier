import fs from "node:fs";
import path from "node:path";

export interface AgentConfig {
  /** Directory the agent operates on (the user's project). */
  workspaceRoot: string;
  /** Directory for agent-owned data (db, logs). */
  dataDir: string;
  /** Project id assigned by the desktop registry. */
  projectId: string;
  agentVersion: string;
}

/**
 * The agent never guesses its workspace. It is forked by the desktop's
 * ProjectManager with an explicit init message; a missing or invalid
 * workspaceRoot is a hard error. (The old `process.cwd()` fallback is how
 * a mis-launched agent silently served the wrong folder.)
 */
export function resolveConfig(init: {
  projectId: string;
  workspaceRoot: string;
  dataDir: string;
}): AgentConfig {
  if (!init.workspaceRoot) {
    throw new Error("agent init: workspaceRoot is required");
  }
  const workspaceRoot = path.resolve(init.workspaceRoot);
  if (!fs.existsSync(workspaceRoot) || !fs.statSync(workspaceRoot).isDirectory()) {
    throw new Error(`agent init: workspaceRoot is not a directory: ${workspaceRoot}`);
  }
  if (!init.dataDir) {
    throw new Error("agent init: dataDir is required");
  }
  fs.mkdirSync(init.dataDir, { recursive: true });
  return {
    workspaceRoot,
    dataDir: init.dataDir,
    projectId: init.projectId,
    agentVersion: "0.1.0",
  };
}
