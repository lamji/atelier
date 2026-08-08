import { ShellSession } from "../src/tools/shell-session.js";

const log = {
  debug() {},
  info() {},
} as unknown as import("pino").Logger;

const session = new ShellSession(process.cwd(), log);
const ac = new AbortController();

async function run(command: string) {
  const started = Date.now();
  const result = await session.run(
    command,
    process.cwd(),
    10_000,
    ac.signal,
    () => {}
  );
  console.log(
    `[${Date.now() - started}ms] exit=${result.exitCode} timedOut=${result.timedOut} ` +
      `out=${JSON.stringify(result.output.trim().slice(0, 60))}`
  );
}

await run("Write-Output hello");
await run("node -e \"console.log(2+2)\"");
await run("cmd /c exit 3");
await run("Get-ChildItem -LiteralPath does-not-exist");
await run("Write-Output done");
session.dispose();
