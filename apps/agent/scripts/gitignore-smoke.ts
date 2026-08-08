import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureAtelierGitignored } from "../src/workspace/ignore.js";

const tempPrefix = path.join(os.tmpdir(), "atelier-gitignore-smoke-");
const tempRoot = fs.mkdtempSync(tempPrefix);

try {
  const repo = path.join(tempRoot, "repo");
  const nestedWorkspace = path.join(repo, "packages", "app");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(nestedWorkspace, { recursive: true });
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/", "utf8");

  assert.equal(ensureAtelierGitignored(nestedWorkspace), true);
  assert.equal(
    fs.readFileSync(path.join(repo, ".gitignore"), "utf8"),
    "node_modules/\n.atelier/\n"
  );
  assert.equal(ensureAtelierGitignored(nestedWorkspace), false);

  const worktree = path.join(tempRoot, "worktree");
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, ".git"), "gitdir: elsewhere", "utf8");
  assert.equal(ensureAtelierGitignored(worktree), true);
  assert.equal(
    fs.readFileSync(path.join(worktree, ".gitignore"), "utf8"),
    ".atelier/\n"
  );

  const plainFolder = path.join(tempRoot, "plain");
  fs.mkdirSync(plainFolder);
  assert.equal(ensureAtelierGitignored(plainFolder), false);
  assert.equal(fs.existsSync(path.join(plainFolder, ".gitignore")), false);

  console.log("atelier gitignore smoke passed");
} finally {
  if (tempRoot.startsWith(tempPrefix)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
