import assert from "node:assert/strict";
import {
  clearForgeAuth,
  forgeAuthCandidates,
  forgetForgeToken,
  rememberForgeToken,
  setForgeTokenStore,
  type ForgeAuth,
} from "./forge-auth.js";

/**
 * The failure this locks down: a token added in the Requests pane was
 * handed to `gh` and kept nowhere else. gh validates scopes and refuses
 * tokens it dislikes — most fine-grained PATs — so on this machine the
 * account was accepted, reported as added, and simply gone: `gh auth
 * status` still listed one account and the pane still said "@lamji denied".
 *
 * Atelier keeps it now. This exercises that path with a fake store, since
 * the real one is the settings table and better-sqlite3 is built for the
 * Electron ABI (plain tsx cannot open it).
 */
async function main(): Promise<void> {
  const rows = new Map<string, ForgeAuth[]>();
  setForgeTokenStore({
    read: (host) => rows.get(host) ?? [],
    write: (host, auth) => {
      const existing = (rows.get(host) ?? []).filter(
        (entry) => entry.token !== auth.token
      );
      rows.set(host, [...existing, auth]);
    },
    remove: (host, token) => {
      rows.set(
        host,
        (rows.get(host) ?? []).filter((entry) => entry.token !== token)
      );
    },
  });

  const ROOT = process.cwd();
  rememberForgeToken("github.com", "ghp_jick", "jick-lampago");

  const saved = rows.get("github.com") ?? [];
  assert.equal(saved.length, 1, "the token is written to the store");
  assert.equal(saved[0]?.token, "ghp_jick");
  assert.equal(saved[0]?.login, "jick-lampago");
  assert.equal(
    saved[0]?.source,
    "stored",
    "and is marked as Atelier's own, not mistaken for an env token"
  );

  // Host keys are normalized, so GitHub.com and github.com are one host.
  rememberForgeToken("GitHub.com", "ghp_second", "someone-else");
  assert.equal((rows.get("github.com") ?? []).length, 2);
  assert.equal(rows.get("GitHub.com"), undefined);

  // Re-adding the same token updates rather than duplicating it.
  rememberForgeToken("github.com", "ghp_jick", "jick-lampago");
  assert.equal((rows.get("github.com") ?? []).length, 2, "no duplicate row");

  // It reaches the ladder, ahead of anything discovered.
  const candidates = await forgeAuthCandidates(
    ROOT,
    "github",
    "github.com",
    "dftech-dev/finops-crystal-lens"
  );
  const stored = candidates.filter((auth) => auth.source === "stored");
  assert.equal(stored.length, 2, "both saved tokens are offered");
  assert.equal(
    candidates[0]?.source,
    "stored",
    "a token the user added leads the ladder"
  );

  // Forgetting one leaves the other.
  forgetForgeToken("github.com", "ghp_second");
  assert.deepEqual(
    (rows.get("github.com") ?? []).map((entry) => entry.token),
    ["ghp_jick"]
  );

  // A store that throws must not take the pane down with it.
  setForgeTokenStore({
    read: () => {
      throw new Error("db is locked");
    },
    write: () => {
      throw new Error("db is locked");
    },
    remove: () => {
      throw new Error("db is locked");
    },
  });
  clearForgeAuth();
  rememberForgeToken("github.com", "ghp_fallback", "jick-lampago");
  const afterFailure = await forgeAuthCandidates(
    ROOT,
    "github",
    "github.com",
    "dftech-dev/finops-crystal-lens"
  );
  assert.ok(
    afterFailure.some((auth) => auth.token === "ghp_fallback"),
    "a failed write falls back to memory rather than losing the token"
  );
}

void main();
