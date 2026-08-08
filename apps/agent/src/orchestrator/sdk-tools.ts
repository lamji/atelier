import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ImageAttachment } from "@atelier/protocol";
import type { ToolRegistry } from "../tools/registry.js";
import { shapeToolOutput } from "../context/tool-output/index.js";

export const MCP_SERVER_NAME = "atelier";

/** Per-task context threaded into model-invoked tool calls. */
export interface SdkToolContext {
  taskId: string;
  signal: AbortSignal;
}

function asText(
  tool: string,
  result: unknown
): { content: Array<{ type: "text"; text: string }> } {
  // Shaped, compact output: tool results ride in the SDK session transcript
  // on every later turn, so compression here pays repeatedly.
  return { content: [{ type: "text", text: shapeToolOutput(tool, result) }] };
}

/**
 * Exposes the tool registry to the model as an in-process MCP server.
 * Every call routes through ToolRegistry.run, so tool.* events and hooks
 * fire identically to UI-invoked calls. Names surface to the model as
 * mcp__atelier__<name>.
 */
export function createAtelierMcpServer(
  registry: ToolRegistry,
  getContext: () => SdkToolContext,
  /** Reads back an image this conversation attached, for `view_image`. */
  loadImage?: (path: string) => ImageAttachment | null
): McpSdkServerConfigWithInstance {
  const run = async (name: string, input: unknown) => {
    const ctx = getContext();
    try {
      const result = await registry.run(name, input, ctx.taskId, ctx.signal);
      return asText(name, result);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
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
        "forward slashes. For a large file or a known line range, pass " +
        "offset (1-based start line) and/or limit (max lines) to read a " +
        "slice instead of the whole file. Always prefer this over " +
        "run_terminal for inspecting file contents.",
      {
        path: z.string().describe("Workspace-relative file path"),
        offset: z
          .number()
          .optional()
          .describe("1-based line number to start reading from"),
        limit: z.number().optional().describe("Max number of lines to return"),
      },
      (input) => run("read_file", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "read_many_files",
      "Read up to 20 workspace files or line slices in one call. Prefer this " +
        "when you need context from multiple known files; it is faster than " +
        "several read_file calls and returns compact per-file sections.",
      {
        files: z
          .array(
            z.object({
              path: z.string().describe("Workspace-relative file path"),
              offset: z
                .number()
                .optional()
                .describe("1-based line number to start reading from"),
              limit: z
                .number()
                .optional()
                .describe("Max number of lines to return"),
            })
          )
          .describe("Files or line slices to read"),
      },
      (input) => run("read_many_files", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "write_file",
      "Create a NEW file, or fully replace one whose content is genuinely " +
        "being thrown away. To change part of an existing file use " +
        "replace_code instead — restating lines that already say the right " +
        "thing is slower, buries the real change in the diff, and risks " +
        "dropping the parts you meant to keep. A blocking hook enforces " +
        "this. Emits an observable diff before applying.",
      {
        path: z.string().describe("Workspace-relative file path"),
        content: z.string().describe("Full new file content"),
      },
      (input) => run("write_file", input)
    ),
    tool(
      "replace_code",
      "Replace an exact string in a file. The default way to edit an " +
        "existing file. oldString must match exactly and be unique unless " +
        "replaceAll is true; include just enough surrounding lines to be " +
        "unique, not the whole enclosing block.",
      {
        path: z.string(),
        oldString: z.string(),
        newString: z.string(),
        replaceAll: z.boolean().optional(),
      },
      (input) => run("replace_code", input)
    ),
    tool(
      "replace_many",
      "Apply up to 50 exact string replacements across one or more files in " +
        "one call. Edits are grouped so each touched file is written once and " +
        "still emits an observable diff.",
      {
        edits: z.array(
          z.object({
            path: z.string().describe("Workspace-relative file path"),
            oldString: z.string().describe("Exact old string"),
            newString: z.string().describe("Replacement string"),
            replaceAll: z.boolean().optional(),
          })
        ),
      },
      (input) => run("replace_many", input)
    ),
    tool(
      "search_workspace",
      "Find the files relevant to a query using the live knowledge index " +
        "(synced to the latest tree) — e.g. 'login' returns the files that " +
        "implement login, ranked by relevance, each with a line and a " +
        "one-line preview. Optional glob filter like src/**/*.ts.",
      {
        query: z.string(),
        glob: z.string().optional(),
        maxResults: z.number().optional(),
      },
      (input) => run("search_workspace", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "search_text",
      "Fast literal or regex text search over non-ignored workspace files. " +
        "Use this when you need exact text matches; use search_workspace or " +
        "retrieve_knowledge for semantic/conceptual lookup.",
      {
        query: z.string(),
        glob: z.string().optional(),
        maxResults: z.number().optional(),
        regex: z.boolean().optional(),
      },
      (input) => run("search_text", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "list_dir",
      "List files and directories at a workspace-relative path (omit path " +
        "for the workspace root). Paths are relative to the WORKSPACE ROOT, " +
        "not to any project inside it — see WORKSPACE LAYOUT for the " +
        "prefixes. Never assume a conventional folder exists: if the path " +
        "is wrong this returns the nearest real directory plus a note " +
        "saying what was missing, so read the note instead of retrying.",
      { path: z.string().optional() },
      (input) => run("list_dir", input),
      { annotations: { readOnlyHint: true } }
    ),
    tool(
      "git",
      "Run a git operation. Actions: status, log, diff, stage, unstage, " +
        "commit, branches, checkout. Prefer this over run_terminal for git " +
        "so changes stay observable. The opened folder is often NOT the " +
        "repository — it can hold several checkouts side by side — so a " +
        "path you pass routes to the checkout that owns it, and `repo` " +
        "picks one explicitly. Omit `repo` to act on the session's scoped " +
        "checkout; all paths stay workspace-relative in both directions.",
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
        repo: z
          .string()
          .optional()
          .describe(
            "Workspace-relative directory of the checkout to act on " +
              '(e.g. "my-app"). Omit to use the session\'s scoped checkout.'
          ),
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
        "return its output and exit code. Use for builds, tests, and " +
        "package managers (prefer the git tool for git). Not interactive. " +
        "Do not use this to read or search files — use read_file (with " +
        "offset/limit for a range) or search_workspace instead.",
      {
        command: z.string().describe("The command line to execute"),
        cwd: z.string().optional().describe("Workspace-relative working dir"),
        timeoutMs: z.number().optional(),
      },
      (input) => run("run_terminal", input)
    ),
    tool(
      "view_image",
      "Look at an image attached earlier in this conversation, by the path " +
        "given in the context or in session memory. Returns the picture " +
        "itself. Call it whenever the request refers to something that was " +
        "shown rather than written — a screenshot, a mockup, a diagram, " +
        "'the image', 'the error above' — instead of answering from an " +
        "earlier description of it. If the picture carries a drawn mark " +
        "(box, arrow, circle, highlight), that mark is the subject of the " +
        "request: say in one line what you read it as pointing at.",
      { path: z.string().describe("Path of the attachment, as given to you") },
      async (input: { path: string }) => {
        const image = loadImage?.(input.path) ?? null;
        if (!image) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `No attachment at ${input.path}. Use a path exactly as ` +
                  "given in the context; do not guess one.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "image" as const,
              data: image.data,
              mimeType: image.mediaType,
            },
          ],
        };
      },
      { annotations: { readOnlyHint: true } }
    ),
  ];

  return createSdkMcpServer({ name: MCP_SERVER_NAME, version: "0.1.0", tools });
}
