/**
 * Session feature-context smoke: /context login compiles a bounded
 * tree-sitter call/import flow, binds it to one conversation, and supplies
 * feature-owned chunks without a follow-up text search.
 *
 *   pnpm --filter @atelier/agent smoke:feature-context
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripHiddenContext, wrapHiddenContext } from "@atelier/shared";
import { openDb, type Db } from "../src/storage/db.js";
import { ConversationRepo } from "../src/storage/repositories/conversations.js";
import {
  DEBUG_REPORT_TEMPLATE,
  FEATURE_CONTEXT_COMMAND_ID,
  FEATURE_CONTEXT_DEBUG_COMMAND_ID,
  FEATURE_CONTEXT_UPDATE_COMMAND_ID,
  FeatureContextStore,
  parseDebugReport,
  parseFeatureContextCommand,
  parseFeatureContextDebugCommand,
  parseFeatureContextUpdateCommand,
  renderDebugTask,
  renderFeatureContextActivationReport,
  renderFeatureContextRefreshReport,
} from "../src/context/feature-context/index.js";
import {
  listSlashCommands,
  readSlashCommandDetail,
} from "../src/orchestrator/command-catalog.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-feature-context-"));
const db = openDb(root);

try {
  const conversations = new ConversationRepo(db);
  const now = Date.now();
  conversations.create({
    id: "conv-login",
    title: "New conversation",
    sdkSessionId: null,
    createdAt: now,
    updatedAt: now,
  });
  conversations.create({
    id: "conv-other",
    title: "Other work",
    sdkSessionId: null,
    createdAt: now,
    updatedAt: now,
  });

  // Mirrors the UI flow: create a session, then rename it before equipping it.
  conversations.setTitle("conv-login", "login");
  assert.equal(conversations.get("conv-login")?.title, "login");

  assert.equal(parseFeatureContextCommand("/context login"), "login");
  assert.equal(parseFeatureContextCommand(" /CONTEXT   user login  "), "user login");
  assert.equal(parseFeatureContextCommand("/context"), "");
  assert.equal(parseFeatureContextCommand("debug login"), undefined);

  // /context_update is its own command: the /context parser must not claim
  // it, and it takes an optional name to repoint the same conversation.
  assert.equal(parseFeatureContextCommand("/context_update"), undefined);
  assert.equal(parseFeatureContextUpdateCommand("/context_update"), "");
  assert.equal(parseFeatureContextUpdateCommand(" /CONTEXT-UPDATE "), "");
  assert.equal(
    parseFeatureContextUpdateCommand("/context_update  user login "),
    "user login"
  );
  assert.equal(parseFeatureContextUpdateCommand("/context login"), undefined);

  // Image/page-preview evidence rides after the visible command in a hidden
  // block. Command routing must inspect the human text, or the anchored parser
  // misses and the task falls through into an implementation turn.
  const imageGroundedUpdate =
    "/context_update header\n\n" +
    wrapHiddenContext("Highlighted screenshot and page-preview evidence");
  assert.equal(
    parseFeatureContextUpdateCommand(stripHiddenContext(imageGroundedUpdate)),
    "header"
  );
  const pipelineSource = fs.readFileSync(
    new URL("../src/orchestrator/pipeline-executor.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    pipelineSource,
    /const commandPrompt = stripHiddenContext\(ctx\.prompt\)/
  );
  assert.match(
    pipelineSource,
    /parseFeatureContextUpdateCommand\(commandPrompt\)/
  );

  // /context_debug is a third command: neither sibling parser claims it,
  // and its body is a document, so line breaks must survive parsing.
  assert.equal(parseFeatureContextCommand("/context_debug"), undefined);
  assert.equal(parseFeatureContextUpdateCommand("/context_debug"), undefined);
  assert.equal(parseFeatureContextDebugCommand("/context_debug"), "");
  assert.equal(parseFeatureContextDebugCommand(" /CONTEXT-DEBUG "), "");
  assert.equal(parseFeatureContextDebugCommand("/context login"), undefined);
  assert.equal(
    parseFeatureContextDebugCommand("/context_debug ## Steps\n1. click"),
    "## Steps\n1. click"
  );

  // The blank template is not a report: an untouched skeleton must come
  // back as the form, never start a debug turn on empty steps.
  assert.equal(parseDebugReport(DEBUG_REPORT_TEMPLATE), null);
  assert.equal(parseDebugReport(""), null);

  const filledReport = [
    "# Bug report",
    "",
    "## Steps to replicate",
    "1. Open the login screen",
    "2. Submit an empty form",
    "",
    "## Expected result",
    "An inline validation message.",
    "",
    "## Actual result",
    "The app navigates to the dashboard.",
    "",
    "## Notes",
    "Only on Windows.",
  ].join("\n");
  const report = parseDebugReport(filledReport);
  assert.ok(report);
  assert.equal(
    report.steps,
    "1. Open the login screen\n2. Submit an empty form"
  );
  assert.equal(report.expected, "An inline validation message.");
  assert.equal(report.actual, "The app navigates to the dashboard.");
  assert.equal(report.notes, "Only on Windows.");

  // Prose typed straight after the command is still a report, not a
  // formatting error — the steps carry it and the expectation is inferred.
  const prose = parseDebugReport("the login button does nothing");
  assert.equal(prose?.steps, "the login button does nothing");
  assert.equal(prose?.expected, "");

  // The debug turn is a task prompt, and attached screenshots are named in
  // it so the model knows to look rather than trusting the description.
  const task = renderDebugTask(report, 2);
  assert.match(task, /STEPS TO REPLICATE:/);
  assert.match(task, /2\. Submit an empty form/);
  assert.match(task, /EXPECTED RESULT:\nAn inline validation message\./);
  assert.match(task, /2 screenshot\(s\) are attached/);
  assert.match(task, /highlight, box, circle, or arrow/);
  assert.match(task, /State in one line what the annotation points at/);
  assert.match(task, /owning screen\/component and file/);
  assert.match(task, /trigger and event handler/);
  assert.match(task, /service\/API\/data path, callers\/importers/);
  assert.match(task, /Trace that chain end to end to the terminal effect/);
  const textOnlyTask = renderDebugTask(report, 0);
  assert.doesNotMatch(textOnlyTask, /screenshot/);
  assert.doesNotMatch(textOnlyTask, /highlighted element/);

  const loginFile = addFile(db, "src/routes/login.ts");
  const authFile = addFile(db, "src/auth/auth-service.ts");
  const usersFile = addFile(db, "src/data/users.ts");
  const billingFile = addFile(db, "src/billing/checkout.ts");

  const loginRoute = addSymbol(db, loginFile, "loginRoute", 4);
  const authenticateUser = addSymbol(db, authFile, "authenticateUser", 12);
  const findUser = addSymbol(db, usersFile, "findUser", 20);
  const checkout = addSymbol(db, billingFile, "checkout", 7);

  addCall(db, loginRoute, authenticateUser, "authenticateUser", 8);
  addCall(db, authenticateUser, findUser, "findUser", 17);
  addImport(db, loginFile, authFile, "./auth-service", ["authenticateUser"]);
  addImport(db, authFile, usersFile, "./users", ["findUser"]);

  addChunk(db, loginFile, loginRoute, "export async function loginRoute() {}");
  addChunk(
    db,
    authFile,
    authenticateUser,
    "export async function authenticateUser() {}"
  );
  addChunk(db, usersFile, findUser, "export async function findUser() {}");
  addChunk(db, billingFile, checkout, "export async function checkout() {}");

  const store = new FeatureContextStore(db);
  const activated = store.activate("conv-login", "login");
  const compiled = activated.context;

  assert.equal(compiled.slug, "context:login");
  assert.equal(compiled.status, "fresh");
  assert.deepEqual(
    new Set(compiled.files),
    new Set([
      "src/routes/login.ts",
      "src/auth/auth-service.ts",
      "src/data/users.ts",
    ])
  );
  assert.ok(compiled.symbols.some((symbol) => symbol.name === "loginRoute"));
  assert.ok(
    compiled.symbols.some((symbol) => symbol.name === "authenticateUser")
  );
  assert.ok(compiled.symbols.some((symbol) => symbol.name === "findUser"));
  assert.ok(!compiled.symbols.some((symbol) => symbol.name === "checkout"));
  assert.match(compiled.detail, /## login context report/);
  assert.match(compiled.detail, /### Entrypoint paths/);
  assert.match(
    compiled.detail,
    /\| `src\/routes\/login\.ts:5` \| `loginRoute` \| `function` \|/
  );
  assert.match(compiled.detail, /### End-to-end flow graph/);
  assert.match(
    compiled.detail,
    /ENTRYPOINT  loginRoute  \[src\/routes\/login\.ts:5\][\s\S]*CALL        authenticateUser  \[src\/auth\/auth-service\.ts:13\][\s\S]*TERMINAL    findUser  \[src\/data\/users\.ts:21\]/
  );
  assert.match(compiled.detail, /### End-to-end function flow/);
  assert.match(
    compiled.detail,
    /`loginRoute` -> `authenticateUser` -> `findUser`/
  );
  assert.match(
    compiled.detail,
    /`src\/routes\/login\.ts:5` -> `src\/auth\/auth-service\.ts:13` -> `src\/data\/users\.ts:21`/
  );
  assert.match(compiled.detail, /loginRoute -> .*authenticateUser/s);
  assert.match(compiled.detail, /authenticateUser -> .*findUser/s);
  assert.doesNotMatch(compiled.detail, /checkout/);

  // The direct command reply must lead with this detail. A summary-only first
  // block is exactly what made the process report look unchanged.
  const activationReport = renderFeatureContextActivationReport(activated);
  assert.ok(activationReport.startsWith("## login context report\n"));
  assert.ok(
    activationReport.indexOf("### Entrypoint paths") <
      activationReport.indexOf("**Context status:**")
  );
  assert.match(activationReport, /ENTRYPOINT  loginRoute/);
  assert.match(
    activationReport,
    /\*\*Context status:\*\* Pinned "login" to this conversation/
  );
  assert.throws(
    () =>
      renderFeatureContextActivationReport({
        ...activated,
        context: {
          ...activated.context,
          detail: "Equipped this conversation with a summary only.",
        },
      }),
    /built without its detailed report/
  );
  assert.equal(store.get("conv-other"), null);

  // Every stored file and symbol association belongs to the login feature.
  const associatedFiles = db
    .prepare(
      "SELECT f.path FROM feature_files ff JOIN files f ON f.id = ff.file_id " +
        "WHERE ff.feature_id = ? ORDER BY f.path"
    )
    .all(compiled.featureId) as Array<{ path: string }>;
  assert.deepEqual(
    new Set(associatedFiles.map((row) => row.path)),
    new Set(compiled.files)
  );
  const associatedSymbols = db
    .prepare(
      "SELECT s.name FROM feature_symbols fs JOIN symbols s ON s.id = fs.symbol_id " +
        "WHERE fs.feature_id = ?"
    )
    .all(compiled.featureId) as Array<{ name: string }>;
  assert.ok(associatedSymbols.every((row) => row.name !== "checkout"));

  const chunks = store.retrievalChunks(compiled.featureId, 10);
  assert.ok(chunks.some((chunk) => chunk.path === "src/routes/login.ts"));
  assert.ok(chunks.some((chunk) => chunk.path === "src/auth/auth-service.ts"));
  assert.ok(chunks.some((chunk) => chunk.path === "src/data/users.ts"));
  assert.ok(!chunks.some((chunk) => chunk.path.includes("billing")));
  assert.match(store.render(compiled), /SESSION FEATURE CONTEXT — login/);
  assert.match(store.render(compiled), /do not text-search/);

  // Re-running the command refreshes the closure and discovers a new caller
  // whose own name/path does not contain "login".
  const auditFile = addFile(db, "src/audit/audit.ts");
  const recordAttempt = addSymbol(db, auditFile, "recordAttempt", 3);
  addCall(db, recordAttempt, loginRoute, "loginRoute", 5);
  addChunk(db, auditFile, recordAttempt, "export function recordAttempt() {}");

  // /context_update rebuilds from the stored pin, so no feature name is
  // retyped, and it reports the file that joined the flow.
  assert.equal(store.pinnedName("conv-login"), "login");
  const update = store.refresh("conv-login");
  const refreshed = update.context;
  assert.ok(refreshed.symbols.some((symbol) => symbol.name === "recordAttempt"));
  assert.ok(refreshed.files.includes("src/audit/audit.ts"));
  assert.equal(refreshed.featureId, compiled.featureId);
  assert.deepEqual(update.addedFiles, ["src/audit/audit.ts"]);
  assert.deepEqual(update.removedFiles, []);
  assert.equal(update.previous?.featureId, compiled.featureId);
  assert.ok(!update.previous?.files.includes("src/audit/audit.ts"));
  assert.match(
    refreshed.detail,
    /`recordAttempt` -> `loginRoute` -> `authenticateUser` -> `findUser`/
  );
  assert.match(refreshed.detail, /`src\/audit\/audit\.ts:4`/);
  const refreshReport = renderFeatureContextRefreshReport(update);
  assert.ok(refreshReport.startsWith("## login context report\n"));
  assert.match(refreshReport, /ENTRYPOINT  recordAttempt/);
  assert.match(refreshReport, /Files added src\/audit\/audit\.ts\./);
  assert.ok(
    refreshReport.indexOf("### End-to-end flow graph") <
      refreshReport.indexOf("**Context status:**")
  );

  // A second update with nothing changed is a no-op the reply can say so about.
  const idle = store.refresh("conv-login");
  assert.deepEqual(idle.addedFiles, []);
  assert.deepEqual(idle.removedFiles, []);
  assert.match(
    renderFeatureContextRefreshReport(idle),
    /The same files are still in the flow\./
  );

  // An unpinned conversation is told to run /context first, not silently
  // given someone else's map.
  assert.equal(store.pinnedName("conv-other"), null);
  assert.throws(
    () => store.refresh("conv-other"),
    /not pinned to a feature yet/
  );
  assert.equal(store.get("conv-other"), null);

  // A name repoints the pin without the plain /context command.
  const repinned = store.refresh("conv-other", "checkout");
  assert.equal(repinned.context.name, "checkout");
  assert.ok(repinned.context.files.includes("src/billing/checkout.ts"));
  assert.equal(store.pinnedName("conv-other"), "checkout");
  assert.equal(store.get("conv-login")?.name, "login");

  const commands = listSlashCommands(root);
  const command = commands.find(
    (entry) => entry.id === FEATURE_CONTEXT_COMMAND_ID
  );
  assert.equal(command?.name, "context");
  assert.equal(command?.kind, "command");
  const detail = readSlashCommandDetail(root, FEATURE_CONTEXT_COMMAND_ID);
  assert.match(detail?.content ?? "", /\/context <feature>/);

  const updateCommand = commands.find(
    (entry) => entry.id === FEATURE_CONTEXT_UPDATE_COMMAND_ID
  );
  assert.equal(updateCommand?.name, "context_update");
  assert.equal(updateCommand?.kind, "command");
  const updateDetail = readSlashCommandDetail(
    root,
    FEATURE_CONTEXT_UPDATE_COMMAND_ID
  );
  assert.match(updateDetail?.content ?? "", /\/context_update/);

  const debugCommand = commands.find(
    (entry) => entry.id === FEATURE_CONTEXT_DEBUG_COMMAND_ID
  );
  assert.equal(debugCommand?.name, "context_debug");
  assert.equal(debugCommand?.kind, "command");
  // The detail carries the editable form itself, so one copy of the
  // template serves both the command browser and the command's own reply.
  const debugDetail = readSlashCommandDetail(
    root,
    FEATURE_CONTEXT_DEBUG_COMMAND_ID
  );
  assert.match(debugDetail?.content ?? "", /## Steps to replicate/);
  assert.match(debugDetail?.content ?? "", /## Expected result/);

  console.log("feature-context smoke passed");
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}

function addFile(db_: Db, filePath: string): number {
  const info = db_
    .prepare(
      "INSERT INTO files(path, lang, size, mtime, content_hash, parse_status, parsed_at) " +
        "VALUES (?, 'typescript', 100, 1, ?, 'ok', 1)"
    )
    .run(filePath, "hash-" + filePath);
  return Number(info.lastInsertRowid);
}

function addSymbol(
  db_: Db,
  fileId: number,
  name: string,
  startRow: number
): number {
  const info = db_
    .prepare(
      "INSERT INTO symbols(file_id, name, kind, signature, parent_symbol_id, " +
        "start_row, start_col, end_row, end_col, doc_comment, stable_key) " +
        "VALUES (?, ?, 'function', ?, NULL, ?, 0, ?, 1, NULL, ?)"
    )
    .run(
      fileId,
      name,
      "function " + name + "()",
      startRow,
      startRow + 3,
      String(fileId) + ":" + name
    );
  return Number(info.lastInsertRowid);
}

function addCall(
  db_: Db,
  callerId: number,
  calleeId: number,
  calleeName: string,
  siteRow: number
): void {
  db_
    .prepare(
      "INSERT INTO call_edges(caller_symbol_id, callee_symbol_id, callee_name, " +
        "callee_module_hint, site_row, confidence) VALUES (?, ?, ?, NULL, ?, 1)"
    )
    .run(callerId, calleeId, calleeName, siteRow);
}

function addImport(
  db_: Db,
  fromId: number,
  toId: number,
  specifier: string,
  names: string[]
): void {
  db_
    .prepare(
      "INSERT INTO imports(file_id, specifier, resolved_file_id, imported_names, " +
        "is_type_only) VALUES (?, ?, ?, ?, 0)"
    )
    .run(fromId, specifier, toId, JSON.stringify(names));
}

function addChunk(
  db_: Db,
  fileId: number,
  symbolId: number,
  text: string
): void {
  db_
    .prepare(
      "INSERT INTO chunks(file_id, symbol_id, kind, content_hash, text, " +
        "token_count, start_row, end_row) VALUES (?, ?, 'code', ?, ?, ?, 1, 4)"
    )
    .run(
      fileId,
      symbolId,
      "chunk-" + String(symbolId),
      text,
      Math.ceil(text.length / 4)
    );
}
