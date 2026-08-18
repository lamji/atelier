/**
 * Session isolation: the left rail lists ATELIER sessions, and every prompt
 * opens a FRESH session on the provider side.
 *
 * Continuity across prompts is Atelier's job, not the provider's — the
 * shared context block, the RAG chunks and the session-memory summaries
 * ride into each new provider session identically. That is what makes a
 * model switch mid-conversation survivable, and it is what keeps the
 * provider's own transcript from growing without bound.
 *
 * The invariant is easy to break by accident (one `resume` default, one
 * persisted session id) and impossible to notice from the UI, so it is
 * asserted structurally here.
 *
 *   pnpm --filter @atelier/agent smoke:session-isolation
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function read(rel: string): string {
  return fs.readFileSync(path.join(here, "..", rel), "utf8");
}

let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) failed += 1;
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

const orchestrator = read("src/orchestrator/orchestrator.ts");
const pipeline = read("src/orchestrator/pipeline-executor.ts");
const conversations = read("src/storage/repositories/conversations.ts");
const codex = read("src/providers/codex/client.ts");

// ── the task starts with no provider session ─────────────────────────────
check(
  "each task begins with no provider session",
  /sdkSessionId:\s*null/.test(orchestrator)
);
check(
  "the task never hands a session id back to the conversation",
  /onSdkSessionId:\s*\(\)\s*=>\s*undefined/.test(orchestrator)
);
check(
  "nothing persists a provider session id",
  !/setSdkSessionId\s*\(/.test(conversations) &&
    !/setSdkSessionId\s*\(/.test(orchestrator) &&
    !/setSdkSessionId\s*\(/.test(pipeline)
);

// ── resume exists, but only INSIDE one task ──────────────────────────────
// The gate retries, the repair round and the turn-ceiling continuation all
// carry on the same session on purpose: they are one prompt's work. What
// must never happen is a session id outliving the task that minted it.
const resumeSites = pipeline.match(/resume:\s*ctx\.sdkSessionId/g) ?? [];
check(
  "resume reads only the task's own in-memory id",
  resumeSites.length <= 1,
  `${resumeSites.length} site(s)`
);
check(
  "the id is assigned on the task context, never stored",
  /ctx\.sdkSessionId = sid/.test(pipeline)
);

// ── the non-Claude providers are one-shot per prompt ─────────────────────
check(
  "codex runs exec, which keeps no session between prompts",
  /"exec"/.test(codex) && !/\bexec\s+resume\b/.test(codex)
);
for (const [name, rel] of [
  ["ollama", "src/providers/ollama/agent-loop.ts"],
  ["grok", "src/providers/grok/agent-loop.ts"],
] as const) {
  const source = read(rel);
  check(
    `${name} builds its message list from the prompt it was given`,
    !/sdkSessionId|resumeSession|previous_response_id/.test(source)
  );
}

// ── continuity is carried by Atelier context instead ─────────────────────
check(
  "every provider turn receives the same Atelier context block",
  /const providerContext =/.test(pipeline)
);
check(
  "session memory is recalled into that block",
  /recallSession\(ctx, retrieval, intent\.kind\)/.test(pipeline)
);

console.log(
  failed === 0
    ? "\nsession isolation holds: one provider session per prompt"
    : `\n${failed} check(s) failed`
);
process.exit(failed === 0 ? 0 : 1);
