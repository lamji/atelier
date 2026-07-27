import { shapeDefault } from "./shapers/shape-default.js";
import { shapeGraph } from "./shapers/shape-graph.js";
import { shapeImpact } from "./shapers/shape-impact.js";
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
    return shaped ?? shapeDefault(result);
  } catch {
    return shapeDefault(result);
  }
}

function shaperFor(tool: string): Shaper | undefined {
  switch (tool) {
    case "retrieve_knowledge":
    case "search_workspace":
      return shapeRetrieval;
    case "query_knowledge_graph":
      return shapeGraph;
    case "impact_of_edit":
    case "analyze_impact":
      return shapeImpact;
    case "run_terminal":
      return shapeTerminal;
    case "read_file":
      return shapeReadFile;
    default:
      return undefined;
  }
}
