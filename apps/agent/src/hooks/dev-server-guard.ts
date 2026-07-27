import fs from "node:fs";
import path from "node:path";
import { portInUse } from "@atelier/shared/node";
import type { HookConfig } from "@atelier/protocol";
import type { EventBus } from "../events/event-bus.js";
import type { HookDecision } from "./hooks-engine.js";
import { detectDevServerIntent } from "./dev-server-intent.js";
import type { DevServerIntent } from "./dev-server-intent.js";

export const DEV_SERVER_HOOK_ID = "builtin-dev-server";
export const DEV_SERVER_HOOK_NAME =
  "Dev server: never start a duplicate instance";

/**
 * Right after a launch the server has not bound its port yet, so the probe
 * would wrongly report it free. Within this window a repeat launch is refused
 * on the session record alone.
 */
const BINDING_GRACE_MS = 45_000;

/**
 * How long a launch stays evidence of a live server when its port could not
 * be inferred (`nodemon`, `docker compose up`) and there is nothing to probe.
 */
const STARTED_TTL_MS = 30 * 60_000;

/** Advice appended to every refusal — what to do instead of retrying. */
const GUIDANCE =
  "Do NOT start it again: a second instance either fails on the taken port " +
  "or silently moves to another one, which leaves the user with two servers " +
  "and a UI pointed at the stale one. Use the instance that is already " +
  "running (it picks up code changes itself), read its terminal output for " +
  "errors, or ask the user to restart it. If you genuinely need a fresh " +
  "start, ask the user first.";

/**
 * Blocks the agent from starting a dev server that is already up.
 *
 * Two signals, because either alone has a blind spot: a port probe catches
 * servers started outside Atelier (the user's own terminal) but not runners
 * whose port cannot be inferred, while the session record catches repeat
 * launches by the agent itself, including the seconds before a port is bound.
 *
 * A dev command with nothing already listening passes straight through — the
 * hook refuses actual duplicates only, so first starts and restarts after a
 * crash both still work.
 */
export class DevServerGuard {
  /** intent.key -> epoch ms of the launch this guard let through. */
  private started = new Map<string, number>();

  constructor(
    private bus: EventBus,
    private workspaceRoot: string,
    /** Injectable for tests; defaults to a real 127.0.0.1 probe. */
    private probe: (port: number) => Promise<boolean> = portInUse,
    /** Injectable clock, so tests can cross the timing windows. */
    private now: () => number = Date.now
  ) {}

  async check(ctx: {
    toolName: string;
    input: unknown;
    taskId: string;
    hook: HookConfig;
  }): Promise<HookDecision | undefined> {
    const intent = detectDevServerIntent(
      ctx.toolName,
      ctx.input,
      this.packageScripts()
    );
    if (!intent) return undefined;

    const duplicate = await this.findDuplicate(intent);
    if (!duplicate) {
      // First start of this server: remember it so a repeat launch is caught
      // even while the port is still being bound.
      this.started.set(intent.key, this.now());
      return undefined;
    }

    const reason =
      `${intent.label} would start a second dev server: ${duplicate}. ` +
      GUIDANCE;
    this.bus.publish(
      "hook.matched",
      { hookId: ctx.hook.id, name: ctx.hook.name, on: ctx.toolName },
      ctx.taskId
    );
    this.bus.publish(
      "hook.blocked",
      { hookId: ctx.hook.id, name: ctx.hook.name, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
  }

  /** Human-readable evidence of an existing instance, or null if none. */
  private async findDuplicate(intent: DevServerIntent): Promise<string | null> {
    for (const port of intent.ports) {
      if (await this.probe(port)) {
        const how =
          intent.portSource === "explicit"
            ? "the port it was told to use"
            : `the default port for ${intent.runner ?? "this runner"}`;
        return `something is already listening on 127.0.0.1:${port} (${how})`;
      }
    }

    const at = this.started.get(intent.key);
    const age = at === undefined ? Infinity : this.now() - at;
    if (age < BINDING_GRACE_MS) {
      return "this session launched it seconds ago and it is still starting up";
    }
    // A port we know about that is NOT listening proves the earlier instance
    // is gone, so a restart is legitimate; the record only stands in when
    // there was no port to probe.
    if (intent.ports.length > 0) {
      this.started.delete(intent.key);
      return null;
    }
    if (age < STARTED_TTL_MS) {
      const minutes = Math.max(1, Math.round(age / 60_000));
      return `this session started it ~${minutes} min ago and never stopped it`;
    }
    return null;
  }

  /**
   * The workspace's own scripts, so `npm run dev` can be resolved to the real
   * runner and its port. Read per call (the file is small and may change);
   * a missing or broken package.json simply yields no scripts.
   */
  private packageScripts(): Record<string, string> {
    try {
      const file = path.join(this.workspaceRoot, "package.json");
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        scripts?: Record<string, string>;
      };
      return parsed.scripts ?? {};
    } catch {
      return {};
    }
  }
}
