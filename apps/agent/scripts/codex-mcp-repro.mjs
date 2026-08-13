// Temporary diagnostic: bare MCP probe, for running under node vs electron.
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const esc = (v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "../dist-electron/codex-mcp.mjs");
const elec = path.join(
  here,
  "../../desktop/node_modules/electron/dist/electron.exe"
);

import os from "node:os";
const g = process.argv[3] ?? "";
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "codex-g-ws-"));
const outMsg = path.join(os.tmpdir(), `codex-g-out-${Date.now()}.txt`);
const args = [
  "exec", "-",
  "--ignore-user-config", "--ignore-rules",
  ...(g === "g1" ? ["--cd", ws, "--sandbox", "read-only", "--output-last-message", outMsg] : []),
  ...(g === "g2" ? ["-c", "features.shell_tool=false", "-c", "mcp_servers.atelier.tool_timeout_sec=120"] : []),
  "--skip-git-repo-check", "--color", "never", "--json",
  "-c", "mcp_servers.atelier.required=true",
  "-c", "mcp_servers.atelier.startup_timeout_sec=30",
  "-c", `mcp_servers.atelier.command="${esc(elec)}"`,
  "-c", `mcp_servers.atelier.args=["${esc(entry)}"]`,
  "-c", `mcp_servers.atelier.cwd="${esc(path.dirname(entry))}"`,
  "-c", 'mcp_servers.atelier.env.ELECTRON_RUN_AS_NODE="1"',
  "-c", 'mcp_servers.atelier.env.ATELIER_CODEX_TOOL_URL="http://127.0.0.1:9/call"',
  "-c", 'mcp_servers.atelier.env.ATELIER_CODEX_TOOL_TOKEN="x"',
];

const r = await execa("codex", args, {
  input: process.argv[2]
    ? fs.readFileSync(process.argv[2], "utf8")
    : "List the MCP tools available to you, names only. If none, say NONE.",
  reject: false,
  timeout: 120_000,
  windowsHide: true,
  all: true,
  env: { ...process.env, FORCE_COLOR: "0" },
  cwd: g === "g1" ? ws : undefined,
});
const all = r.all ?? "";
const used = all.includes("mcp_tool_call") || all.includes("mcp__atelier__");
const tokens = (all.match(/"input_tokens":(\d+)/) ?? [])[1];
console.log(
  `runtime=${process.versions.electron ? "electron" : "node"}: ` +
    `exit=${r.exitCode} atelier=${used} tokens=${tokens}`
);
