/**
 * Node-only helpers (filesystem + net). Kept out of the package barrel
 * (`index.ts`) so browser bundles never try to pull in `node:*` modules.
 * Import via `@atelier/shared/node`.
 */
import os from "node:os";
import path from "node:path";
import net from "node:net";

/** Base dir for all Atelier data (LOCALAPPDATA on Windows, ~/.local/share). */
export function atelierDataRoot(): string {
  const base =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "atelier");
}

/** Stable slug for a workspace path — filesystem-safe, case-insensitive. */
export function projectSlug(workspaceRoot: string): string {
  return workspaceRoot
    .replace(/[\\/:]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLowerCase();
}

/** Per-project data dir so each project keeps its own knowledge DB. */
export function projectDataDir(workspaceRoot: string): string {
  return path.join(atelierDataRoot(), "projects", projectSlug(workspaceRoot));
}

/** True if something is already listening on the port (127.0.0.1). */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Bind-test ports upward from `start` until one is free.
 *
 * `skip` excludes ports that are spoken for but not yet bound — a child
 * process that has been spawned with a port but has not listened on it yet
 * still looks free to a bind test, so callers handing out ports to several
 * children must pass the ones they already handed out.
 */
export async function freePort(
  start: number,
  span = 100,
  skip: ReadonlySet<number> = new Set()
): Promise<number> {
  for (let port = start; port < start + span; port++) {
    if (skip.has(port)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  return start;
}
