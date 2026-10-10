import assert from "node:assert/strict";
import type { ForgeAuth } from "./forge-auth.js";
import { preferLogin, sameLogin } from "./git-ops.js";

/**
 * The failure this locks down: a machine with two GitHub accounts and an
 * SSH checkout showed "@lamji denied" in Requests, while History, Fetch
 * and Pull all worked — because those use the SSH key (@jick-lampago) and
 * Requests uses an API token. The credential that could read the repo was
 * already in the ladder; nothing had put it first.
 */
const LADDER: ForgeAuth[] = [
  { token: "env-token", source: "env" },
  { token: "lamji-token", source: "cli-token", login: "lamji" },
  { token: "jick-token", source: "cli-token", login: "jick-lampago" },
  { token: "helper-token", source: "credential-helper", login: "lamji" },
];

async function main(): Promise<void> {
  // GitHub logins are case-insensitive.
  assert.equal(sameLogin("Jick-Lampago", "jick-lampago"), true);
  assert.equal(sameLogin("lamji", "jick-lampago"), false);
  // An untagged credential matches nobody rather than everybody.
  assert.equal(sameLogin(undefined, "jick-lampago"), false);
  assert.equal(sameLogin("lamji", ""), false);

  const ordered = preferLogin(LADDER, "jick-lampago");
  assert.equal(
    ordered[0]?.token,
    "jick-token",
    "the SSH account's credential is tried first"
  );
  assert.equal(ordered.length, LADDER.length, "nothing is dropped");
  // The rest keep their discovered priority: env, then CLI, then helper.
  assert.deepEqual(
    ordered.slice(1).map((auth) => auth.token),
    ["env-token", "lamji-token", "helper-token"],
    "the remaining ladder order is untouched"
  );

  // Case-insensitively too.
  assert.equal(preferLogin(LADDER, "JICK-LAMPAGO")[0]?.token, "jick-token");

  // Every credential for the account is promoted, not just the first.
  const twoForOne = preferLogin(LADDER, "lamji");
  assert.deepEqual(
    twoForOne.slice(0, 2).map((auth) => auth.token),
    ["lamji-token", "helper-token"]
  );

  // No SSH identity, or no credential for it: the ladder is left alone, so
  // a single-account machine behaves exactly as it did before.
  assert.deepEqual(preferLogin(LADDER, ""), LADDER);
  assert.deepEqual(preferLogin(LADDER, "somebody-else"), LADDER);
  assert.deepEqual(preferLogin([], "jick-lampago"), []);
}

void main();
