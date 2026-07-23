/**
 * Verifies native modules load on this machine (the #1 Windows trap).
 * Run: pnpm --filter @atelier/agent smoke:native
 */
async function main(): Promise<void> {
  const results: Array<[string, boolean, string]> = [];

  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(x)");
    db.close();
    results.push(["better-sqlite3", true, "ok"]);
  } catch (error) {
    results.push(["better-sqlite3", false, String(error)]);
  }

  try {
    const pty = await import("@lydell/node-pty");
    const shell = process.platform === "win32" ? "powershell.exe" : "bash";
    const proc = pty.spawn(shell, [], { cols: 80, rows: 24 });
    proc.kill();
    results.push(["node-pty", true, "ok"]);
  } catch (error) {
    results.push(["node-pty", false, String(error)]);
  }

  let failed = false;
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
    if (!ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

void main();
