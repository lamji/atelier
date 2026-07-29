/**
 * Verifies the workspace-shape knowledge and the recoverable path errors
 * against REAL folders on this machine — a single repo, a monorepo, and a
 * container folder holding several checkouts.
 *
 * Run: pnpm --filter @atelier/agent smoke:workspace
 *   optionally: tsx scripts/workspace-shape-smoke.ts <root> <badPath>
 */
import path from "node:path";
import { shapeToolOutput } from "../src/context/tool-output/index.js";
import { EventBus } from "../src/events/event-bus.js";
import { FileService } from "../src/workspace/file-service.js";
import { WorkspaceIgnore } from "../src/workspace/ignore.js";
import { PathGuard } from "../src/workspace/path-guard.js";
import {
  detectWorkspaceProfile,
  renderWorkspaceProfile,
} from "../src/workspace/profile/index.js";

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ".";
const CONTAINER = path.join(HOME, "Documents", "DigitalFuture2");

async function profileOf(root: string): Promise<void> {
  console.log(`\n=== ${root}`);
  try {
    const profile = await detectWorkspaceProfile(root);
    console.log(`kind=${profile.kind} projects=${profile.projects.length}`);
    console.log(renderWorkspaceProfile(profile));
  } catch (error) {
    console.log(`FAIL profile: ${String(error)}`);
  }
}

function serviceFor(root: string): FileService {
  const bus = new EventBus();
  return new FileService(new PathGuard(root), new WorkspaceIgnore(root), bus);
}

async function main(): Promise<void> {
  const roots = process.argv[2]
    ? [process.argv[2]]
    : [path.resolve("."), CONTAINER];
  for (const root of roots) await profileOf(root);

  const root = process.argv[2] ?? CONTAINER;
  const bad =
    process.argv[3] ?? "finops-crystal-lens/src/components/layout";
  const files = serviceFor(root);

  console.log(`\n=== list_dir recovery: ${bad}`);
  try {
    const listing = await files.listForModel(bad);
    console.log(`listed: ${listing.path || "<root>"}`);
    console.log(`note: ${listing.note ?? "(none — path existed)"}`);
    console.log(
      `entries: ${listing.entries.map((e) => e.name).slice(0, 12).join(", ")}`
    );
  } catch (error) {
    console.log(`FAIL listing: ${String(error)}`);
  }

  console.log("\n=== list_dir on a FILE (must not claim it is missing)");
  const aFile = (await files.listForModel(root === CONTAINER ? "" : "src"))
    .entries.find((e) => e.type === "file");
  if (aFile) {
    const onFile = await files.listForModel(aFile.path);
    console.log(`note: ${onFile.note ?? "(none)"}`);
  } else {
    console.log("(no file found to test)");
  }

  console.log("\n=== shaped list_dir output (what the model actually sees)");
  console.log(shapeToolOutput("list_dir", await files.listForModel(bad)));

  console.log(`\n=== read_file sibling hint for ${bad}/Nope.tsx`);
  const hint = await files.suggestFor(`${bad}/Nope.tsx`);
  console.log(hint ? hint.slice(0, 240) : "(parent missing — no hint)");

  console.log(`\n=== read_file error text: ${bad}/Nope.tsx`);
  try {
    await files.readFile(`${bad}/Nope.tsx`);
    console.log("FAIL: expected a throw");
  } catch (error) {
    const message = String(error);
    console.log(message.slice(0, 300));
    console.log(
      /[A-Za-z]:[\\/]/.test(message)
        ? "FAIL: absolute host path leaked into the message"
        : "PASS: no absolute host path in the message"
    );
  }

  console.log("\n=== escape still refused: ../outside");
  try {
    await files.listForModel("../outside");
    console.log("FAIL: escape was allowed");
  } catch (error) {
    console.log(`PASS: ${String(error)}`);
  }
}

void main();
