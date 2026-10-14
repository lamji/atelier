import assert from "node:assert/strict";
import { test } from "node:test";
// The web app has no test runner of its own; this module is pure.
import {
  buildUnifiedDiff,
  countChanges,
} from "../../../web/src/lib/unified-diff.js";

const lf = ["import a from 'a';", "const x = 1;", "export default x;", ""];

test("a CRLF checkout of an LF blob is not a rewrite of the file", () => {
  // What git.diff hands over under core.autocrlf: the blob from the index
  // has LF endings, the working file CRLF. Only one line really changed.
  const before = lf.join("\n");
  const after = [lf[0], "const x = 2;", lf[2], ""].join("\r\n");
  assert.deepEqual(countChanges(before, after), { added: 1, removed: 1 });
  const rows = buildUnifiedDiff(before, after).rows;
  const changed = rows.filter((row) => row.kind !== "eq" && row.kind !== "gap");
  assert.deepEqual(
    changed.map((row) => row.kind),
    ["del", "add"]
  );
  // The carriage return is an ending, not part of the line shown.
  assert.ok(rows.every((row) => !("text" in row) || !row.text.endsWith("\r")));
});

test("a file that differs only in line endings has no changes", () => {
  const before = lf.join("\n");
  const after = lf.join("\r\n");
  assert.deepEqual(countChanges(before, after), { added: 0, removed: 0 });
});
