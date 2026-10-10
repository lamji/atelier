/**
 * Verifies the session working set (anchors, named paths — and that NO
 * project lock is produced any more) and multi-repo git routing against a
 * REAL container folder — one that is not itself a git repo but holds
 * several checkouts side by side, which is the shape both bugs needed.
 *
 * Run: pnpm --filter @atelier/agent smoke:scope
 *   optionally: tsx scripts/scope-smoke.ts <containerRoot> <projectName>
 */
import path from "node:path";
import Database from "better-sqlite3";
import fs from "node:fs";
import { EventBus } from "../src/events/event-bus.js";
import { GitService } from "../src/git/git-service.js";
import { findRepoRoot, listRepoRoots } from "../src/git/repo-locator.js";
import { ScopeGuard } from "../src/tools/scope-guard.js";
import { WorkspaceIgnore } from "../src/workspace/ignore.js";
import {
  detectWorkspaceProfile,
  renderProjectTree,
} from "../src/workspace/profile/index.js";
import {
  SessionScopeStore,
  inScope,
  parseMentions,
  renderScope,
  scopeGlob,
  workingSet,
} from "../src/workspace/scope/index.js";

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const CONTAINER =
  process.argv[2] ?? path.join(HOME, "Documents", "DigitalFuture2");

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** In-memory DB carrying only the tables the scope store touches. */
function memoryDb() {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE conversation_scope (conversation_id TEXT PRIMARY KEY," +
      " roots TEXT NOT NULL, anchors TEXT NOT NULL, updated_at INTEGER NOT NULL)"
  );
  return db;
}

/** First child of the container that is its own checkout. */
function pickProject(root: string): string | null {
  const repos = listRepoRoots(root).filter((repo) => repo !== root);
  const first = repos[0];
  return first ? path.basename(first) : null;
}

/** Another checkout, for the two-folder lock. */
function pickSecondProject(root: string, exclude: string): string | null {
  const other = listRepoRoots(root)
    .map((repo) => path.basename(repo))
    .find((name) => name !== exclude && name !== path.basename(root));
  return other ?? null;
}

