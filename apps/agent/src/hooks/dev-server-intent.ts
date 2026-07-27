export interface DevServerIntent {
  /** Short label for the block message, e.g. "npm run dev". */
  label: string;
  /** The dev runner behind it, when recognised ("next", "vite", …). */
  runner?: string;
  command: string;
  /**
   * Identity for "this session already started it" tracking — the script or
   * runner, not the raw string, so `npm run dev` and `npm  run  dev` match.
   */
  key: string;
  /** Ports it would most likely bind, best guess first. */
  ports: number[];
  /** Whether the ports came from the command or from a framework default. */
  portSource: "explicit" | "default" | "unknown";
}

/**
 * Package-manager script names that start something long-running. Suffixed
 * variants count too (`dev:web`, `start:dev`, `serve-ssr`).
 */
const DEV_SCRIPT_RE = /^(dev|start|serve|preview|watch)([:-][\w:-]*)?$/i;

/**
 * Read-only commands that legitimately mention a runner's name — `cat
 * vite.config.ts` or `rg "npm run dev"` must never count as starting one.
 */
const READ_PREFIX_RE =
  /^\s*(rg|grep|egrep|findstr|select-string|cat|type|head|tail|less|more|git|ls|dir|echo|code|which|where)\b/i;

/**
 * A bare runner name used as a command: at the start of the segment or after
 * a launcher, and not glued to a filename (`vite.config.ts`) or a longer word
 * (`vitest`).
 */
function bare(name: string): RegExp {
  const launcher = "(?:npx|pnpm\\s+exec|pnpm\\s+dlx|yarn|bunx|uv\\s+run)\\s+";
  return new RegExp(`(?:^|\\s)(?:${launcher})?${name}(?![\\w.-])`, "i");
}

interface Runner {
  name: string;
  re: RegExp;
  /** Default listen port, when the runner has a predictable one. */
  port?: number;
  /** One-shot uses of the same binary that must NOT count as a start. */
  not?: RegExp;
}

/** Long-running dev runners and the port each binds by default. */
const RUNNERS: Runner[] = [
  { name: "next", re: /\bnext\s+(dev|start)\b/i, port: 3000 },
  { name: "vite", re: bare("vite"), port: 5173, not: /\bvite\s+build\b/i },
  { name: "nuxt", re: /\bnuxt\s+(dev|start|preview)\b/i, port: 3000 },
  { name: "angular", re: /\bng\s+serve\b/i, port: 4200 },
  { name: "react-scripts", re: /\breact-scripts\s+start\b/i, port: 3000 },
  { name: "remix", re: /\bremix\s+(dev|serve)\b/i, port: 3000 },
  { name: "astro", re: /\bastro\s+(dev|preview)\b/i, port: 4321 },
  { name: "gatsby", re: /\bgatsby\s+(develop|serve)\b/i, port: 8000 },
  { name: "nest", re: /\bnest\s+start\b/i, port: 3000 },
  { name: "storybook", re: /\b(storybook\s+dev|start-storybook)\b/i, port: 6006 },
  { name: "webpack", re: /\b(webpack\s+serve|webpack-dev-server)\b/i, port: 8080 },
  { name: "parcel", re: /\bparcel\s+(serve|watch)\b/i, port: 1234 },
  { name: "expo", re: /\bexpo\s+start\b/i, port: 8081 },
  { name: "metro", re: /\breact-native\s+start\b/i, port: 8081 },
  { name: "django", re: /\bmanage\.py\s+runserver\b/i, port: 8000 },
  { name: "flask", re: /\bflask\s+run\b/i, port: 5000 },
  { name: "uvicorn", re: bare("uvicorn"), port: 8000 },
  { name: "fastapi", re: /\bfastapi\s+dev\b/i, port: 8000 },
  { name: "rails", re: /\brails\s+(s|server)\b/i, port: 3000 },
  { name: "laravel", re: /\bartisan\s+serve\b/i, port: 8000 },
  { name: "php", re: /\bphp\s+-S\b/, port: 8000 },
  { name: "dotnet", re: /\bdotnet\s+(watch|run)\b/i, port: 5000 },
  { name: "air", re: /^air(\s|$)/i, port: 8080 },
  { name: "http-server", re: bare("(?:http-server|serve|live-server)"), port: 8080 },
  // No reliable default port — still a long-running instance.
  { name: "nodemon", re: bare("nodemon") },
  { name: "tsx-watch", re: /\btsx\s+watch\b/i },
  { name: "ts-node-dev", re: bare("ts-node-dev") },
  { name: "node-watch", re: /\bnode\s+--watch\b/i },
  { name: "docker-compose", re: /\bdocker(\s+compose|-compose)\s+up\b/i },
  { name: "flutter", re: /\bflutter\s+run\b/i },
];

