/**
 * What the composer's model picker would show right now, and what each
 * provider cost to ask.
 *
 * The picker is assembled from four probes, and a provider that answers
 * with nothing looks identical to one that was never asked: the row simply
 * is not there. This says which is which, so "Codex is missing" can be
 * answered with a reason instead of a guess.
 *
 *   pnpm --filter @atelier/agent probe:roster
 */
import { probeCodexAuth, probeCodexModels } from "../src/providers/codex/models.js";
import { probeOllamaModels } from "../src/providers/ollama/models.js";
import { probeGrokModels } from "../src/providers/grok/models.js";
import { probeModels } from "../src/orchestrator/models-probe.js";
import {
  CLAUDE,
  CODEX,
  enabledModelsFor,
  OLLAMA_CLOUD,
  OLLAMA_LOCAL,
  providerEnabled,
} from "../src/providers/credentials.js";

const cwd = process.argv[2] ?? process.cwd();

async function timed<T>(
  name: string,
  run: () => Promise<T>
): Promise<{ name: string; ms: number; value?: T; error?: string }> {
  const started = Date.now();
  try {
    const value = await run();
    return { name, ms: Date.now() - started, value };
  } catch (error) {
    return {
      name,
      ms: Date.now() - started,
      error: (error as Error).message ?? String(error),
    };
  }
}

console.log(`workspace: ${cwd}\n`);
console.log("switches (machine-global providers.json):");
for (const id of [CLAUDE, CODEX, OLLAMA_LOCAL, OLLAMA_CLOUD]) {
  const allow = enabledModelsFor(id);
  console.log(
    `  ${id.padEnd(13)} enabled=${providerEnabled(id)}` +
      (allow.length > 0 ? ` allowlist=${allow.length}` : "")
  );
}

console.log("\nprobes:");
const codexAuth = await timed("codex auth", () => probeCodexAuth());
console.log(
  `  codex auth      ${String(codexAuth.ms).padStart(6)}ms  ` +
    `ok=${codexAuth.value?.ok ?? false}  ${codexAuth.value?.detail ?? codexAuth.error ?? ""}`
);

for (const [name, run] of [
  ["claude", () => probeModels(cwd)],
  ["codex", () => probeCodexModels()],
  ["ollama", () => probeOllamaModels()],
  ["grok", () => probeGrokModels()],
] as const) {
  const result = await timed(name, run);
  const rows = result.value?.length ?? 0;
  console.log(
    `  ${name.padEnd(15)} ${String(result.ms).padStart(6)}ms  ${rows} model(s)` +
      (result.error ? `  ERROR ${result.error}` : "")
  );
  for (const model of (result.value ?? []).slice(0, 4)) {
    console.log(`      ${model.value}`);
  }
  if (rows > 4) console.log(`      … ${rows - 4} more`);
}
