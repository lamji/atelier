import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execa } from "execa";
import type {
  ValidationFinding,
  ValidationKind,
  ValidationResult,
} from "@atelier/protocol";

const RUN_TIMEOUT_MS = 240_000;
const RAW_OUTPUT_MAX = 4000;

/** Grace period before a killed tree is given up on, matching run_terminal. */
const FORCE_KILL_AFTER_MS = 1000;

export interface RunValidationOptions {
  /** Cancels the run; takes the whole process tree down with it. */
  signal?: AbortSignal;
  /** Receives output as it arrives, so a long run is never a silent one. */
  onChunk?: (text: string) => void;
  /**
   * Restricts a `test` run to these files. Passed as positional filters
   * after `--`, which is how vitest and jest both narrow a run; ignored for
   * lint and typecheck, whose scripts own their own file globs.
   */
  paths?: string[];
}

/** Script names probed per validation kind, first hit wins. */
const SCRIPT_CANDIDATES: Record<ValidationKind, string[]> = {
  typecheck: ["typecheck", "type-check", "tsc"],
  lint: ["lint"],
  test: ["test", "test:unit"],
};

/**
 * Lint/test/typecheck runners: detect package.json scripts, run them with
 * the right package manager, parse output into structured findings.
 */
export class ValidationRunners {
  constructor(private workspaceRoot: string) {}

  /** Which validation kinds this workspace supports (script exists). */
  detect(): ValidationKind[] {
    const scripts = this.scripts();
    const kinds: ValidationKind[] = [];
    for (const kind of ["typecheck", "lint", "test"] as ValidationKind[]) {
      if (SCRIPT_CANDIDATES[kind].some((s) => scripts[s])) kinds.push(kind);
    }
    return kinds;
  }

  async run(
    kind: ValidationKind,
    options: RunValidationOptions = {}
  ): Promise<ValidationResult> {
    const { signal, onChunk, paths } = options;
    const startedAt = Date.now();
    const scripts = this.scripts();
    const script = SCRIPT_CANDIDATES[kind].find((s) => scripts[s]);
    if (!script) {
      return {
        kind,
        ok: true,
        findings: [],
        rawOutput: `no ${kind} script configured`,
        durationMs: 0,
      };
    }
    const pm = this.packageManager();
    const filters = kind === "test" ? (paths ?? []) : [];
    const args = ["run", script, ...(filters.length > 0 ? ["--", ...filters] : [])];
    // The command itself opens the stream, so a watcher can see what is
    // running rather than only that something is.
    onChunk?.(`$ ${pm} ${args.join(" ")}\n`);

    const child = execa(pm, args, {
      cwd: this.workspaceRoot,
      // npm/pnpm are .cmd shims on Windows — hide the console they open.
      windowsHide: true,
      reject: false,
      all: true,
      forceKillAfterDelay: FORCE_KILL_AFTER_MS,
      // Colour codes would reach the finding parsers below as noise.
      env: { ...process.env, FORCE_COLOR: "0" },
      ...(signal ? { cancelSignal: signal } : {}),
    });

    // A package script is a .cmd shim on Windows and the real runner is its
    // CHILD, so signalling the shim leaves vitest/tsc running and this await
    // never settles — which is what made Stop, and the timeout, do nothing.
    // Both other shell paths in the agent kill the tree; so does this one.
    const killTree = () => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).unref();
      } else {
        child.kill("SIGTERM");
      }
    };
    // execa's own `timeout` signals the shim only, for the same reason.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, RUN_TIMEOUT_MS);
    if (signal?.aborted) killTree();
    else signal?.addEventListener("abort", killTree, { once: true });

    // Accumulated here rather than read from `result.all`: consuming the
    // stream for `onChunk` is what leaves that property empty.
    let output = "";
    child.all?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      onChunk?.(text);
    });

    let result;
    try {
      result = await child;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", killTree);
    }
    const ok = !timedOut && result.exitCode === 0;
    const findings = ok
      ? []
      : kind === "typecheck"
        ? parseTsc(output)
        : kind === "lint"
          ? parseEslint(output)
          : [];
    const tail =
      output.length > RAW_OUTPUT_MAX ? output.slice(-RAW_OUTPUT_MAX) : output;
    return {
      kind,
      ok,
      findings: findings.slice(0, 100),
      rawOutput: timedOut
        ? `${kind} timed out after ${RUN_TIMEOUT_MS / 1000}s\n${tail}`
        : tail,
      durationMs: Date.now() - startedAt,
    };
  }

  private scripts(): Record<string, string> {
    try {
      const raw = fs.readFileSync(
        path.join(this.workspaceRoot, "package.json"),
        "utf8"
      );
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
      return parsed.scripts ?? {};
    } catch {
      return {};
    }
  }

  private packageManager(): string {
    const has = (f: string) => fs.existsSync(path.join(this.workspaceRoot, f));
    if (has("pnpm-lock.yaml")) return "pnpm";
    if (has("yarn.lock")) return "yarn";
    if (has("bun.lockb") || has("bun.lock")) return "bun";
    return "npm";
  }
}

/** tsc: "src/x.ts(12,5): error TS2304: Cannot find name 'y'." */
function parseTsc(output: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    findings.push({
      path: m[1]!.replaceAll("\\", "/"),
      row: Number(m[2]),
      col: Number(m[3]),
      severity: m[4] === "error" ? "error" : "warning",
      message: m[6]!,
      rule: m[5]!,
    });
  }
  return findings;
}

/** eslint stylish: file header line, then "  12:5  error  msg  rule". */
function parseEslint(output: string): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  let currentFile: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!line.startsWith(" ") && /^\S.*\.[cm]?[jt]sx?$/.test(trimmed)) {
      currentFile = trimmed.replaceAll("\\", "/");
      continue;
    }
    const m =
      /^\s+(\d+):(\d+)\s+(error|warn(?:ing)?)\s+(.+?)(?:\s\s+(\S+))?$/.exec(line);
    if (m) {
      findings.push({
        path: currentFile,
        row: Number(m[1]),
        col: Number(m[2]),
        severity: m[3]!.startsWith("error") ? "error" : "warning",
        message: m[4]!.trim(),
        rule: m[5],
      });
    }
  }
  return findings;
}
