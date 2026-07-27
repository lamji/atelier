import { approxTokens, clipToTokens, newId } from "@atelier/shared";
import type {
  ContextRequestStats,
  ContextSectionStat,
  ImpactRadius,
  Plan,
  RetrievalResult,
} from "@atelier/protocol";
import type { Db } from "../../storage/db.js";
import { buildImpactContext } from "../../orchestrator/impact-context.js";
import type { TokenLedger } from "../ledger/index.js";
import type { SentChunkStore } from "../dedup/index.js";
import type { TaskSummaryStore } from "../summaries/index.js";
import { budgetFor } from "../budget/index.js";
import { packItems } from "./pack-items.js";

export interface AssembleInput {
  taskId: string;
  conversationId: string;
  intentKind: string;
  retrieval: RetrievalResult;
  radius: ImpactRadius;
  plan: Plan;
  /** Explicit user scope limits ("only", "revert", ...) to honor exactly. */
  constraints?: string[];
}

export interface AssembledContext {
  text: string;
  stats: ContextRequestStats;
}

const HEADER =
  "\nTASK CONTEXT (from the knowledge engine — pull anything else with " +
  "retrieve_knowledge; don't re-read what's already inlined here):";

/**
 * Token-budgeted replacement for the old char-sliced context builder.
 * Sections ride in a stable order (cache-friendly), each packed inside
 * its per-intent budget through the compression ladder, and every
 * assembly is recorded in the token ledger with its estimated savings
 * against naive all-previews assembly.
 */
export class PromptAssembler {
  constructor(
    private deps: {
      db: Db;
      ledger: TokenLedger;
      sent?: SentChunkStore;
      summaries?: TaskSummaryStore;
    }
  ) {}

  assemble(input: AssembleInput): AssembledContext {
    const budget = budgetFor(input.intentKind);
    const sections: ContextSectionStat[] = [];
    const parts: string[] = [HEADER];

    // Explicit scope limits ride first and unbudgeted: they are tiny and
    // must survive clipping so VIBE's "unless explicitly limited" fires.
    const limits = input.constraints ?? [];
    if (limits.length > 0) {
      const text = limits.map((c) => `- ${c}`).join("\n");
      parts.push(
        "EXPLICIT SCOPE LIMITS from the user (honor exactly; do NOT expand " +
          "beyond these):",
        text
      );
      sections.push({ name: "scope-limits", tokens: approxTokens(text), items: limits.length });
    }

    // 0. Cross-turn dedup: content this conversation already received at
    // full detail is referenced, never re-sent. Keyed by content hash, so
    // edited code automatically counts as fresh again.
    const sentHashes =
      this.deps.sent?.sentHashes(input.conversationId) ?? new Set<string>();
    const fresh = input.retrieval.chunks.filter(
      (c) => !c.contentHash || !sentHashes.has(c.contentHash)
    );
    const already = input.retrieval.chunks.filter(
      (c) => c.contentHash !== undefined && sentHashes.has(c.contentHash)
    );

    // 1. Ranked code through the ladder.
    const packed = packItems(fresh, budget, this.deps.db);
    this.deps.sent?.markSent(input.conversationId, packed.detailed);
    if (packed.items > 0) {
      parts.push("Most relevant code:", packed.text);
      sections.push({ name: "code", tokens: packed.tokens, items: packed.items });
    }

    // 2. The tail as bare path references; already-sent content rides as
    // one-line reminders instead of repeated code blocks.
    const refs = [
      ...packed.overflow
        .filter((c) => c.kind === "code" || c.kind === "doc")
        .map((c) => `- [${c.kind}] ${c.path}`),
      ...already.map((c) => `- [${c.kind}] ${c.path} (already in context)`),
    ];
    if (refs.length > 0 && budget.refTokens > 0) {
      const text = clipToTokens(refs.join("\n"), budget.refTokens);
      parts.push("More relevant files (paths only — retrieve on demand):", text);
      sections.push({
        name: "refs",
        tokens: approxTokens(text),
        items: refs.length,
      });
    }

    // 3. Blast radius (callers, flows, tests, lessons).
    if (budget.impactTokens > 0) {
      const impact = buildImpactContext(input.radius);
      if (impact) {
        const text = clipToTokens(impact, budget.impactTokens);
        parts.push(text);
        sections.push({ name: "impact", tokens: approxTokens(text), items: 1 });
      }
    }

    // 4. Companion files (template/class/spec twins).
    if (budget.companionTokens > 0 && input.radius.companions.length > 0) {
      const text = clipToTokens(
        input.radius.companions.slice(0, 8).map((f) => `- ${f}`).join("\n"),
        budget.companionTokens
      );
      parts.push(
        "COMPANION FILES (same component/module — read before changing " +
          "either half):",
        text
      );
      sections.push({
        name: "companions",
        tokens: approxTokens(text),
        items: input.radius.companions.length,
      });
    }

    // 5. The plan checklist.
    if (budget.planTokens > 0 && input.plan.steps.length > 0) {
      const steps = input.plan.steps.map(
        (step, i) =>
          `${i + 1}. [${step.id}] ${step.title}` +
          (step.files.length > 0 ? ` (${step.files.join(", ")})` : "")
      );
      const text = clipToTokens(steps.join("\n"), budget.planTokens);
      parts.push("PLAN (report progress via update_plan_step):", text);
      sections.push({
        name: "plan",
        tokens: approxTokens(text),
        items: input.plan.steps.length,
      });
    }

    // 6. Recent work in this session — compressed task summaries instead
    // of replayed conversation turns.
    if (budget.summaryTokens > 0 && this.deps.summaries) {
      const recent = this.deps.summaries
        .recent(input.conversationId, 3)
        .filter((s) => s.taskId !== input.taskId);
      if (recent.length > 0) {
        const text = clipToTokens(
          recent.map((s) => `- ${s.text}`).join("\n"),
          budget.summaryTokens
        );
        parts.push("RECENT WORK IN THIS SESSION:", text);
        sections.push({
          name: "recent-work",
          tokens: approxTokens(text),
          items: recent.length,
        });
      }
    }

    let text = parts.join("\n");
    if (approxTokens(text) > budget.totalTokens) {
      text = clipToTokens(text, budget.totalTokens);
    }

    const appendTokens = approxTokens(text);
    const estBaselineTokens = this.naiveBaseline(input);
    const savedTokens = Math.max(0, estBaselineTokens - appendTokens);
    const stats: ContextRequestStats = {
      requestId: newId("ctxreq"),
      taskId: input.taskId,
      conversationId: input.conversationId,
      purpose: "execute",
      sections,
      appendTokens,
      estBaselineTokens,
      savedTokens,
      savedPct:
        estBaselineTokens > 0
          ? Math.round((savedTokens / estBaselineTokens) * 100)
          : 0,
      cacheHit: false,
      dedupedChunks: already.length,
      at: Date.now(),
    };
    this.deps.ledger.record(stats);
    return { text, stats };
  }

  /** What sending every retrieved preview plus raw sections would cost. */
  private naiveBaseline(input: AssembleInput): number {
    const previews = input.retrieval.chunks
      .map((c) => c.preview)
      .join("\n");
    const impact = buildImpactContext(input.radius) ?? "";
    const plan = input.plan.steps.map((s) => s.title).join("\n");
    return approxTokens(previews) + approxTokens(impact) + approxTokens(plan);
  }
}
