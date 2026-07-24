import os from "node:os";
import path from "node:path";

export { projectDataDir, projectSlug } from "@atelier/shared/node";

/** Root of the installed Atelier app (bundled agent + web dist). */
export function installRoot(): string {
  const base =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "atelier", "app");
}

export function agentEntry(): string {
  return path.join(installRoot(), "agent", "main.mjs");
}

export function supervisorEntry(): string {
  return path.join(installRoot(), "agent", "supervisor-main.mjs");
}

export function webDist(): string {
  return path.join(installRoot(), "web");
}
