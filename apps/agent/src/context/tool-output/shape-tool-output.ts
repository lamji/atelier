import { approxTokens } from "@atelier/shared";
import { shapeDefault } from "./shapers/shape-default.js";
import { shapeGraph } from "./shapers/shape-graph.js";
import { shapeImpact } from "./shapers/shape-impact.js";
import { shapeListDir } from "./shapers/shape-list-dir.js";
import { shapeReadFile } from "./shapers/shape-read-file.js";
import { shapeRetrieval } from "./shapers/shape-retrieval.js";
import { shapeTerminal } from "./shapers/shape-terminal.js";

type Shaper = (result: unknown) => string | null;

/**
 * Compresses a tool result before it enters the model transcript. Tool
 * results are the dominant input cost: the SDK session replays them on
 * every later turn, so each byte saved here is saved repeatedly. Shapers
 * keep field names intact and mark omissions explicitly; unknown or
 * unexpected shapes fall back to compact JSON.
 */
export function shapeToolOutput(tool: string, result: unknown): string {
  try {
    const shaped = shaperFor(tool)?.(result);
    return capResult(tool, shaped ?? shapeDefault(result));
  } catch {
    return capResult(tool, shapeDefault(result));
  }
}

/**
 * Ceiling for one tool result in the transcript.
 *
 * The SDK session replays every result on every later request, so one
 * 50k-token file read is paid again on each of the rounds after it — a
 * task that opened three large files was re-reading 160k tokens per
 * request from the first round on. Ollama has fitToWindow to elide old
 * results; Claude's transcript is the SDK's, so the only lever is the size
 * of what enters it. A capped result says exactly how to get the rest.
 */
export const MAX_RESULT_TOKENS = 8_000;

function capResult(tool: string, text: string): string {
  if (approxTokens(text) <= MAX_RESULT_TOKENS) return text;
  const maxChars = MAX_RESULT_TOKENS * 4;
  // Cut on a line boundary so a clipped file ends on a whole line.
  const boundary = text.lastIndexOf("\n", maxChars);
  const head = text.slice(0, boundary > maxChars * 0.8 ? boundary : maxChars);
  const shownLines = head.split("\n").length;
  const totalLines = text.split("\n").length;
  const more = Math.max(0, totalLines - shownLines);
  const how = READ_TOOLS.has(tool)
    ? `call ${tool} again with offset=${shownLines + 1} (and a limit) for the rest`
    : "narrow the request (a smaller range, a more specific query) for the rest";
  return (
    `${head}\n[… result capped at ~${MAX_RESULT_TOKENS / 1000}k tokens: ` +
    `${more} more line(s) not shown — ${how}]`
  );
}

const READ_TOOLS = new Set(["read_file", "read_many_files"]);

function shaperFor(tool: string): Shaper | undefined {
  switch (tool) {
    case "retrieve_knowledge":
      return shapeRetrieval;
    case "query_knowledge_graph":
      return shapeGraph;
    case "impact_of_edit":
    case "analyze_impact":
      return shapeImpact;
    case "list_dir":
      return shapeListDir;
    case "run_terminal":
      return shapeTerminal;
    case "read_file":
    case "read_many_files":
      return shapeReadFile;
    default:
      return undefined;
  }
}
