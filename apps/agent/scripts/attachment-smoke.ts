/**
 * Attachment carry-over: an image attached on one turn must still be
 * reachable — by path — from the turns that follow it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { AttachmentStore } from "../src/context/attachments/attachment-store.js";

const log = pino({ level: "silent" });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-attach-"));
const store = new AttachmentStore(dataDir, log);

const RED_DOT =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const image = { mediaType: "image/png", data: RED_DOT };

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures += 1;
}

// Turn 1: the user attaches a screenshot and states an issue.
const saved = store.save("conv-1", "task-1", [image]);
check("saving returns a path per image", saved.length === 1);

// Turn 2: no attachment of its own — the path is still the conversation's.
const paths = store.recentPaths("conv-1");
check("a later turn still has the path", paths[0] === saved[0]);

// view_image reads it back as the picture, not as a description of it.
const loaded = store.load(paths[0]!);
check(
  "the bytes survive the round trip",
  loaded?.data === RED_DOT && loaded?.mediaType === "image/png"
);

// The path arrives as model-authored tool input, so the store is a jail.
const escaped = path.join(dataDir, "..", "secrets.png");
check("a path outside the store is refused", store.load(escaped) === null);

// A conversation that never had one has nothing to offer.
check("an untouched conversation has no paths", store.recentPaths("conv-2").length === 0);

// Only the LAST turn's set comes back, not every image ever attached.
store.save("conv-3", "task-a", [image]);
store.save("conv-3", "task-b", [image, image]);
check("only the most recent turn's set is carried", store.recentPaths("conv-3").length === 2);

fs.rmSync(dataDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nattachment smoke passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
