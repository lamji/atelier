/**
 * Phase 5: web-tree-sitter (WASM) parsing in a pool of worker_threads.
 * Grammar .wasm files are vendored under ./grammars.
 */
export interface ParsedFile {
  path: string;
  lang: string;
  symbols: unknown[];
  imports: unknown[];
  exports: unknown[];
  callSites: unknown[];
}

export class ParserPool {
  async init(): Promise<void> {}

  async parseFile(_absPath: string, _relPath: string): Promise<ParsedFile | null> {
    return null;
  }

  async shutdown(): Promise<void> {}
}
