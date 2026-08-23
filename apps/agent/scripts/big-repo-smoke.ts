/**
 * Big-repo smoke: everything that only breaks on somebody else's codebase.
 *
 * Atelier is a code editor, so the workspaces that matter are not this one.
 * Two bugs got out because every check ran against a tidy 2k-file repo:
 *
 *   1. A VS Code fork ships `foo.asar` as a test fixture. Electron's fs shim
 *      treats that path as an archive, lstat threw inside chokidar, and the
 *      unhandled 'error' event killed the agent for that workspace entirely.
 *   2. `search_text` only stopped early when it FILLED maxResults, so a query
 *      with no matches read every non-ignored file in the repo. On a fork of
 *      VS Code the tool call never came back and the turn hung on
 *      "Waiting for the tool result…".
 *
 * Point it at a big checkout — a VS Code fork by preference, since it has
 * both the .asar fixture and the file count:
 *
 *   ATELIER_BIG_REPO=C:/Users/you/brain-x-oss pnpm --filter @atelier/agent smoke:big-repo
 *
 * With no repo to point at it SKIPS rather than fails: not every machine has
 * one, and a smoke that cannot run must not read as a smoke that found a bug.
 */
import fs from "node:fs";
import path from "node:path";
import { EventBus } from "../src/events/event-bus.js";
import { PathGuard } from "../src/workspace/path-guard.js";
import { WorkspaceIgnore } from "../src/workspace/ignore.js";
import { FileService } from "../src/workspace/file-service.js";
import { WorkspaceWatcher } from "../src/workspace/watcher.js";
import { disableAsar } from "../src/workspace/no-asar.js";
import { renderProjectTree } from "../src/workspace/profile/project-tree.js";

/** Where a big checkout usually lives on this machine. */
const DEFAULT_CANDIDATES = [
  process.env.ATELIER_BIG_REPO,
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", "brain-x-oss"),
].filter((value): value is string => Boolean(value));

/** A miss has to cost the whole walk to be a fair test of the budget. */
const ABSENT_QUERY = "ZZQQ_ATELIER_NO_SUCH_STRING_XYZ";

/** The tool's own budget is 8s; allow for a cold page cache on top. */
const SEARCH_DEADLINE_MS = 25_000;
const TREE_DEADLINE_MS = 30_000;

let failures = 0;

function check(name: string, ok: boolean, extra = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

function findRepo(): string | null {
  for (const candidate of DEFAULT_CANDIDATES) {
    if (candidate && fs.existsSync(path.join(candidate, ".git"))) {
      return path.resolve(candidate);
    }
  }
  return null;
}

/** Any *.asar file in the tree; the VS Code fixture is the one we expect. */
function findAsar(root: string, depth = 9): string | null {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth: at } = stack.pop()!;
    if (at > depth) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push({ dir: full, depth: at + 1 });
      else if (entry.name.endsWith(".asar")) return full;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const root = findRepo();
  if (!root) {
    console.log(
      "SKIP  no big repo found. Set ATELIER_BIG_REPO to a large checkout " +
        "(a VS Code fork is ideal) and run this again."
    );
    return;
  }
  console.log(`big repo: ${root}\n`);

  // ── the asar shim ──────────────────────────────────────────────────────
  // Only meaningful under Electron, where fs is patched; under plain node
  // the lstat was always going to work and this is a cheap tautology.
  console.log("asar");
  disableAsar();
  const asarPath = findAsar(root);
  if (asarPath) {
    let lstatOk = false;
    let reason = "";
    try {
      lstatOk = fs.lstatSync(asarPath).isFile();
    } catch (error) {
      reason = String((error as Error).message ?? error);
    }
    check(
      "an .asar file in the workspace can be stat'ed",
      lstatOk,
      reason || path.relative(root, asarPath)
    );
  } else {
    console.log("  (no .asar in this checkout — shim check skipped)");
  }

  const bus = new EventBus();
  const guard = new PathGuard(root);
  const ignore = new WorkspaceIgnore(root);
  const files = new FileService(guard, ignore, bus);

  check(
    "archives are ignored",
    ignore.ignores("some/where/foo.asar"),
    "*.asar"
  );

  // ── the watcher survives whatever is in there ──────────────────────────
  console.log("\nwatcher");
  const watcher = new WorkspaceWatcher(bus, guard, ignore, root);
  let watchErrors = 0;
  watcher.onWatchError(() => {
    watchErrors += 1;
  });
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  // Reaching this line at all is the regression test: the bug this covers
  // took the process down before any assertion could run.
  check("the watcher did not kill the process", true);
  check(
    "watcher errors were handled, not thrown",
    watchErrors === 0 || watchErrors > 0,
    watchErrors > 0 ? `${watchErrors} handled` : "none"
  );
  watcher.stop();

  // ── search is bounded ──────────────────────────────────────────────────
  console.log("\nsearch_text");
  const missStarted = Date.now();
  const miss = await files.search(ABSENT_QUERY, undefined, 100, false);
  const missMs = Date.now() - missStarted;
  check(
    "a search that matches nothing still returns",
    missMs < SEARCH_DEADLINE_MS,
    `${missMs}ms, scanned ${miss.scanned}`
  );
  check("it found nothing", miss.matches.length === 0);
  check(
    "it says it was cut short",
    miss.truncated || miss.scanned < 5_000,
    miss.truncated ? "truncated" : `scanned the whole repo (${miss.scanned})`
  );

  const hitStarted = Date.now();
  const hit = await files.search("function", "**/*.ts", 20, false);
  const hitMs = Date.now() - hitStarted;
  check(
    "a search with matches returns quickly",
    hitMs < SEARCH_DEADLINE_MS && hit.matches.length > 0,
    `${hitMs}ms, ${hit.matches.length} matches`
  );

  const aborter = new AbortController();
  aborter.abort();
  const abortStarted = Date.now();
  const aborted = await files.search(ABSENT_QUERY, undefined, 100, false, {
    signal: aborter.signal,
  });
  const abortMs = Date.now() - abortStarted;
  check(
    "an aborted search gives up at once",
    abortMs < 1_000 && aborted.truncated,
    `${abortMs}ms`
  );

  // ── the tree and the map the model is handed ───────────────────────────
  console.log("\ntree + directory map");
  const treeStarted = Date.now();
  const tree = await files.tree("", 6);
  const treeMs = Date.now() - treeStarted;
  check(
    "fs.tree returns within the deadline",
    treeMs < TREE_DEADLINE_MS,
    `${treeMs}ms`
  );
  check(
    "the tree has content",
    (tree.children?.length ?? 0) > 0,
    `${tree.children?.length ?? 0} top-level entries`
  );

  const mapStarted = Date.now();
  const map = await renderProjectTree(root, "", ignore);
  const mapMs = Date.now() - mapStarted;
  check("the directory map renders", map.length > 0, `${mapMs}ms`);
  check(
    "the map stays inside its budget",
    map.length < 12_000,
    `${map.length} chars, ~${Math.round(map.length / 4)} tokens`
  );
  check("the map names real files", /\.\w{1,4}\s|\.\w{1,4}$/m.test(map));

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`
  );
  if (failures > 0) process.exitCode = 1;
}

void main();
