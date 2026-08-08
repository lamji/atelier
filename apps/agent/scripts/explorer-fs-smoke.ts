/**
 * Exercises the explorer's authoring RPCs — create / rename / copy / delete
 * — against a REAL throwaway workspace, including the refusals that keep a
 * create or a move from destroying something.
 *
 * Run: pnpm --filter @atelier/agent smoke:explorer
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/events/event-bus.js";
import { FileService } from "../src/workspace/file-service.js";
import { WorkspaceIgnore } from "../src/workspace/ignore.js";
import { PathGuard } from "../src/workspace/path-guard.js";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Asserts an operation is refused, and reports the message it refused with. */
async function refuses(label: string, op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
    check(label, false, "it was allowed");
  } catch (error) {
    check(label, true, error instanceof Error ? error.message : String(error));
  }
}

async function exists(abs: string): Promise<boolean> {
  return fs
    .stat(abs)
    .then(() => true)
    .catch(() => false);
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-explorer-"));
  const bus = new EventBus();
  const events: string[] = [];
  bus.subscribe((event) => {
    if (event.topic !== "file.changed") return;
    const payload = event.payload as { path: string; type: string };
    events.push(`${payload.type}:${payload.path}`);
  });
  const files = new FileService(
    new PathGuard(root),
    new WorkspaceIgnore(root),
    bus
  );

  console.log(`workspace: ${root}\n`);

  // --- create -------------------------------------------------------------
  const created = await files.createFile("src/app.ts");
  check("createFile returns the wire path", created === "src/app.ts", created);
  check("createFile made the parent dir", await exists(path.join(root, "src")));
  await files.createDir("src/lib");
  check("createDir made the folder", await exists(path.join(root, "src/lib")));

  await refuses("createFile refuses an existing path", () =>
    files.createFile("src/app.ts")
  );
  await refuses("createDir refuses an existing path", () =>
    files.createDir("src/lib")
  );
  await refuses("create refuses escaping the workspace", () =>
    files.createFile("../escaped.ts")
  );

  // --- rename / move ------------------------------------------------------
  await fs.writeFile(path.join(root, "src/app.ts"), "export const a = 1;\n");
  const renamed = await files.rename("src/app.ts", "src/main.ts");
  check("rename moves the file", renamed === "src/main.ts", renamed);
  check(
    "rename keeps the content",
    (await fs.readFile(path.join(root, "src/main.ts"), "utf8")).includes("a = 1")
  );
  const moved = await files.rename("src/main.ts", "src/lib/main.ts");
  check("rename across folders", moved === "src/lib/main.ts", moved);

  await refuses("rename refuses a missing source", () =>
    files.rename("nope.ts", "src/nope.ts")
  );
  await files.createFile("src/taken.ts");
  await refuses("rename refuses to clobber the target", () =>
    files.rename("src/lib/main.ts", "src/taken.ts")
  );
  await refuses("rename refuses a folder into itself", () =>
    files.rename("src", "src/inner")
  );
  // Case-only renames must survive on a case-insensitive file system.
  const cased = await files.rename("src/taken.ts", "src/Taken.ts");
  check("case-only rename works", cased === "src/Taken.ts", cased);

  // --- copy ---------------------------------------------------------------
  const copied = await files.copy("src/lib/main.ts", "src/lib/main copy.ts");
  check("copy duplicates a file", await exists(path.join(root, copied)));
  const copiedDir = await files.copy("src/lib", "src/lib-backup");
  check(
    "copy recurses into a folder",
    await exists(path.join(root, copiedDir, "main.ts"))
  );
  await refuses("copy refuses an existing target", () =>
    files.copy("src/lib/main.ts", "src/lib/main copy.ts")
  );
  await refuses("copy refuses a folder into itself", () =>
    files.copy("src/lib", "src/lib/nested")
  );

  // --- delete -------------------------------------------------------------
  await files.remove("src/lib/main copy.ts");
  check(
    "delete removes a file",
    !(await exists(path.join(root, "src/lib/main copy.ts")))
  );
  await files.remove("src/lib-backup");
  check(
    "delete removes a folder tree",
    !(await exists(path.join(root, "src/lib-backup")))
  );
  await refuses("delete refuses a missing path", () => files.remove("gone.ts"));
  await refuses("delete refuses the workspace root", () => files.remove(""));

  // --- events -------------------------------------------------------------
  check(
    "folder creation announces addDir",
    events.includes("addDir:src/lib"),
    events.slice(0, 6).join(", ")
  );
  check(
    "folder deletion announces unlinkDir",
    events.includes("unlinkDir:src/lib-backup")
  );
  check(
    "rename announces both ends",
    events.includes("unlink:src/app.ts") && events.includes("add:src/main.ts")
  );

  await fs.rm(root, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
