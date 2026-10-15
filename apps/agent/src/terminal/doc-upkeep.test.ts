import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canSendDocUpkeep,
  composerShows,
  planDocUpkeep,
  type UpkeepDoc,
} from "@atelier/shared";

function doc(id: string, changedFiles: string[], changedAt = 0): UpkeepDoc {
  return { id, changedFiles, changedAt };
}

test("nothing is asked for while every report is current", () => {
  assert.equal(planDocUpkeep([doc("login", [])], new Map()), null);
  assert.equal(planDocUpkeep([], new Map()), null);
});

test("one request covers every stale report of the session", () => {
  const plan = planDocUpkeep(
    [
      doc("checkout", ["src/cart.ts", "src/pay.ts"], 300),
      doc("fresh", []),
      doc("login", ["src/auth.ts", "src/cart.ts"], 200),
    ],
    new Map()
  );
  assert.deepEqual(plan, {
    request:
      "update checkout login; changed: src/cart.ts, src/pay.ts, src/auth.ts",
    asked: { checkout: 300, login: 200 },
  });
});

test("a report already asked about is left alone until a file moves again", () => {
  const docs = [doc("login", ["src/auth.ts"], 200)];
  assert.equal(planDocUpkeep(docs, new Map([["login", 200]])), null);
  const again = planDocUpkeep(
    [doc("login", ["src/auth.ts"], 250)],
    new Map([["login", 200]])
  );
  assert.equal(again?.request, "update login; changed: src/auth.ts");
  assert.deepEqual(again?.asked, { login: 250 });
});

test("a long list of changed files is cut short in the request", () => {
  const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  const plan = planDocUpkeep([doc("big", files, 9)], new Map());
  assert.match(plan?.request ?? "", /src\/f5\.ts, and 19 more$/);
  assert.doesNotMatch(plan?.request ?? "", /src\/f6\.ts/);
});

test("a request names a few reports; the rest wait for the next turn", () => {
  const docs = ["a", "b", "c", "d", "e", "f"].map((id) =>
    doc(id, [`src/${id}.ts`], 5)
  );
  const first = planDocUpkeep(docs, new Map());
  assert.match(first?.request ?? "", /^update a b c; changed: /);
  // A CLI folds a long paste into a placeholder, which is not a command.
  assert.ok((first?.request.length ?? 0) < 600);
  const next = planDocUpkeep(docs, new Map(Object.entries(first!.asked)));
  assert.match(next?.request ?? "", /^update d e f; changed: src\/d\.ts, /);
});

test("the request is only sent into an idle, empty composer", () => {
  const idle = { processing: false, typed: "", composer: "" };
  assert.equal(canSendDocUpkeep(idle), true);
  // A CLI's own placeholder sits in the composer while it is empty.
  assert.equal(canSendDocUpkeep({ ...idle, composer: "Ask anything" }), true);
  assert.equal(canSendDocUpkeep({ ...idle, processing: true }), false);
  // The user's half-written prompt must not be cleared or submitted.
  assert.equal(canSendDocUpkeep({ ...idle, typed: "fix th" }), false);
  // No composer on screen: an approval dialog would take the Enter.
  assert.equal(canSendDocUpkeep({ ...idle, composer: null }), false);
});

test("Enter follows only a request the composer is seen to hold", () => {
  const request =
    "/atelier-init-feature update login-flow; changed: src/auth/login.ts";
  assert.equal(composerShows(request, request), true);
  // A narrow pane wraps the request, and the footer rows trail after it.
  const wrapped =
    "/atelier-init-feature update login-flow; chan ged: src/auth/login.ts" +
    " ? for help";
  assert.equal(composerShows(wrapped, request), true);
  // A dialog had the keyboard: the paste went nowhere, and its selected
  // option is what sits behind the mark.
  assert.equal(composerShows("No, exit", request), false);
  assert.equal(composerShows("1. Yes, proceed", request), false);
  assert.equal(composerShows("", request), false);
  assert.equal(composerShows(null, request), false);
});
