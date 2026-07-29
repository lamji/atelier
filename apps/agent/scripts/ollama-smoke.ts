/**
 * Smoke: the isolated Ollama backend. Checks the daemon is reachable,
 * lists what it has pulled, shows how those rows reach the model picker,
 * and runs one real tool-less completion through the same router the
 * agent's stage calls / git drafts / feature summaries use.
 *
 * Usage: pnpm smoke:ollama [model-tag]
 */
import {
  isCloudHost,
  listOllamaModels,
  ollamaApiKey,
  ollamaHost,
  ollamaReachable,
} from "../src/providers/ollama/client.js";
import { probeOllamaModels } from "../src/providers/ollama/models.js";
import { runOneShot } from "../src/providers/one-shot.js";

console.log(`host:   ${ollamaHost()}`);
console.log(`mode:   ${isCloudHost() ? "Ollama Cloud" : "local daemon"}`);
console.log(`apikey: ${ollamaApiKey() ? "set" : "not set"}`);

if (!(await ollamaReachable())) {
  console.error(
    isCloudHost()
      ? "\nFAIL: ollama.com did not answer — check OLLAMA_API_KEY and network."
      : "\nFAIL: no local daemon answered — is `ollama serve` running?\n" +
          "For cloud models, either sign in (`ollama signin`) or set OLLAMA_API_KEY."
  );
  process.exit(1);
}

const models = await listOllamaModels();
if (models.length === 0) {
  console.error(
    "\nFAIL: reachable, but no models listed.\n" +
      "Local: `ollama pull qwen3-coder`. Cloud: add a model to your account."
  );
  process.exit(1);
}

console.log(`\npulled (${models.length}):`);
for (const m of models) {
  const size = [m.parameterSize, m.quantization].filter(Boolean).join(" ");
  console.log(`  ${m.name}${size ? `  [${size}]` : ""}`);
}

const options = await probeOllamaModels();
console.log("\nas picker rows:");
for (const o of options) console.log(`  ${o.value}  ·  ${o.description}`);

const target = process.argv[2] ?? models[0]?.name;
console.log(`\none-shot through the router on "${target}"…`);

const text = await runOneShot({
  model: `ollama/${target}`,
  claudeFallback: "claude-haiku-4-5",
  system: "Reply with ONLY a git commit subject line, no quotes, no prose.",
  prompt: "Changed files:\nsrc/auth/login.ts\nsrc/auth/session.ts",
});

if (!text.trim()) {
  console.error("FAIL: model returned empty text");
  process.exit(1);
}

console.log(`\n  -> ${text.trim().split("\n")[0]}`);
console.log("\nOK: routed to Ollama, no Claude call made");
