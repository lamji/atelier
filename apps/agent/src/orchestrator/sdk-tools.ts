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
