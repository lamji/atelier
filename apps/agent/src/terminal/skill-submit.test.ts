import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canSendDocUpkeep,
  holdsAttachment,
  skillSubmitKeys,
} from "@atelier/shared";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const HOME = "\x01";
const DELETE = "\x1b[3~";

const lead = 'Run the Atelier "document" skill: read "S.md". Request:';
const base = { token: "$document", lead, request: "trace login" };

test("a composer with a pasted image is seen to hold an attachment", () => {
  assert.equal(holdsAttachment("$document trace this [Image #1]"), true);
  assert.equal(holdsAttachment("[Image #12] what is this"), true);
  assert.equal(holdsAttachment("$document trace image handling"), false);
  assert.equal(holdsAttachment(""), false);
  assert.equal(holdsAttachment(null), false);
});

test("a plain skill command is cleared and pasted whole", () => {
  const keys = skillSubmitKeys({ ...base, shown: "$document trace login" });
  assert.equal(keys, `\x15${PASTE_START}${lead} trace login${PASTE_END}`);
  // Nothing on screen to go by: the proven path.
  assert.equal(
    skillSubmitKeys({ ...base, shown: null }),
    `\x15${PASTE_START}${lead} trace login${PASTE_END}`
  );
});

test("an attached image survives: only the command word is replaced", () => {
  const keys = skillSubmitKeys({
    ...base,
    request: "trace this [Image #1]",
    shown: "$document trace this [Image #1]",
  });
  // Clearing the composer is what dropped the image, so it is not cleared.
  assert.doesNotMatch(keys, /\x15/);
  assert.equal(
    keys,
    `${HOME}${DELETE.repeat("$document".length)}${PASTE_START}${lead}${PASTE_END}`
  );
});

test("the command word is matched as the screen shows it", () => {
  const keys = skillSubmitKeys({
    ...base,
    token: "$documents:documents",
    request: "[Image #1] why",
    shown: "$Documents:Documents [Image #1] why",
  });
  assert.equal(
    keys,
    `${HOME}${DELETE.repeat("$documents:documents".length)}` +
      `${PASTE_START}${lead}${PASTE_END}`
  );
});

test("an image pasted before the command keeps the whole composer", () => {
  const keys = skillSubmitKeys({
    ...base,
    request: "trace this",
    shown: "[Image #1] $document trace this",
  });
  assert.equal(keys, `${HOME}${PASTE_START}${lead} ${PASTE_END}`);
});

test("upkeep never clears a composer that holds an attachment", () => {
  const idle = { processing: false, typed: "", composer: "" };
  // Pasting an image is one control key: nothing was typed, yet the
  // composer is not empty, and clearing it would throw the image away.
  assert.equal(canSendDocUpkeep({ ...idle, composer: "[Image #1]" }), false);
  assert.equal(canSendDocUpkeep({ ...idle, composer: "Ask anything" }), true);
});
