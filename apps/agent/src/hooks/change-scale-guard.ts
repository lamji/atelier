import type { EventBus } from "../events/event-bus.js";
import type { HookDecision, HookGuardContext } from "./hooks-engine.js";
import type { ChangeScale } from "../orchestrator/change-scale/index.js";

export const CHANGE_SCALE_HOOK_ID = "builtin-change-scale";
export const CHANGE_SCALE_HOOK_NAME = "Verification effort matches the change";
/** Tools that can spend minutes proving what the diff already shows. */
export const CHANGE_SCALE_MATCHER = "run_terminal|write_file";

/** Package/framework build invocations. */
const BUILD_COMMAND =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|next\s+build\b|vite\s+build\b|ng\s+build\b|tsc\s+-b\b|gradle\w*\s+build\b|mvn\s+package\b|cargo\s+build\b|go\s+build\b)/i;

const TEST_FILE = /(^|[\\/])__tests__[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/;

/**
 * Keeps a copy change from being verified like a refactor.
 *
 * Observed on a one-line label change: the model rewrote a test file nine
 * times, ran the suite eleven times and then queued a production build that
 * sat behind an approval modal for two minutes. None of it could tell a
 * right label from a wrong one. When the turn's diff is copy-only, a build
 * is refused (typecheck already covers it) and so is CREATING a new test
 * file (the existing tests and a preview assertion are the honest checks).
 * Editing an existing test stays allowed — that can be legitimate.
 */
export class ChangeScaleGuard {
  constructor(
    private bus: EventBus,
    private deps: {
      /** The current scale of the task's diff, or null before any edit. */
      scaleOf: (taskId: string) => Promise<ChangeScale | null>;
      fileExists: (relPath: string) => Promise<boolean>;
    }
  ) {}

  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    const input = (ctx.input ?? {}) as Record<string, unknown>;
    if (ctx.toolName === "run_terminal") {
      const command = typeof input.command === "string" ? input.command : "";
      if (!BUILD_COMMAND.test(command)) return undefined;
      const scale = await this.deps.scaleOf(ctx.taskId);
      if (scale !== "copy") return undefined;
      return this.block(
        ctx.taskId,
        `This turn's diff only changes copy (string literals / visible text). ` +
          `A build proves nothing a typecheck does not, and it can take ` +
          `minutes; run the typecheck or the one existing test file that ` +
          `covers the edited file, or assert the new text with preview_test. ` +
          `Refused: ${command.slice(0, 120)}`
      );
    }
    if (ctx.toolName === "write_file") {
      const path = typeof input.path === "string" ? input.path : "";
      if (!path || !TEST_FILE.test(path)) return undefined;
      const scale = await this.deps.scaleOf(ctx.taskId);
      if (scale !== "copy") return undefined;
      if (await this.deps.fileExists(path)) return undefined;
      return this.block(
        ctx.taskId,
        `This turn's diff only changes copy; a new test file (${path}) is ` +
          `not the verification it needs. Run the existing test that covers ` +
          `the edited file, or assert the visible text with preview_test.`
      );
    }
    return undefined;
  }

  private block(taskId: string, reason: string): HookDecision {
    this.bus.publish(
      "hook.blocked",
      { hookId: CHANGE_SCALE_HOOK_ID, name: CHANGE_SCALE_HOOK_NAME, reason },
      taskId
    );
    return { allowed: false, reason };
  }
}
