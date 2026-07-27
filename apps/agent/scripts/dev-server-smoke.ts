/**
 * Dev-server guard smoke: which commands count as starting a dev server,
 * and when a start is refused as a duplicate.
 *
 *   pnpm --filter @atelier/agent smoke:dev-server
 */
import { EventBus } from "../src/events/event-bus.js";
import { DevServerGuard } from "../src/hooks/dev-server-guard.js";
import { detectDevServerIntent } from "../src/hooks/dev-server-intent.js";
import type { HookConfig } from "@atelier/protocol";

/** Stand-in for the workspace package.json the guard would read. */
const SCRIPTS: Record<string, string> = {
  dev: "next dev",
  "dev:api": "nodemon --watch src server.js",
  start: "next start -p 4000",
  build: "next build",
  test: "vitest run",
  lint: "eslint .",
};

interface DetectCase {
  name: string;
  command: string;
  expectDetected: boolean;
  expectPort?: number;
}

const DETECT_CASES: DetectCase[] = [
  {
    name: "npm run dev -> detected, next default 3000",
    command: "npm run dev",
    expectDetected: true,
    expectPort: 3000,
  },
  {
    name: "npm start -> detected, port from the script body",
    command: "npm start",
    expectDetected: true,
    expectPort: 4000,
  },
  {
    name: "pnpm dev (no 'run') -> detected",
    command: "pnpm dev",
    expectDetected: true,
    expectPort: 3000,
  },
  {
    name: "yarn dev --port 4300 -> explicit port wins",
    command: "yarn dev --port 4300",
    expectDetected: true,
    expectPort: 4300,
  },
  {
    name: "pnpm --filter @app/web dev -> flags skipped",
    command: "pnpm --filter @app/web dev",
    expectDetected: true,
  },
  {
    name: "npm run dev:api -> suffixed script detected",
    command: "npm run dev:api",
    expectDetected: true,
  },
  {
    name: "vite -> detected, 5173",
    command: "vite",
    expectDetected: true,
    expectPort: 5173,
  },
  { name: "ng serve -> detected, 4200", command: "ng serve", expectDetected: true, expectPort: 4200 },
  {
    name: "python manage.py runserver -> detected, 8000",
    command: "python manage.py runserver",
    expectDetected: true,
    expectPort: 8000,
  },
  {
    name: "docker compose up -> detected, no port",
    command: "docker compose up",
    expectDetected: true,
  },
  {
    name: "npm install && npm run dev -> compound detected",
    command: "npm install && npm run dev",
    expectDetected: true,
    expectPort: 3000,
  },
  { name: "npm run build -> ignored", command: "npm run build", expectDetected: false },
  { name: "vite build -> ignored", command: "vite build", expectDetected: false },
  { name: "npm test -> ignored", command: "npm test", expectDetected: false },
  { name: "npm run lint -> ignored", command: "npm run lint", expectDetected: false },
  { name: "git status -> ignored", command: "git status", expectDetected: false },
  {
    name: "grep for 'npm run dev' in docs -> ignored",
    command: 'rg "npm run dev" README.md',
    expectDetected: false,
  },
  {
    name: "cat vite.config.ts -> ignored (filename, not a start)",
    command: "cat vite.config.ts",
    expectDetected: false,
  },
  {
    name: "node scripts/serve-docs.js -> ignored (not the serve binary)",
    command: "node scripts/serve-docs.js",
    expectDetected: false,
  },
  {
    name: "vitest run -> ignored (not vite)",
    command: "vitest run",
    expectDetected: false,
  },
  {
    name: "npm run test:watch -> ignored (watcher, not a server)",
    command: "npm run test:watch",
    expectDetected: false,
  },
  {
    name: "npx vite --port 4000 -> detected via launcher",
    command: "npx vite --port 4000",
    expectDetected: true,
    expectPort: 4000,
  },
];

function runDetection(): number {
  let failed = 0;
  for (const c of DETECT_CASES) {
    const intent = detectDevServerIntent(
      "run_terminal",
      { command: c.command },
      SCRIPTS
    );
    const detected = intent !== null;
    let pass = detected === c.expectDetected;
    if (pass && c.expectPort !== undefined) {
      pass = intent?.ports[0] === c.expectPort;
    }
    if (!pass) failed += 1;
    const got = intent
      ? `runner=${intent.runner ?? "?"} ports=[${intent.ports.join(",")}]`
      : "not detected";
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.name}`);
    if (!pass) console.log(`      got: ${got}`);
  }
  return failed;
}

const HOOK: HookConfig = {
  id: "builtin-dev-server",
  name: "Dev server",
  enabled: true,
  event: "preTool",
  matcher: "run_terminal",
  action: "block",
};

async function check(
  guard: DevServerGuard,
  command: string
): Promise<{ blocked: boolean; reason?: string }> {
  const verdict = await guard.check({
    toolName: "run_terminal",
    input: { command },
    taskId: "t-dev",
    hook: HOOK,
  });
  return { blocked: verdict?.allowed === false, reason: verdict?.reason };
}

/** A movable clock, so the smoke can cross the guard's timing windows. */
const clock = { t: 1_000_000 };

/** The port probe is injected so the smoke never touches the real network. */
function guardWith(listening: number[]): DevServerGuard {
  const open = new Set(listening);
  return new DevServerGuard(
    new EventBus(),
    process.cwd(),
    async (port) => open.has(port),
    () => clock.t
  );
}

async function runDecisions(): Promise<number> {
  let failed = 0;
  const expect = (name: string, pass: boolean, detail?: string) => {
    if (!pass) failed += 1;
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass && detail) console.log(`      ${detail}`);
  };

  // Nothing listening: the first start must go through.
  const free = guardWith([]);
  const first = await check(free, "npm run dev");
  expect("nothing running -> first start allowed", !first.blocked, first.reason);

  // ...and the second start of the same script is a duplicate, even though
  // no port was ever probed as taken.
  const second = await check(free, "npm run dev");
  expect(
    "same session, second start -> BLOCKED",
    second.blocked,
    second.reason ?? "was allowed"
  );

  // A server the user started outside Atelier: port already listening.
  const taken = guardWith([3000]);
  const occupied = await check(taken, "next dev");
  expect(
    "port already listening -> BLOCKED",
    occupied.blocked,
    occupied.reason ?? "was allowed"
  );
  const mentionsPort = occupied.reason?.includes("3000") ?? false;
  expect("block reason names the port", mentionsPort, occupied.reason);

  // A different port is not a duplicate.
  const elsewhere = await check(taken, "next dev --port 3001");
  expect(
    "different port -> allowed",
    !elsewhere.blocked,
    elsewhere.reason
  );

  // Non-dev commands are never touched, however many servers are up.
  const build = await check(taken, "npm run build");
  expect("build with a server running -> allowed", !build.blocked, build.reason);

  return failed;
}

async function main(): Promise<void> {
  let failed = runDetection();
  console.log();
  failed += await runDecisions();
  console.log(failed === 0 ? "\nall cases pass" : `\n${failed} case(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
