// Stdio MCP server that Codex spawns to reach Atelier's tools.
// It is a build entry, not a script: bundled to codex-mcp.mjs beside
// utility-main.mjs so it runs from `process.execPath` with no pnpm/tsx in
// the packaged app. Keep stdout clean — anything but MCP frames on stdout
// breaks the initialize handshake.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const url = process.env.ATELIER_CODEX_TOOL_URL;
const token = process.env.ATELIER_CODEX_TOOL_TOKEN;
if (!url || !token) {
  throw new Error("Missing ATELIER_CODEX_TOOL_URL or ATELIER_CODEX_TOOL_TOKEN");
}

/**
 * The tools this proxy is allowed to register, comma-separated. Unset means
 * all of them; direct mode (system knowledge off) passes the subset without
 * retrieval, the knowledge graph, or impact analysis.
 */
const allowed = process.env.ATELIER_CODEX_TOOLS
  ? new Set(
      process.env.ATELIER_CODEX_TOOLS.split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    )
  : null;

const server = new McpServer({
  name: "atelier",
  version: "0.1.0",
});

tool(
  "read_file",
  "Read a text file from the workspace. Prefer this over shell commands.",
  {
    path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }
);
tool(
  "read_many_files",
  "Read up to 20 workspace files or line slices in one call. Prefer this over repeated read_file calls.",
  {
    files: z.array(
      z.object({
        path: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      })
    ),
  }
);
tool(
  "write_file",
  "Create a NEW file, or fully replace one whose content is genuinely " +
    "being thrown away. To change part of an existing file use replace_code " +
    "instead — a blocking hook refuses a rewrite that mostly restates the " +
    "file it replaces.",
  {
    path: z.string(),
    content: z.string(),
  }
);
tool("replace_code", "Replace an exact string in a file. The default way to edit.", {
  path: z.string(),
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});
tool("replace_many", "Apply exact replacements across one or more files in one call.", {
  edits: z.array(
    z.object({
      path: z.string(),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    })
  ),
});
tool(
  "search_workspace",
  "Find files relevant to a query using Atelier's live knowledge index. Prefer this over rg.",
  {
    query: z.string(),
    glob: z.string().optional(),
    maxResults: z.number().optional(),
  }
);
tool("search_text", "Fast literal or regex text search over non-ignored workspace files.", {
  query: z.string(),
  glob: z.string().optional(),
  maxResults: z.number().optional(),
  regex: z.boolean().optional(),
});
tool("list_dir", "List files and directories at a workspace-relative path.", {
  path: z.string().optional(),
});
tool("git", "Run observable git operations. Prefer this over shell git.", {
  action: z.enum([
    "status",
    "log",
    "diff",
    "stage",
    "unstage",
    "commit",
    "branches",
    "checkout",
  ]),
  paths: z.array(z.string()).optional(),
  path: z.string().optional(),
  staged: z.boolean().optional(),
  ref: z.string().optional(),
  message: z.string().optional(),
  create: z.boolean().optional(),
  maxCount: z.number().optional(),
});
tool("retrieve_knowledge", "Retrieve relevant code and lessons from Atelier knowledge.", {
  query: z.string(),
  k: z.number().optional(),
  pathGlob: z.string().optional(),
});
tool("query_knowledge_graph", "Query imports, call edges, symbols, or features.", {
  scope: z.enum(["file", "symbol", "feature", "workspace"]),
  target: z.string().optional(),
  depth: z.number().optional(),
});
tool("search_symbols", "Fuzzy-search indexed symbols by name.", {
  query: z.string(),
  limit: z.number().optional(),
});
tool("impact_of_edit", "Before editing a specific place, check who uses it.", {
  path: z.string(),
  line: z.number().optional(),
  symbol: z.string().optional(),
});
tool("analyze_impact", "Find what depends on whole files or symbols.", {
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  depth: z.number().optional(),
});
tool("set_plan", "Create the execution timeline before editing. Later calls " +
  "append newly discovered necessary steps and cannot replace existing work. " +
  "Execute every returned id in order with update_plan_step.", {
  goal: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      detail: z.string().optional(),
      files: z.array(z.string()).optional(),
    })
  ),
});
tool("update_plan_step", "Start and explicitly finish the current timeline " +
  "step. Order is enforced and only done clears the final-report gate.", {
  stepId: z.string(),
  status: z.enum([
    "pending",
    "in-progress",
    "done",
    "failed",
    "cancelled",
    "skipped",
  ]),
  note: z.string().optional(),
});
tool(
  "preview_review",
  "Debug a local Page preview in headless Chromium. Returns status/decision, " +
    "chronological DevTools console, page errors, failed HTTP requests, DOM/layout, " +
    "and screenshots. Obey decision: unavailable = ask user to start/reopen preview " +
    "and stop without retrying or starting a server; issues = report evidence then " +
    "fix if allowed or skip; failed = report and skip. Localhost only.",
  { url: z.string() }
);
tool("run_terminal", "Run a shell command only when no semantic Atelier tool fits.", {
  command: z.string(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
});

// The liveness canary. Handled here in the proxy, never forwarded to the
// registry: its whole job is to prove the MODEL can reach these tools.
// Codex 0.147's exec mode has been observed to complete the MCP handshake
// and still not offer the tools to the model — so neither process spawn
// nor the initialized callback is proof of anything. A tool CALL is: the
// instructions tell the model to ping first, only a model that actually
// has the tools can comply, and the bridge treats a run without this ping
// as a dud to kill and respawn.
server.registerTool(
  "ping",
  {
    description:
      "Atelier bridge connectivity check. Call this ONCE, as your first " +
      "action in every run, before any other tool.",
    inputSchema: {},
  },
  async () => {
    await fetch(url.replace(/\/call$/, "/hello"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, kind: "tool" }),
    }).catch(() => undefined);
    return { content: [{ type: "text", text: "pong — Atelier tools are live" }] };
  }
);

await server.connect(new StdioServerTransport());

function tool(name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>): void {
  if (allowed && !allowed.has(name)) return;
  server.registerTool(
    name,
    { description, inputSchema },
    async (input: unknown) => ({
      content: [{ type: "text", text: await callAtelier(name, input) }],
    })
  );
}

async function callAtelier(name: string, input: unknown): Promise<string> {
  const response = await fetch(url!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name, input }),
  });
  const body = (await response.json()) as { ok?: boolean; text?: string };
  return body.text ?? (body.ok ? "" : "Tool failed without output");
}
