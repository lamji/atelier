/**
 * Exercises the Ollama-only edit repair against a REAL throwaway workspace:
 * the whitespace drift a local model produces, the already-applied no-op
 * that used to loop forever, and the guards that keep leniency from putting
 * an edit in the wrong place.
 *
 * Run: pnpm --filter @atelier/agent smoke:ollama-edit
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/events/event-bus.js";
import { FileService } from "../src/workspace/file-service.js";
import { WorkspaceIgnore } from "../src/workspace/ignore.js";
import { PathGuard } from "../src/workspace/path-guard.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { registerFsTools } from "../src/tools/fs-tools.js";
import {
  atelierToolsFor,
  groundedToolsFor,
  runCall,
  type EditGrounding,
} from "../src/providers/ollama/agent-loop.js";
import {
  editsOf,
  explainEditFailure,
  matchEdit,
  prepareEdit,
} from "../src/providers/ollama/edit-repair.js";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const SOURCE = [
  "export function Composer() {",
  "  return (",
  "    <div className=\"composer\">",
  "      <Button variant=\"solid\" onClick={send}>",
  "        Send",
  "      </Button>",
  "    </div>",
  "  );",
  "}",
  "",
].join("\n");

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-oedit-"));
  const bus = new EventBus();
  const files = new FileService(
    new PathGuard(root),
    new WorkspaceIgnore(root),
    bus
  );
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const rel = "src/composer.tsx";
  await fs.writeFile(path.join(root, rel), SOURCE, "utf8");
  console.log(`workspace: ${root}\n`);

  // --- pure matcher -------------------------------------------------------

  const exact = matchEdit(SOURCE, "        Send\n", "        Post\n");
  check("exact text still matches exactly", exact?.tier === "exact", exact?.tier);

  // The model retyped the line and lost the trailing spaces.
  const withTrailing = SOURCE.replace("  return (", "  return (   ");
  const trailing = matchEdit(withTrailing, "  return (\n", "  return null; (\n");
  check(
    "trailing whitespace drift matches",
    trailing?.tier === "trailing-space" && trailing.count === 1,
    trailing?.tier
  );
  check(
    "trailing match reports the file's own bytes",
    trailing?.oldString === "  return (   \n",
    JSON.stringify(trailing?.oldString)
  );

  // The model dedented the block to its own taste.
  const dedented = [
    "<Button variant=\"solid\" onClick={send}>",
    "  Send",
    "</Button>",
    "",
  ].join("\n");
  const replacement = [
    "<Button variant=\"ghost\" onClick={send}>",
    "  Send",
    "</Button>",
    "",
  ].join("\n");
  const indent = matchEdit(SOURCE, dedented, replacement);
  check(
    "re-indented block matches",
    indent?.tier === "indent" && indent.count === 1,
    indent?.tier
  );
  check(
    "replacement is re-indented to the file",
    indent?.newString.startsWith("      <Button variant=\"ghost\"") === true,
    JSON.stringify(indent?.newString.slice(0, 40))
  );
  check(
    "matched text is the file's real indentation",
    indent?.oldString.startsWith("      <Button variant=\"solid\"") === true,
    JSON.stringify(indent?.oldString.slice(0, 40))
  );

  // A CRLF file must still take an LF edit (the shared matcher's job).
  const crlf = SOURCE.replace(/\n/g, "\r\n");
  const eol = matchEdit(crlf, "        Send\n", "        Post\n");
  check("CRLF file takes an LF edit", eol?.tier === "eol", eol?.tier);
  check(
    "CRLF replacement keeps the file's endings",
    eol?.newString.includes("\r\n") === true
  );

  // Ambiguity must NOT be repaired into a guess.
  const twice = `${SOURCE}\n${SOURCE}`;
  const ambiguous = matchEdit(twice, "  return (\n", "  return null;\n");
  check(
    "an ambiguous match reports its count",
    (ambiguous?.count ?? 0) > 1,
    String(ambiguous?.count)
  );

  // --- prepareEdit against the real file ----------------------------------

  const prepared = await prepareEdit(files, {
    path: rel,
    oldString: dedented,
    newString: replacement,
  });
  check("drifted edit is prepared as ready", prepared.status === "ready");
  if (prepared.status === "ready") {
    const applied = await files.replaceCode(
      rel,
      prepared.input.oldString,
      prepared.input.newString
    );
    check("the repaired edit applies cleanly", applied.applied);
    const after = (await files.readFile(rel)).content;
    check(
      "the file kept its indentation",
      after.includes("      <Button variant=\"ghost\""),
      after.split("\n")[3]
    );
  }

  // Re-sending the same edit is now a no-op, not a failure loop.
  const again = await prepareEdit(files, {
    path: rel,
    oldString: dedented,
    newString: replacement,
  });
  check(
    "an already-applied edit is a no-op",
    again.status === "noop",
    again.status === "noop" ? again.message.slice(0, 48) : ""
  );

  // A path that does not exist stays the tool's error to report.
  const missing = await prepareEdit(files, {
    path: "src/nope.tsx",
    oldString: "a",
    newString: "b",
  });
  check("a missing file is passed through", missing.status === "ready");

  // --- failure explanation ------------------------------------------------

  const explained = await explainEditFailure(
    files,
    {
      path: rel,
      oldString: "      <Button variant=\"primary\" onClick={submit}>\n",
      newString: "      <Button variant=\"ghost\" onClick={submit}>\n",
    },
    new Error(`oldString not found in ${rel}`)
  );
  check(
    "a miss quotes the file's nearest lines",
    explained.includes("closest text") && /\d+ \| /.test(explained),
    explained.split("\n")[0]
  );

  const other = await explainEditFailure(
    files,
    { path: rel, oldString: "x", newString: "y" },
    new Error("Blocked by hook: modularity guard")
  );
  check(
    "a non-match error is left alone",
    other.includes("Blocked by hook"),
    other
  );

  // --- argument parsing ---------------------------------------------------

  const batch = editsOf("replace_many", {
    edits: [
      { path: rel, oldString: "a", newString: "b" },
      { path: rel, oldString: "c", newString: "d" },
      { path: rel, oldString: 7 },
    ],
  });
  check("replace_many yields one edit per entry", batch.length === 2, String(batch.length));
  const single = editsOf("replace_code", {
    path: rel,
    oldString: "a",
    newString: "b",
  });
  check("replace_code yields one edit", single.length === 1);
  check("malformed arguments yield none", editsOf("replace_code", { path: rel }).length === 0);

  // --- the batch, through the real registry -------------------------------

  const tools = new ToolRegistry(bus);
  registerFsTools(tools, files);
  const deps = {
    tools,
    files,
    taskId: "smoke",
    signal: new AbortController().signal,
  };

  // Ollama's live loop supplies this per-turn ledger. A stale RAG chunk may
  // name a plausible file, but it cannot authorize a write by itself.
  const grounding: EditGrounding = {
    required: true,
    discovered: false,
    readPaths: new Set(),
  };
  const groundedDeps = { ...deps, grounding };
  const allToolSchemas = atelierToolsFor(undefined);
  const visibleInitially = groundedToolsFor(allToolSchemas, grounding);
  check(
    "Ollama starts with an investigation-only tool surface",
    !JSON.stringify(visibleInitially).includes('"name":"replace_code"') &&
      JSON.stringify(visibleInitially).includes('"name":"search_text"') &&
      JSON.stringify(visibleInitially).includes('"name":"read_file"')
  );
  const blind = await runCall(
    "replace_code",
    { path: rel, oldString: "        Send\n", newString: "        Post\n" },
    groundedDeps
  );
  check(
    "blind edit is blocked before current-turn discovery",
    blind.includes("blind edit blocked") && blind.includes("Locate the live owner"),
    blind.split("\n")[0]
  );
  await runCall(
    "search_text",
    { query: "function Composer", glob: "src/**/*.tsx" },
    groundedDeps
  );
  const unread = await runCall(
    "replace_code",
    { path: rel, oldString: "        Send\n", newString: "        Post\n" },
    groundedDeps
  );
  check(
    "discovery alone cannot authorize an unread target",
    unread.includes("Read the current target"),
    unread.split("\n")[0]
  );
  await runCall("read_file", { path: rel }, groundedDeps);
  const visibleAfterGrounding = groundedToolsFor(allToolSchemas, grounding);
  check(
    "edit tools appear only after live discovery and a successful read",
    JSON.stringify(visibleAfterGrounding).includes('"name":"replace_code"')
  );
  const grounded = await runCall(
    "replace_code",
    { path: rel, oldString: "        Send\n", newString: "        Post\n" },
    groundedDeps
  );
  check(
    "discovery plus a current target read authorizes the edit",
    !grounded.includes("blind edit blocked") &&
      (await files.readFile(rel)).content.includes("        Post"),
    grounded.slice(0, 60)
  );
  const batchRel = "src/batch.tsx";
  await fs.writeFile(path.join(root, batchRel), SOURCE, "utf8");

  // One good edit, one whose oldString was never in the file. The whole
  // batch used to be discarded; the good edit must now survive.
  const mixed = await runCall(
    "replace_many",
    {
      edits: [
        { path: batchRel, oldString: "        Send\n", newString: "        Post\n" },
        {
          path: batchRel,
          oldString: "      <Badge variant=\"solid\">\n",
          newString: "      <Badge variant=\"ghost\">\n",
        },
      ],
    },
    deps
  );
  const batched = (await files.readFile(batchRel)).content;
  check("a good edit in a mixed batch is applied", batched.includes("        Post"));
  check(
    "the stale edit still reports a miss",
    /oldString not found/.test(mixed),
    mixed.split("\n").slice(0, 1).join("")
  );

  // Whitespace drift straight through the call path.
  const drifted = await runCall(
    "replace_code",
    {
      path: batchRel,
      oldString: "<div className=\"composer\">\n",
      newString: "<div className=\"composer wide\">\n",
    },
    deps
  );
  const afterDrift = (await files.readFile(batchRel)).content;
  check(
    "a dedented oldString still edits the file",
    afterDrift.includes("    <div className=\"composer wide\">"),
    drifted.slice(0, 60)
  );

  // The same edit twice is a no-op, not an error the model chases.
  const repeat = await runCall(
    "replace_code",
    {
      path: batchRel,
      oldString: "<div className=\"composer\">\n",
      newString: "<div className=\"composer wide\">\n",
    },
    deps
  );
  check(
    "re-sending it reports already applied",
    repeat.startsWith("Already applied"),
    repeat.slice(0, 40)
  );

  await fs.rm(root, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} failing`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
