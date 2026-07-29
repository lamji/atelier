import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServerInfo } from "@atelier/protocol";

/**
 * Discovers the MCP servers a run will have, from the same files Claude
 * Code reads:
 *
 *   <workspace>/.mcp.json            (project, checked in)
 *   <workspace>/.claude/settings.json
 *   ~/.claude.json                   (user, global)
 *   ~/.claude/settings.json
 *
 * Read fresh per request, so editing a config shows up without a restart.
 * Read-only: this reports what is configured, it does not manage it.
 */
export function listMcpServers(
  workspaceRoot: string,
  builtinName: string
): McpServerInfo[] {
  const servers: McpServerInfo[] = [
    {
      name: builtinName,
      scope: "builtin",
      transport: "in-process",
      detail: "Atelier's own tools (knowledge, impact, plan, git)",
      source: "",
    },
  ];

  const sources: Array<[string, McpServerInfo["scope"]]> = [
    [path.join(os.homedir(), ".claude.json"), "user"],
    [path.join(os.homedir(), ".claude", "settings.json"), "user"],
    [path.join(workspaceRoot, ".mcp.json"), "project"],
    [path.join(workspaceRoot, ".claude", "settings.json"), "project"],
  ];

  for (const [file, scope] of sources) {
    for (const server of readServers(file, scope)) {
      // Project config wins over user config for the same name, matching
      // how Claude Code resolves them.
      const existing = servers.findIndex((s) => s.name === server.name);
      if (existing === -1) servers.push(server);
      else if (servers[existing]?.scope !== "builtin") servers[existing] = server;
    }
  }

  return servers;
}

function readServers(
  file: string,
  scope: McpServerInfo["scope"]
): McpServerInfo[] {
  const raw = readFileSafe(file);
  if (!raw) return [];
  let parsed: { mcpServers?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
  } catch {
    return [];
  }
  const entries = Object.entries(parsed.mcpServers ?? {});
  return entries.map(([name, value]) => {
    const config = (value ?? {}) as {
      command?: string;
      args?: string[];
      url?: string;
      type?: string;
    };
    const url = config.url;
    return {
      name,
      scope,
      transport: url ? (config.type ?? "http") : "stdio",
      detail: url ?? [config.command, ...(config.args ?? [])].join(" ").trim(),
      source: file,
    };
  });
}

function readFileSafe(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