/** `--port 3000`, `--port=3000`, `-p 3000`, `PORT=3000`, `:3000`. */
const PORT_PATTERNS = [
  /--port(?:\s+|=)(\d{2,5})\b/i,
  /(?:^|\s)-p\s+(\d{2,5})\b/,
  /\bPORT=(\d{2,5})\b/,
  /--host\s+\S+\s+(\d{2,5})\b/i,
  /\b127\.0\.0\.1:(\d{2,5})\b/,
  /\blocalhost:(\d{2,5})\b/i,
];

/** Splits a compound command so `npm i && npm run dev` is seen as two. */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A `--flag` or `--flag value` pair sitting before the script name. */
const PM_FLAG_RE = /^(--?[\w-]+)(=\S*)?$/;
const FLAGS_WITH_VALUE = new Set([
  "--filter",
  "-F",
  "-C",
  "--dir",
  "--prefix",
  "-w",
  "--workspace",
]);

/**
 * Reads the script name out of a package-manager invocation, skipping the
 * flags that can precede it (`pnpm --filter @app/web dev`). Returns null when
 * the command is not a package-manager script run.
 */
function packageScript(segment: string): string | null {
  const tokens = segment.split(/\s+/).filter(Boolean);
  const pm = tokens.shift()?.toLowerCase();
  if (!pm || !["npm", "pnpm", "yarn", "bun", "npx", "deno"].includes(pm)) {
    return null;
  }
  while (tokens.length > 0) {
    const token = tokens[0]!;
    if (token === "run" || token === "run-script" || token === "task") {
      tokens.shift();
      continue;
    }
    if (PM_FLAG_RE.test(token)) {
      tokens.shift();
      // `--filter <value>`: drop the value too, unless it was `--filter=x`.
      if (FLAGS_WITH_VALUE.has(token) && tokens.length > 0) tokens.shift();
      continue;
    }
    break;
  }
  const script = tokens.shift();
  return script ?? null;
}

function findPort(text: string): number | null {
  for (const re of PORT_PATTERNS) {
    const matched = re.exec(text);
    if (!matched) continue;
    const port = Number(matched[1]);
    if (port >= 10 && port <= 65_535) return port;
  }
  return null;
}

function findRunner(text: string): Runner | null {
  for (const runner of RUNNERS) {
    if (runner.not?.test(text)) continue;
    if (runner.re.test(text)) return runner;
  }
  return null;
}

/**
 * Recognises an attempt to START a long-running dev server — a package
 * script (`npm run dev`, `pnpm start`), a framework runner (`next dev`,
 * `vite`, `ng serve`), or a watcher (`nodemon`, `docker compose up`).
 *
 * `scripts` is the workspace package.json "scripts" map, when available: it
 * lets `npm run dev` be resolved to the real command so the runner and port
 * behind the alias are known. One-shot commands (`npm run build`, `npm test`,
 * `vite build`) return null and stay free.
 */
export function detectDevServerIntent(
  toolName: string,
  input: unknown,
  scripts: Record<string, string> = {}
): DevServerIntent | null {
  if (toolName !== "run_terminal") return null;
  const i = (input ?? {}) as Record<string, unknown>;
  const command = typeof i.command === "string" ? i.command.trim() : "";
  if (!command) return null;

  for (const segment of segments(command)) {
    // Reading or searching for a dev command is not running one.
    if (READ_PREFIX_RE.test(segment)) continue;
    const script = packageScript(segment);
    if (script && DEV_SCRIPT_RE.test(script)) {
      // The script body names the real runner and often a pinned port.
      const body = scripts[script] ?? "";
      const runner = findRunner(`${body} ${segment}`);
      const explicit = findPort(segment) ?? findPort(body);
      return {
        label: segment.slice(0, 120),
        runner: runner?.name,
        command: command.slice(0, 400),
        key: `script:${script.toLowerCase()}`,
        ports: pickPorts(explicit, runner?.port),
        portSource: portSource(explicit, runner?.port),
      };
    }
    const runner = findRunner(segment);
    if (runner) {
      const explicit = findPort(segment);
      return {
        label: segment.slice(0, 120),
        runner: runner.name,
        command: command.slice(0, 400),
        key: `runner:${runner.name}`,
        ports: pickPorts(explicit, runner.port),
        portSource: portSource(explicit, runner.port),
      };
    }
  }
  return null;
}

function pickPorts(explicit: number | null, fallback?: number): number[] {
  if (explicit !== null) return [explicit];
  return fallback !== undefined ? [fallback] : [];
}

function portSource(
  explicit: number | null,
  fallback?: number
): DevServerIntent["portSource"] {
  if (explicit !== null) return "explicit";
  return fallback !== undefined ? "default" : "unknown";
}
