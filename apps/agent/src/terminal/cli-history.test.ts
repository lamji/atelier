import assert from "node:assert/strict";
import { test } from "node:test";
import { titleFromCliTranscript } from "./cli-history.js";

test("Codex auto title uses the latest substantive request, not /rename", () => {
  const transcript = [
    { type: "event_msg", payload: { type: "user_message", message: "Investigate the dashboard cache" } },
    { type: "event_msg", payload: { type: "user_message", message: "Fix the Tag Management cache after tag edits" } },
    { type: "event_msg", payload: { type: "user_message", message: "continue" } },
    { type: "event_msg", payload: { type: "user_message", message: "/rename" } },
  ].map((record) => JSON.stringify(record)).join("\n");
  assert.equal(titleFromCliTranscript("codex", transcript), "Fix the Tag Management cache after tag edits");
});

test("Claude auto title ignores metadata and sidechain messages", () => {
  const transcript = [
    { type: "user", isMeta: false, isSidechain: false, message: { content: [{ type: "text", text: "Resolve Git conflicts in the backend" }] } },
    { type: "user", isMeta: true, message: { content: "Ignore this metadata" } },
    { type: "user", isSidechain: true, message: { content: "Ignore this subagent task" } },
    { type: "user", isMeta: false, isSidechain: false, message: { content: "Update the dashboard cache after tag edits" } },
  ].map((record) => JSON.stringify(record)).join("\n");
  assert.equal(titleFromCliTranscript("claude", transcript), "Update the dashboard cache after tag edits");
});

test("auto title keeps Next.js as part of a request", () => {
  const transcript = JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: "Next.js dashboard preview is blank" },
  });
  assert.equal(titleFromCliTranscript("codex", transcript), "Next.js dashboard preview is blank");
});

test("auto title reads a request after an image attachment", () => {
  const transcript = JSON.stringify({
    type: "event_msg",
    payload: { type: "user_message", message: "<image name=[Image #1] path=\"screenshot.png\"> Fix the session list layout" },
  });
  assert.equal(titleFromCliTranscript("codex", transcript), "Fix the session list layout");
});
