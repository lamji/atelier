/**
 * Smoke: the model roster the composer's picker shows is read live from
 * the Claude Agent SDK, not from a hardcoded list. Fails loudly if the
 * probe comes back empty (the UI would silently fall back) or if the
 * rows carry no description — the version blurb the picker renders.
 */
import { probeModels } from "../src/orchestrator/models-probe.js";

const models = await probeModels(process.cwd());

if (models.length === 0) {
  console.error("FAIL: probe returned no models — picker would fall back");
  process.exit(1);
}

for (const m of models) {
  const resolved = m.resolvedModel ? ` -> ${m.resolvedModel}` : "";
  console.log(`${m.value}${resolved}\n    ${m.label} · ${m.description ?? "(no description)"}`);
}

const described = models.filter((m) => m.description).length;
console.log(`\nOK: ${models.length} models, ${described} with descriptions`);

if (described === 0) {
  console.error("FAIL: no descriptions — picker would show bare names");
  process.exit(1);
}
