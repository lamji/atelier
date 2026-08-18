/**
 * Proves the feature wiki end to end, offline:
 *  - a page round-trips through parse/serialize with sources and links;
 *  - the store matches pages by prompt words and by the turn's files,
 *    and reports which sources moved since the page was verified;
 *  - the compiler updates a page in place from a fake model, recomputes
 *    sources from the paths the page cites, keeps the slug, and refuses
 *    a page with no Flow section;
 *  - the context rendering flags stale sources by name.
 * Plain tsx is enough (no DB).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import {
  WikiCompiler,
  WikiStore,
  WIKI_FEATURES_DIR,
  WIKI_SCHEMA_FILE,
  inspectWiki,
  parseWikiPage,
  pathsMentioned,
  renderWikiPageForContext,
  serializeWikiPage,
} from "../src/knowledge/wiki/index.js";

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? "ok" : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-wiki-"));
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
write("src/auth/login.ts", "export function login() {}\n");
write("src/api/session.ts", "export const session = 1;\n");
write("src/pages/Cud3Page.tsx", "export default function Cud3Page() {}\n");

const store = new WikiStore(root);

// 1. Round trip.
const seed = parseWikiPage(
  "login",
  [
    "---",
    "feature: Login",
    "slug: login",
    "status: fresh",
    "aliases: [auth, sign in]",
    "links:",
    "  - session-cookie",
    "sources:",
    `  - "src/auth/login.ts @ ${store.hashOf("src/auth/login.ts")}"`,
    "---",
    "# Login",
    "## Purpose",
    "Signs the user in.",
    "## Flow",
    "1. src/auth/login.ts:1 login() posts to src/api/session.ts:1",
    "See also [[user-store]].",
    "",
  ].join("\n")
);
check(seed.title === "Login" && seed.aliases.length === 2, "frontmatter parsed");
check(
  seed.links.includes("session-cookie") && seed.links.includes("user-store"),
  "links merge frontmatter and [[wikilinks]]"
);
check(seed.sources.length === 1 && seed.sources[0]!.path === "src/auth/login.ts", "sources parsed");
const again = parseWikiPage("login", serializeWikiPage(seed));
check(
  again.title === seed.title &&
    again.sources[0]!.hash === seed.sources[0]!.hash &&
    again.body.includes("## Flow"),
  "serialize/parse round-trips"
);
store.save({ ...seed, updatedAt: 1 });
check(fs.existsSync(path.join(root, WIKI_SCHEMA_FILE)), "schema written beside the pages");
check(
  pathsMentioned(seed.body).sort().join(",") === "src/api/session.ts,src/auth/login.ts",
  "pathsMentioned finds cited paths without line numbers"
);

// 2. Matching + staleness.
const byWords = store.match({ terms: ["fix", "the", "sign", "auth"], files: [] });
check(byWords.length === 1 && byWords[0]!.page.slug === "login", "match by alias words");
check(
  store.match({ terms: ["something"], files: ["src/auth/login.ts"] }).length === 0,
  "one incidental file hit is not enough"
);
check(
  store.match({ terms: ["something"], files: [], namedFiles: ["src/auth/login.ts"] }).length === 1,
  "a file the user named matches on its own"
);
check(store.match({ terms: ["billing"], files: [] }).length === 0, "unrelated prompt matches nothing");
check(store.moved(store.get("login")!).length === 0, "fresh page: nothing moved");
write("src/auth/login.ts", "export function login() { changed }\n");
const moved = store.moved(store.get("login")!);
check(moved.length === 1 && moved[0] === "src/auth/login.ts", "edited source is reported as moved");
const rendered = renderWikiPageForContext(store.get("login")!, moved, 400);
check(
  rendered.includes("STALE") && rendered.includes("src/auth/login.ts") && rendered.includes("## Flow"),
  "context rendering names the moved source and keeps the flow"
);
check(store.pagesForFiles(["src/auth/login.ts"]).length === 1, "pagesForFiles finds the owner page");

// 3. Compiler with a fake model.
let lastPrompt = "";
const compiler = new WikiCompiler({
  store,
  log: pino({ level: "silent" }),
  oneShot: async (_system, prompt) => {
    lastPrompt = prompt;
    return [
      "```markdown",
      "---",
      "feature: Login (renamed by model)",
      "slug: something-else",
      "status: fresh",
      "aliases: [auth, sign in, sso]",
      "---",
      "# Login",
      "## Purpose",
      "Signs the user in, now with SSO.",
      "## Flow",
      "1. src/auth/login.ts:1 login() posts to src/api/session.ts:1",
      "2. src/pages/Cud3Page.tsx:1 renders the result",
      "## History",
      "- 2026-08-17 added SSO (src/auth/login.ts)",
      "```",
    ].join("\n");
  },
});
const result = await compiler.compile({
  taskId: "task-1",
  request: "add sso to login",
  report: "Added SSO.",
  changedFiles: ["src/auth/login.ts"],
  readPaths: ["src/api/session.ts"],
  planSteps: [{ title: "add sso", files: ["src/auth/login.ts"], status: "done" }],
  diff: "+ sso",
  candidates: [store.get("login")!],
});
check(result !== null && result.page.slug === "login", "existing slug is kept despite a retitle");
check(
  result !== null &&
    result.page.sources.map((s) => s.path).sort().join(",") ===
      "src/api/session.ts,src/auth/login.ts,src/pages/Cud3Page.tsx",
  "sources recomputed from cited paths + changed files"
);
check(result !== null && result.page.aliases.includes("sso") && result.page.aliases.includes("auth"), "aliases merged");
check(
  result !== null && result.changedSections.includes("Purpose") && result.changedSections.includes("History"),
  `changed sections detected: ${result?.changedSections.join(",")}`
);
check(store.moved(store.get("login")!).length === 0, "recompiled page is fresh again");
check(lastPrompt.includes("EXISTING PAGE") && lastPrompt.includes("+ sso"), "prompt carries the page and the diff");
check(!result?.created, "update is not reported as a create");

// New page path + rejection.
const fresh = new WikiCompiler({
  store,
  log: pino({ level: "silent" }),
  oneShot: async () => "---\nfeature: Billing\n---\n# Billing\n## Purpose\nno flow here",
});
check(
  (await fresh.compile({
    taskId: "t2",
    request: "x",
    report: "",
    changedFiles: [],
    readPaths: [],
    planSteps: [],
    diff: "",
    candidates: [],
  })) === null,
  "a page without a Flow section is refused"
);
const creator = new WikiCompiler({
  store,
  log: pino({ level: "silent" }),
  oneShot: async () =>
    "---\nfeature: CUD Impact\naliases: [cud3]\n---\n# CUD Impact\n## Purpose\nx\n## Flow\n1. src/pages/Cud3Page.tsx:1 page",
});
const created = await creator.compile({
  taskId: "t3",
  request: "fix cud impact empty state",
  report: "",
  changedFiles: ["src/pages/Cud3Page.tsx"],
  readPaths: [],
  planSteps: [],
  diff: "",
  candidates: [],
});
check(created?.created === true && created.page.slug === "cud-impact", "new page created with a slug from the title");
check(fs.existsSync(path.join(root, WIKI_FEATURES_DIR, "cud-impact.md")), "new page file exists");
check(store.list().length === 2, "store lists both pages");

// 4. Lint.
fs.rmSync(path.join(root, "src/api/session.ts"));
const report = inspectWiki(store);
check(report.pages.length === 2 && report.pages[0]!.slug === "cud-impact", "inspect lists pages newest first");
const login = report.pages.find((p) => p.slug === "login")!;
check(login.status === "stale" && login.moved.some((m) => m.includes("session.ts")), "inspect reports live staleness");
check(
  report.lint.some((f) => f.kind === "missing-source" && f.slug === "login") &&
    report.lint.some((f) => f.kind === "broken-link" && f.detail.includes("session-cookie")),
  `lint finds the missing source and the broken links: ${report.lint.map((f) => f.kind).join(",")}`
);

fs.rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("wiki smoke passed");
