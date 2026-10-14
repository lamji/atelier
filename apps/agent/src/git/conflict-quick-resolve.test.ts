import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseResolutions,
  resolveText,
  splitConflicts,
} from "./conflict-quick-resolve.js";

const INPUT = { paths: [], ours: "fix/focus", theirs: "origin/dev", kind: "merge" };

const FILE = [
  "import {",
  "<<<<<<< HEAD",
  "  resolveBillingSources,",
  "  resolveFocusGcpBillingSources,",
  "  toRawBillingSource,",
  "=======",
  "  resolveFocusGcpBillingSources,",
  ">>>>>>> 96e8155534a9667d",
  "  type BillingSource,",
  '} from "./billing";',
  "",
].join("\n");

test("splits a file into text and hunks", () => {
  const segments = splitConflicts(FILE);
  assert.equal(segments?.length, 3);
  const hunk = segments?.[1];
  assert.equal(hunk?.kind, "conflict");
  if (hunk?.kind !== "conflict") return;
  assert.equal(hunk.ours.length, 3);
  assert.deepEqual(hunk.theirs, ["  resolveFocusGcpBillingSources,"]);
  assert.equal(hunk.base, null);
});

test("reads diff3 base blocks", () => {
  const text = "<<<<<<< a\none\n||||||| base\nzero\n=======\ntwo\n>>>>>>> b\n";
  const hunk = splitConflicts(text)?.[1];
  assert.ok(hunk?.kind === "conflict");
  assert.deepEqual(hunk.kind === "conflict" ? hunk.base : null, ["zero"]);
});

test("refuses markers that do not nest", () => {
  assert.equal(splitConflicts("<<<<<<< a\none\n>>>>>>> b\n"), null);
  assert.equal(splitConflicts("<<<<<<< a\none\n=======\ntwo\n"), null);
});

test("splices the model's answer over the hunk and nothing else", async () => {
  let seen = "";
  const outcome = await resolveText(FILE, INPUT, async (_system, prompt) => {
    seen = prompt;
    return [
      "<<RESOLVED 1>>",
      "  resolveBillingSources,",
      "  resolveFocusGcpBillingSources,",
      "  toRawBillingSource,",
      "<<END 1>>",
    ].join("\n");
  });
  assert.match(seen, /OURS \(fix\/focus\)/);
  assert.match(seen, /type BillingSource/);
  assert.deepEqual("content" in outcome ? outcome.content.split("\n") : [], [
    "import {",
    "  resolveBillingSources,",
    "  resolveFocusGcpBillingSources,",
    "  toRawBillingSource,",
    "  type BillingSource,",
    '} from "./billing";',
    "",
  ]);
});

test("keeps CRLF line endings", async () => {
  const outcome = await resolveText(
    FILE.replace(/\n/g, "\r\n"),
    INPUT,
    async () => "<<RESOLVED 1>>\n  a,\n  b,\n<<END 1>>"
  );
  assert.ok("content" in outcome);
  if (!("content" in outcome)) return;
  assert.ok(outcome.content.includes("import {\r\n  a,\r\n  b,\r\n  type"));
  assert.ok(!/[^\r]\n/.test(outcome.content));
});

test("an empty block deletes the conflicted lines", async () => {
  const outcome = await resolveText(
    "a\n<<<<<<< x\nb\n=======\n>>>>>>> y\nc\n",
    INPUT,
    async () => "<<RESOLVED 1>>\n<<END 1>>"
  );
  assert.deepEqual(outcome, { content: "a\nc\n" });
});

test("leaves the file alone when the answer does not line up", async () => {
  const missing = await resolveText(FILE, INPUT, async () => "Sure! Here you go.");
  assert.ok("reason" in missing);
  const marked = await resolveText(
    FILE,
    INPUT,
    async () => "<<RESOLVED 1>>\n<<<<<<< HEAD\nx\n<<END 1>>"
  );
  assert.ok("reason" in marked);
});

test("parses several blocks", () => {
  const blocks = parseResolutions(
    "<<RESOLVED 1>>\na\n<<END 1>>\n<<RESOLVED 2>>\nb\nc\n<<END 2>>"
  );
  assert.equal(blocks.get(1), "a");
  assert.equal(blocks.get(2), "b\nc");
});
