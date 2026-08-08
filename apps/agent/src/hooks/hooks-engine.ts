import { execa } from "execa";
import { globMatch } from "@atelier/shared";
import type { HookConfig } from "@atelier/protocol";
import type { Db } from "../storage/db.js";
import type { EventBus } from "../events/event-bus.js";

export interface HookDecision {
  allowed: boolean;
  reason?: string;
}

export interface HookGuardContext {
  toolName: string;
  input: unknown;
  taskId: string;
  hook: HookConfig;
  /** Aborts when the task stops — guards that wait on the user must
   *  stop waiting. */
  signal?: AbortSignal;
}

/**
 * Decision logic for a built-in hook whose verdict depends on the call's
 * content, not just its matcher. Returning undefined lets the call pass to
 * the next hook; the guard owns its own hook.* events.
 */
export type HookGuard = (
  ctx: HookGuardContext
) => Promise<HookDecision | undefined>;

const RUN_COMMAND_TIMEOUT_MS = 15_000;

/**
 * Evaluates user-configured hooks around tool calls (preTool) and before
 * tasks (preTask). Every tool call — model- or UI-invoked — flows through
 * evaluateToolUse via the ToolRegistry, so hooks cannot be bypassed.
 * Blocks surface as hook.blocked events; the model sees the denial in the
 * tool error and adapts.
 */
export class HooksEngine {
  private guards = new Map<string, HookGuard>();

  constructor(
    private db: Db,
    private bus: EventBus,
    private workspaceRoot = process.cwd()
  ) {}

  /**
   * Attaches a guard to a built-in hook. While the hook is enabled its
   * guard decides instead of the stored action, so a coarse matcher (e.g.
   * every git/terminal call) can still make a fine-grained decision. The
   * user's toggle in the hooks panel keeps working: disabled hooks are
   * never consulted.
   */
  registerGuard(hookId: string, guard: HookGuard): void {
    this.guards.set(hookId, guard);
  }

  list(): HookConfig[] {
    const rows = this.db
      .prepare("SELECT config FROM hook_configs")
      .all() as Array<{ config: string }>;
    return rows.map((r) => JSON.parse(r.config) as HookConfig);
  }

  save(hook: HookConfig): HookConfig {
    this.db
      .prepare(
        "INSERT INTO hook_configs(id, config, enabled) VALUES(?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET config = excluded.config, " +
          "enabled = excluded.enabled"
      )
      .run(hook.id, JSON.stringify(hook), hook.enabled ? 1 : 0);
    return hook;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM hook_configs WHERE id = ?").run(id);
  }

  /** Register a built-in hook once; user edits (e.g. disabling) persist. */
  ensureBuiltin(config: HookConfig): void {
    const exists = this.db
      .prepare("SELECT 1 FROM hook_configs WHERE id = ?")
      .get(config.id);
    if (!exists) this.save(config);
  }

  isEnabled(id: string): boolean {
    const row = this.db
      .prepare("SELECT enabled FROM hook_configs WHERE id = ?")
      .get(id) as { enabled: number } | undefined;
    return row ? row.enabled === 1 : false;
  }

  private enabledFor(event: HookConfig["event"]): HookConfig[] {
    return this.list().filter((h) => h.enabled && h.event === event);
  }

  /** Gate one tool call. First matching allow/block decides; annotate and
   *  runCommand hooks run through. */
  async evaluateToolUse(
    toolName: string,
    input: unknown,
    taskId: string,
    signal?: AbortSignal
  ): Promise<HookDecision> {
    const path = extractPath(input);
    for (const hook of this.enabledFor("preTool")) {
      if (!matchesTool(hook.matcher, toolName)) continue;
      if (hook.pathGlob && (!path || !globMatch(hook.pathGlob, path))) continue;
      const guard = this.guards.get(hook.id);
      if (guard) {
        const verdict = await guard({ toolName, input, taskId, hook, signal });
        if (verdict) return verdict;
        continue;
      }
      this.bus.publish(
        "hook.matched",
        { hookId: hook.id, name: hook.name, on: toolName },
        taskId
      );
      const decision = await this.applyAction(hook, taskId, {
        toolName,
        path,
      });
      if (decision) return decision;
    }
    return { allowed: true };
  }

  /** Pre-task gate: matcher "*" always matches, otherwise a
   *  case-insensitive substring of the prompt. */
  async evaluatePreTask(prompt: string, taskId: string): Promise<HookDecision> {
    for (const hook of this.enabledFor("preTask")) {
      if (
        hook.matcher !== "*" &&
        !prompt.toLowerCase().includes(hook.matcher.toLowerCase())
      ) {
        continue;
      }
      this.bus.publish(
        "hook.matched",
        { hookId: hook.id, name: hook.name, on: "task" },
        taskId
      );
      const decision = await this.applyAction(hook, taskId, {
        toolName: "task",
      });
      if (decision) return decision;
    }
    return { allowed: true };
  }

  /** Returns a decision when the hook decides; undefined = continue. */
  private async applyAction(
    hook: HookConfig,
    taskId: string,
    ctx: { toolName: string; path?: string }
  ): Promise<HookDecision | undefined> {
    switch (hook.action) {
      case "allow":
        return { allowed: true };
      case "block": {
        const reason = hook.argument || `Blocked by hook "${hook.name}"`;
        this.bus.publish(
          "hook.blocked",
          { hookId: hook.id, name: hook.name, reason },
          taskId
        );
        return { allowed: false, reason };
      }
      case "annotate":
        this.bus.publish(
          "hook.completed",
          { hookId: hook.id, name: hook.name, output: hook.argument },
          taskId
        );
        return undefined;
      case "runCommand": {
        if (!hook.argument) return undefined;
        this.bus.publish(
          "hook.started",
          { hookId: hook.id, name: hook.name },
          taskId
        );
        const result = await execa(hook.argument, {
          shell: true,
          windowsHide: true,
          cwd: this.workspaceRoot,
          timeout: RUN_COMMAND_TIMEOUT_MS,
          reject: false,
          all: true,
          env: {
            ATELIER_TOOL: ctx.toolName,
            ATELIER_PATH: ctx.path ?? "",
          },
        });
        const output = tail(String(result.all ?? ""), 1000);
        if (result.exitCode === 0) {
          this.bus.publish(
            "hook.completed",
            { hookId: hook.id, name: hook.name, output },
            taskId
          );
          return undefined;
        }
        const reason =
          `Hook "${hook.name}" command failed (exit ${result.exitCode}): ` +
          output;
        this.bus.publish(
          "hook.blocked",
          { hookId: hook.id, name: hook.name, reason },
          taskId
        );
        return { allowed: false, reason };
      }
    }
  }
}

function matchesTool(matcher: string, toolName: string): boolean {
  if (matcher === "*" || matcher === "") return true;
  return matcher
    .split("|")
    .map((m) => m.trim())
    .includes(toolName);
}

function extractPath(input: unknown): string | undefined {
  if (input && typeof input === "object") {
    const path = (input as Record<string, unknown>).path;
    if (typeof path === "string") return path;
  }
  return undefined;
}

function tail(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}
