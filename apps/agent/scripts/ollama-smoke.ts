/**
 * Smoke: the isolated Ollama backend, both endpoints.
 *
 * Ollama appears in Atelier twice — the daemon on this machine and the
 * hosted account — and they are independent providers with their own host,
 * key and roster. This checks each one that is configured: reachability,
 * what it has pulled, and the picker rows those become. It then runs one
 * real tool-less completion through the same router the agent's stage
 * calls / git drafts / feature summaries use, so the id → endpoint routing
 * is proven rather than assumed.
 *
 * Usage: pnpm smoke:ollama [model-tag] [local|cloud]
 */
import {
  isCloudHost,
  listOllamaModels,
  ollamaApiKey,
  ollamaHost,
  ollamaReachable,
  resolveNumCtx,
} from "../src/providers/ollama/client.js";
import { probeOllamaModels } from "../src/providers/ollama/models.js";
import {
  OLLAMA_LOCAL_PREFIX,
  OLLAMA_PREFIX,
  type OllamaTarget,
} from "../src/providers/model-routing.js";
import { enabledModelsFor } from "../src/providers/credentials.js";
import { runOneShot } from "../src/providers/one-shot.js";

const TARGETS: OllamaTarget[] = ["ollama-local", "ollama-cloud"];
const PREFIX: Record<OllamaTarget, string> = {
  "ollama-local": OLLAMA_LOCAL_PREFIX,
  "ollama-cloud": OLLAMA_PREFIX,
};

/** Endpoints that answered, with what they have. */
const live: Array<{ target: OllamaTarget; models: string[] }> = [];

for (const target of TARGETS) {
  const host = ollamaHost(target);
  console.log(`\n── ${target} ──`);
  console.log(`host:    ${host}`);
  console.log(`mode:    ${isCloudHost(target) ? "Ollama Cloud" : "local daemon"}`);
  console.log(`apikey:  ${ollamaApiKey(target) ? "set" : "not set"}`);
  console.log(
    `enabled: ${
      enabledModelsFor(target).join(", ") ||
      (target === "ollama-local" ? "(none stored — all pulled models)" : "(none)")
    }`
  );

  if (!(await ollamaReachable(target))) {
    console.log("status:  no answer — skipped");
    continue;
  }
  const models = await listOllamaModels(target);
  console.log(`pulled (${models.length}):`);
  for (const m of models) {
    const size = [m.parameterSize, m.quantization].filter(Boolean).join(" ");
    // The window Atelier will ask for. A knowledge-engine turn spends
    // ~6k tokens before the model reads anything, so this is the number
    // that decides whether the full pipeline fits or is silently clipped.
    const ctx = await resolveNumCtx(m.name, target);
    console.log(
      `  ${m.name}${size ? `  [${size}]` : ""}  num_ctx=${ctx.toLocaleString()}`
    );
  }
  if (models.length > 0) {
    live.push({ target, models: models.map((m) => m.name) });
  }
}

if (live.length === 0) {
  console.error(
    "\nFAIL: neither endpoint answered with models.\n" +
      "Local: is `ollama serve` running, and is anything pulled?\n" +
      "Cloud: check the API key and network."
  );
  process.exit(1);
}

// The picker roster is the whole point: rows from both endpoints, each
// namespaced so the id says which host serves it.
const options = await probeOllamaModels();
console.log("\nas picker rows:");
for (const o of options) console.log(`  ${o.value}  ·  ${o.description}`);

let failures = 0;
for (const { target, models } of live) {
  const rows = options.filter((o) => o.value.startsWith(PREFIX[target]));
  if (target === "ollama-local" && rows.length !== models.length) {
    // An untouched local allowlist must mean "everything pulled" — that is
    // what makes `ollama pull` show up with no trip to Settings.
    if (enabledModelsFor(target).length === 0) {
      console.error(
        `\nFAIL: ${models.length} local model(s) pulled but ${rows.length} in the picker`
      );
      failures += 1;
    }
  }
  for (const row of rows) {
    const tag = row.value.slice(PREFIX[target].length);
    if (!models.includes(tag)) {
      console.error(`\nFAIL: ${row.value} is not served by ${target}`);
      failures += 1;
    }
  }
}

const pick = live.find((l) => l.target === "ollama-local") ?? live[0]!;
const tag = process.argv[2] ?? pick.models[0]!;
const chosen = (process.argv[3] as OllamaTarget | undefined) ?? pick.target;
const id = `${PREFIX[chosen] ?? PREFIX["ollama-local"]}${tag}`;
console.log(`\none-shot through the router on "${id}"…`);

const text = await runOneShot({
  model: id,
  claudeFallback: "claude-haiku-4-5",
  system: "Reply with ONLY a git commit subject line, no quotes, no prose.",
  prompt: "Changed files:\nsrc/auth/login.ts\nsrc/auth/session.ts",
});

if (!text.trim()) {
  console.error("FAIL: model returned empty text");
  process.exit(1);
}

console.log(`\n  -> ${text.trim().split("\n")[0]}`);
console.log(
  failures === 0
    ? "\nOK: routed to Ollama, no Claude call made"
    : `\n${failures} check(s) failed`
);
process.exit(failures === 0 ? 0 : 1);
