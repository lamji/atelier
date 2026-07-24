import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ToolRegistry } from "../tools/registry.js";

export const MCP_SERVER_NAME = "atelier";

/** Per-task context threaded into model-invoked tool calls. */
export interface SdkToolContext {
  taskId: string;
  signal: AbortSignal;
}

function asText(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

/**
 * Exposes the tool registry to the model as an in-process MCP server.
 * Every call routes through ToolRegistry.run, so tool.* events and hooks
 * fire identically to UI-invoked calls. Names surface to the model as
 * mcp__atelier__<name>.
 */
export function createAtelierMcpServer(
  registry: ToolRegistry,
  getContext: () => SdkToolContext
): McpSdkServerConfigWithInstance {
  const run = async (name: string, input: unknown) => {
    const ctx = getContext();
    try {
      const result = await registry.run(name, input, ctx.taskId, ctx.signal);
      return asText(result);
    } catch (error) {
      return {
        content: [
          { type: "text" as const, text: `Error: ${String(error)}` },
        ],
        isError: true,
      };
    }
  };

  const tools = [
    tool(
      "read_file",
      "Read a text file from the workspace. Path is workspace-relative with " +
        "forward slashes.",
      { path: z.string().describe("Workspace-relative file path") },
      (input) => run("read_file", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "write_file",
      "Create or fully overwrite a text file in the workspace. Emits an " +
        "observable diff before applying.",
      {
        path: z.string().describe("Workspace-relative file path"),
        content: z.string().describe("Full new file content"),
      },
      (input) => run("write_file", input)
    ),
    tool(
      "replace_code",
      "Replace an exact string in a file. oldString must match exactly and " +
        "be unique unless replaceAll is true.",
      {
        path: z.string(),
        oldString: z.string(),
        newString: z.string(),
        replaceAll: z.boolean().optional(),
      },
      (input) => run("replace_code", input)
    ),
    tool(
      "search_workspace",
      "Search file contents in the workspace. Returns path/row/col/line " +
        "matches. Optional glob filter like src/**/*.ts.",
      {
        query: z.string(),
        glob: z.string().optional(),
        maxResults: z.number().optional(),
        regex: z.boolean().optional(),
      },
      (input) => run("search_workspace", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "list_dir",
      "List files and directories at a workspace-relative path.",
      { path: z.string().optional() },
      (input) => run("list_dir", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "git",
      "Run a git operation in the workspace repository. Actions: status, " +
        "log, diff, stage, unstage, commit, branches, checkout. Prefer this " +
        "over run_terminal for git so changes stay observable.",
      {
        action: z
          .enum([
            "status",
            "log",
            "diff",
            "stage",
            "unstage",
            "commit",
            "branches",
            "checkout",
          ])
          .describe("The git operation to perform"),
        paths: z
          .array(z.string())
          .optional()
          .describe("Workspace-relative paths (stage/unstage)"),
        path: z.string().optional().describe("Single file to diff"),
        staged: z.boolean().optional().describe("Diff the staged version"),
        ref: z
          .string()
          .optional()
          .describe("Ref to diff against, or branch for checkout"),
        message: z.string().optional().describe("Commit message"),
        create: z.boolean().optional().describe("Create the branch on checkout"),
        maxCount: z.number().optional().describe("Max commits for log"),
      },
      (input) => run("git", input)
    ),
    tool(
      "retrieve_knowledge",
      "Answer 'where/how is X handled?' questions from the workspace " +
        "knowledge index (symbols, call graph, embeddings). Returns scored " +
        "code chunks with paths and line ranges plus matched symbols. " +
        "Prefer this over search_workspace for conceptual questions.",
      {
        query: z.string().describe("Natural-language or symbol query"),
        k: z.number().optional().describe("Max chunks to return (default 12)"),
        pathGlob: z
          .string()
          .optional()
          .describe("Restrict results to paths matching this glob"),
      },
      (input) => run("retrieve_knowledge", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "query_knowledge_graph",
      "Query the code graph: imports, call edges, and symbols. Scopes: " +
        "'workspace' (file import graph), 'file' (one file's imports, " +
        "importers, and symbols; target = workspace-relative path), " +
        "'symbol' (callers/callees; target = symbol name or id), 'feature'.",
      {
        scope: z.enum(["file", "symbol", "feature", "workspace"]),
        target: z.string().optional().describe("Path, symbol name, or slug"),
        depth: z.number().optional().describe("Neighborhood depth (default 1)"),
      },
      (input) => run("query_knowledge_graph", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "search_symbols",
      "Fuzzy-search indexed symbols by name. Returns kind, path, line " +
        "range, and signature for each match.",
      {
        query: z.string().describe("Symbol name or fragment"),
        limit: z.number().optional(),
      },
      (input) => run("search_symbols", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "impact_of_edit",
      "BEFORE editing a specific place, check who uses it. Given a file " +
        "and the line you're about to change (or the symbol name), returns " +
        "the enclosing symbol, whether it's exported, and every call / " +
        "reference / import of it — same-file and cross-file — plus a " +
        "verdict: isolated, local, or shared. Use it to decide whether to " +
        "update the callers too or keep the contract stable and isolate.",
      {
        path: z.string().describe("Workspace-relative file you're editing"),
        line: z
          .number()
          .optional()
          .describe("1-based line you're about to change"),
        symbol: z
          .string()
          .optional()
          .describe("Symbol name at the edit site (instead of line)"),
      },
      (input) => run("impact_of_edit", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "analyze_impact",
      "Coarser, file-level check: find what depends on whole files — " +
        "importers, callers, transitive ripple, and risk lessons. For a " +
        "precise 'who uses this exact symbol' check, prefer impact_of_edit.",
      {
        files: z
          .array(z.string())
          .optional()
          .describe("Workspace-relative paths you plan to change"),
        symbols: z
          .array(z.string())
          .optional()
          .describe("Symbol names you plan to change (e.g. convertCurrency)"),
        depth: z
          .number()
          .optional()
          .describe("Ripple depth 1-3 (default 1 = direct dependents)"),
      },
      (input) => run("analyze_impact", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "update_plan_step",
      "Report progress on the current task plan. Call when you start a " +
        "step (in-progress) and when you finish it (done/failed/skipped). " +
        "Step ids appear in the PLAN section of your context.",
      {
        stepId: z.string().describe("The [step_...] id from the plan"),
        status: z.enum([
          "pending",
          "in-progress",
          "done",
          "failed",
          "cancelled",
          "skipped",
        ]),
        note: z.string().optional().describe("Optional short note"),
      },
      (input) => run("update_plan_step", input)
    ),
    tool(
      "save_lesson",
      "Persist a distilled, reusable insight into the knowledge engine so " +
        "it is never re-discovered the hard way. Call this when a fix is " +
        "confirmed working after real difficulty (wrong attempts, multiple " +
        "follow-ups), or when you hit a non-obvious gotcha or project " +
        "convention. Keep it tiny: title one line, lesson <= 500 chars " +
        "stating the trap and the correct approach. Anchor it with the " +
        "symbols/files involved — future tasks touching them will retrieve " +
        "it automatically.",
      {
        title: z.string().describe("One-line summary of the insight"),
        lesson: z
          .string()
          .describe("The distilled lesson: the trap + the correct approach"),
        kind: z.enum(["bug-fix", "gotcha", "pattern", "preference"]).optional(),
        symbols: z
          .array(z.string())
          .optional()
          .describe("Symbol names this applies to (e.g. convertCurrency)"),
        files: z
          .array(z.string())
          .optional()
          .describe("Workspace-relative file paths this applies to"),
      },
      (input) => run("save_lesson", input)
    ),
    tool(
      "run_terminal",
      "Run a shell command (PowerShell on Windows) in the workspace and " +
        "return its output and exit code. Use for builds, tests, git, and " +
        "package managers. Not interactive.",
      {
        command: z.string().describe("The command line to execute"),
        cwd: z.string().optional().describe("Workspace-relative working dir"),
        timeoutMs: z.number().optional(),
      },
      (input) => run("run_terminal", input)
    ),
  ];

  return createSdkMcpServer({ name: MCP_SERVER_NAME, version: "0.1.0", tools });
}