async function main(): Promise<void> {
  if (!fs.existsSync(CONTAINER)) {
    console.log(`skipped — no container folder at ${CONTAINER}`);
    return;
  }
  const project = process.argv[3] ?? pickProject(CONTAINER);
  if (!project) {
    console.log(`skipped — no checkouts inside ${CONTAINER}`);
    return;
  }
  console.log(`container: ${CONTAINER}`);
  console.log(`project:   ${project}\n`);

  // ── mentions ─────────────────────────────────────────────────────────
  console.log("mentions");
  const prompt = `Do this exactly - look how @${project}/ shows the badge`;
  const mentions = parseMentions(prompt, CONTAINER);
  check(
    "folder mention is parsed",
    mentions.some((m) => m.path === project && m.isDir),
    JSON.stringify(mentions.map((m) => m.path))
  );
  check(
    "an email-looking @ is ignored",
    parseMentions("ping me @someone.dev about it", CONTAINER).length === 0
  );
  check(
    "a nonexistent path never locks",
    parseMentions("@no-such-project/src", CONTAINER).length === 0
  );

  // ── no lock, anchors only ────────────────────────────────────────────
  // Project locking was removed on 2026-08-29: a mention is a subject and
  // an anchor, never a boundary. These pin that nothing produces roots.
  console.log("\nno scope lock");
  const db = memoryDb();
  const store = new SessionScopeStore(db, CONTAINER);
  const profile = await detectWorkspaceProfile(CONTAINER);
  check(
    "container is multi-project",
    profile.kind === "multi-project" || profile.kind === "monorepo",
    profile.kind
  );

  const first = store.resolve("conv1", prompt, profile);
  check(
    "a folder mention never locks",
    first.roots.length === 0,
    JSON.stringify(first.roots)
  );

  // The follow-up from the screenshot: no path named at all.
  const followUp = store.resolve("conv1", "add bg to each badge", profile);
  check("a follow-up inherits no lock", followUp.roots.length === 0);
  check("nothing is labelled inherited", followUp.source !== "inherited");

  store.noteTouched("conv1", `${project}/src/components/ui/badge.tsx`);
  const anchored = store.resolve("conv1", "now make it bold", profile);
  check(
    "touched file becomes an anchor",
    anchored.anchors.includes(`${project}/src/components/ui/badge.tsx`),
    JSON.stringify(anchored.anchors)
  );
  check(
    "an unrelated conversation is not locked",
    store.resolve("conv2", "hello", profile).roots.length === 0
  );
  check(
    "retrieval is never clamped by a glob",
    scopeGlob(anchored) === undefined,
    String(scopeGlob(anchored))
  );
  check(
    "no LOCKED block is rendered",
    !renderScope(anchored, workingSet(anchored, [])).includes("LOCKED")
  );
  check(
    "every path is in scope",
    inScope(anchored, "some-other-project/src/x.ts")
  );

  // ── anchors expire unless the turn re-earns them ─────────────────────
  // The drift this closes: one edit to the wrong file used to pin that
  // file to the top of the anchor list, from where it was ranked as a
  // target and printed as "the files we are working on" for the rest of
  // the session — so every later turn inherited the mistake.
  const wrong = `${project}/src/i18n/translations.ts`;
  const right = `${project}/src/lib/apiErrorMiddleware.ts`;
  store.noteTouched("conv1", wrong);
  const drifted = store.resolve("conv1", "still not fixed", profile);
  check("the wrong file is stored as an anchor", drifted.anchors[0] === wrong);
  check(
    "an anchor this turn's retrieval confirms survives",
    workingSet(drifted, [right, wrong]).includes(wrong)
  );
  check(
    "an anchor this turn never surfaced falls out",
    !workingSet(drifted, [right]).includes(wrong),
    JSON.stringify(workingSet(drifted, [right]))
  );
  check(
    "a turn with no evidence at all still inherits recent anchors",
    workingSet(drifted, []).includes(wrong)
  );
  check(
    "the recency fallback is a short tail, not the whole history",
    workingSet(drifted, []).length <= 4,
    String(workingSet(drifted, []).length)
  );
  // Hand-built rather than store-resolved: `named` only ever holds paths
  // that exist on disk, and this case has to hold on any machine.
  const named = { ...drifted, named: [right] };
  const set = workingSet(named, [wrong, right]);
  check(
    "a path named this turn leads the working set",
    set[0] === right,
    JSON.stringify(set)
  );
  check(
    "the named path is stated as the subject",
    renderScope(named, set).includes("NAMED THESE PATHS IN THIS MESSAGE")
  );
  check(
    "history that rode along is labelled a lead, not the subject",
    !set.includes(wrong) || renderScope(named, set).includes("leads only"),
    JSON.stringify(set)
  );

  // ── explicit lock requests (the git wizard's fix agent) are no-ops ───
  const explicit = store.lock("conv3", [project]);
  check(
    "an explicit lock request confines nothing",
    explicit.roots.length === 0,
    JSON.stringify(explicit.roots)
  );
  check(
    "and nothing sticks for follow-ups",
    store.resolve("conv3", "still failing, try again", profile).roots.length === 0
  );
  check(
    "a sibling checkout stays in scope",
    inScope(explicit, `${pickSecondProject(CONTAINER, project) ?? "other"}/.git/config`)
  );

  // ── tool boundary: nothing is bound, nothing is refused ──────────────
  console.log("\ntool guard");
  const guard = new ScopeGuard();
  guard.bind("task1", anchored);
  const inside = `${project}/src/components/ui/badge.tsx`;
  const outside = "some-other-project/src/components/ui/badge.tsx";

  const refused = (tool: string, input: unknown): boolean => {
    try {
      guard.check(tool, input, "task1");
      return false;
    } catch {
      return true;
    }
  };
  check("a read inside the project is allowed", !refused("read_file", { path: inside }));
  check("a read in another project is allowed", !refused("read_file", { path: outside }));
  check(
    "a write in another project is allowed",
    !refused("write_file", { path: outside, content: "x" })
  );
  const clamped = guard.check("search_workspace", { query: "badge" }, "task1");
  check(
    "search is not clamped",
    (clamped as { glob?: string }).glob === undefined,
    String((clamped as { glob?: string }).glob)
  );

  const second = pickSecondProject(CONTAINER, project);
  if (second) {
    const both = store.resolve(
      "conv3",
      `compare @${project}/ with @${second}/`,
      profile
    );
    check(
      "two mentions lock nothing either",
      both.roots.length === 0,
      JSON.stringify(both.roots)
    );
    check(
      "every project is in scope",
      inScope(both, `${project}/src/x.ts`) &&
        inScope(both, `${second}/src/x.ts`) &&
        inScope(both, "some-other-project/src/x.ts")
    );
  }
  guard.release("task1");

  // ── git routing ──────────────────────────────────────────────────────
  console.log("\ngit routing");
  const repos = listRepoRoots(CONTAINER);
  check("checkouts are discovered", repos.length > 0, `${repos.length} found`);
  check(
    "a file routes to its own checkout",
    findRepoRoot(CONTAINER, inside) === path.join(CONTAINER, project),
    String(findRepoRoot(CONTAINER, inside))
  );

  const git = new GitService(CONTAINER, new EventBus());
  await git.start();
  // A container folder has no repo of its own, so the panel must still
  // open on something rather than an error.
  const fallback = git.activeRepo;
  check(
    "a default checkout is selected on start",
    fallback !== null,
    String(fallback)
  );
  check(
    "the default is a real checkout",
    repos.some((repo) => path.basename(repo) === fallback),
    String(fallback)
  );

  await git.focus(project);
  check("git focuses the locked checkout", git.activeRepo === project, String(git.activeRepo));

  try {
    const status = await git.status();
    check("git status succeeds in a container folder", true, `branch ${status.branch}`);
    const stray = status.files.find((file) => !file.path.startsWith(`${project}/`));
    check(
      "status paths come back workspace-relative",
      status.files.length === 0 || stray === undefined,
      stray ? stray.path : `${status.files.length} file(s)`
    );
  } catch (error) {
    check("git status succeeds in a container folder", false, String(error));
  }

  try {
    await git.log(1, "definitely-not-a-repo");
    check("unroutable git names the candidates", false, "no error thrown");
  } catch (error) {
    const message = String(error);
    check(
      "unroutable git names the candidates",
      message.includes(project),
      message.slice(0, 120)
    );
  }

  // ── repo tabs ────────────────────────────────────────────────────────
  console.log("\nrepo tabs");
  const tabs = await git.repos();
  check("one entry per checkout", tabs.length === repos.length, `${tabs.length}`);
  check(
    "every entry has a branch",
    tabs.every((tab) => tab.branch !== null),
    tabs.map((tab) => `${tab.name}:${tab.branch}`).join(", ")
  );
  check(
    "exactly one entry is active",
    tabs.filter((tab) => tab.active).length === 1,
    tabs.find((tab) => tab.active)?.name ?? "none"
  );
  check(
    "entry paths are workspace-relative",
    tabs.every((tab) => !tab.path.includes(":") && !tab.path.includes("\\")),
    tabs.map((tab) => tab.path).join(", ")
  );

  const other = tabs.find((tab) => !tab.active);
  if (other) {
    const selected = await git.select(other.path);
    check("selecting an entry switches repo", selected === other.path, selected);
    const afterSelect = await git.repos();
    check(
      "the selected entry becomes active",
      afterSelect.find((tab) => tab.active)?.path === other.path
    );
    check(
      "status follows the selection",
      (await git.status()).branch === other.branch,
      String(other.branch)
    );
  }

  // ── directory map ────────────────────────────────────────────────────
  console.log("\ndirectory map");
  const ig = new WorkspaceIgnore(CONTAINER);
  const tree = await renderProjectTree(CONTAINER, project, ig);
  check("map is produced", tree.length > 0);
  check("map skips node_modules", !tree.includes("node_modules"));
  const depth3 = tree.split("\n").some((line) => line.startsWith("    "));
  check("map reaches depth 3", depth3);
  console.log(`\n${tree.split("\n").slice(0, 14).join("\n")}`);

  console.log(
    `\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`
  );
  // The .git watcher holds the event loop open; this is a script, not a
  // service, so drop it rather than waiting on process teardown.
  git.stop();
  db.close();
  if (failures > 0) process.exitCode = 1;
}

void main();
