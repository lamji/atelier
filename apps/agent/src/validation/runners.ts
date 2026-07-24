import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type {
  ValidationFinding,
  ValidationKind,
  ValidationResult,
} from "@atelier/protocol";

const RUN_TIMEOUT_MS = 240_000;
const RAW_OUTPUT_MAX = 4000;

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
    signal?: AbortSignal
  ): Promise<ValidationResult> {
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
    const result = await execa(pm, ["run", script], {
      cwd: this.workspaceRoot,
      timeout: RUN_TIMEOUT_MS,
      reject: false,
      all: true,
      ...(signal ? { cancelSignal: signal } : {}),
    });
    const output = String(result.all ?? "");
    const ok = result.exitCode === 0;
    const findings = ok
      ? []
      : kind === "typecheck"
        ? parseTsc(output)
        : kind === "lint"
          ? parseEslint(output)
          : [];
    return {
      kind,
      ok,
      findings: findings.slice(0, 100),
      rawOutput:
        output.length > RAW_OUTPUT_MAX ? output.slice(-RAW_OUTPUT_MAX) : output,
      durationMs: Date.now() - startedAt,
    };
  }

  async runTests(
    _paths?: string[],
    signal?: AbortSignal
  ): Promise<ValidationResult> {
    return this.run("test", signal);
  }

  async runLint(
    _paths?: string[],
    signal?: AbortSignal
  ): Promise<ValidationResult> {
    return this.run("lint", signal);
  }

  async runTypecheck(signal?: AbortSignal): Promise<ValidationResult> {
    return this.run("typecheck", signal);
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
