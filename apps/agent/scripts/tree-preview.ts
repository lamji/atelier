/**
 * Directory-map preview: renders the block the model actually receives for
 * a given root, and reports what it costs.
 *
 *   tsx scripts/tree-preview.ts [relRoot] [maxChars]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceIgnore } from "../src/workspace/ignore.js";
import { renderProjectTree } from "../src/workspace/profile/project-tree.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const relRoot = process.argv[2] ?? "";
const maxChars = process.argv[3] ? Number(process.argv[3]) : undefined;

const ignore = new WorkspaceIgnore(root);
const block = await renderProjectTree(root, relRoot, ignore, maxChars);

console.log(block);
console.log(
  `--- ${block.length} chars, ~${Math.round(block.length / 4)} tokens, ` +
    `${block.split("\n").length} lines`
);
