/**
 * Proves terminal workspace confinement distinguishes debugging URLs from
 * Windows drive paths while retaining the real filesystem escape guards.
 *
 *   pnpm --filter @atelier/agent smoke:terminal-confinement
 */
import assert from "node:assert/strict";
import { assertCommandConfined } from "../src/tools/terminal-tools.js";

const workspaceRoot =
  process.platform === "win32"
    ? "C:\\workspace\\atelier"
    : "/workspace/atelier";

const debuggingCommands = [
  'curl -s -o resp.txt -w "%{http_code}" "http://localhost:8080/api/v1/contract-level/aggregate?billing_accounts=01F185-0AA423-C9BA8A"',
  'curl "https://dev.spndx.ai/api/v1/auth/login"',
  'curl "ws://localhost:3000/socket"',
  'curl "git+ssh://example.com/repository"',
];

for (const command of debuggingCommands) {
  assert.doesNotThrow(
    () => assertCommandConfined(command, workspaceRoot),
    `debugging URL should be allowed: ${command}`
  );
}

const blockedCommands = [
  "type D:\\outside\\secret.txt",
  "type ..\\secret.txt",
  "type %USERPROFILE%\\secret.txt",
];

for (const command of blockedCommands) {
  assert.throws(
    () => assertCommandConfined(command, workspaceRoot),
    /outside the workspace/,
    `filesystem escape should remain blocked: ${command}`
  );
}

console.log("terminal-confinement smoke passed");
