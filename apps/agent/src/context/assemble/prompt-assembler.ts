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

    const featureRefs = input.retrieval.features
      .filter((feature) => feature.files.length > 0)
      .slice(0, 3)
      .map(
        (feature) =>
          `- ${feature.name} (${feature.slug}): ` +
          feature.files.slice(0, 8).join(", ")
      );
    if (featureRefs.length > 0) {
      const text = featureRefs.join("\n");
      // A LEAD, not an instruction. This used to read "stay on these owner
      // files", which turned a fuzzy index match into direction the model
      // followed over the path the user had just named.
      parts.push(
        "FEATURE FILES THAT MAY BE RELEVANT (matched from the feature index " +
          "— treat as leads: confirm the live owner of what the user " +
          "described before editing, and paths named in this turn win):",
        text
      );
      sections.push({
        name: "features",
        tokens: approxTokens(text),
        items: featureRefs.length,
      });
    }

    // 0. Cross-turn dedup: content this conversation already received at
    // full detail is referenced, never re-sent. Keyed by content hash, so
    // edited code automatically counts as fresh again.
    const sentHashes =
      this.deps.sent?.sentHashes(input.conversationId) ?? new Set<string>();
    const fresh = input.retrieval.chunks.filter(
      (c) =>
        c.kind === "session-memory" ||
        !c.contentHash ||
        !sentHashes.has(c.contentHash)
    );
    const already = input.retrieval.chunks.filter(
      (c) =>
        c.kind !== "session-memory" &&
        c.contentHash !== undefined &&
        sentHashes.has(c.contentHash)
    );

    // 1. Ranked retrieved context through the ladder.
    const packed = packItems(fresh, budget, this.deps.db);
    this.deps.sent?.markSent(input.conversationId, packed.detailed);
    if (packed.items > 0) {
      parts.push("Most relevant retrieved context:", packed.text);
      sections.push({ name: "code", tokens: packed.tokens, items: packed.items });
    }

    // 2. The tail as bare path references; already-sent content rides as
    // one-line reminders instead of repeated code blocks.
    const refs = [
      ...packed.overflow
        .filter(
          (c) =>
            c.kind === "code" ||
            c.kind === "doc" ||
            c.kind === "session-memory" ||
            c.kind === "global-session-memory"
        )
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

    // 5. The plan checklist — the execution contract, so titles are never
    // sacrificed: every title+files line is emitted first, then each step's
    // detail (the part saying what actually changes) is folded in while it
    // fits. Details used to be dropped outright, which handed the
    // implementer a list of headlines and no instructions.
    if (budget.planTokens > 0 && input.plan.steps.length > 0) {
      const steps = input.plan.steps.map(
        (step, i) =>
          `${i + 1}. [${step.id}] ${step.title}` +
          (step.files.length > 0 ? ` (${step.files.join(", ")})` : "")
      );
      let used = approxTokens(steps.join("\n"));
      input.plan.steps.forEach((step, i) => {
        if (!step.detail) return;
        const note = `   ${step.detail.slice(0, 240)}`;
        const cost = approxTokens(note);
        if (used + cost > budget.planTokens) return;
        steps[i] += `\n${note}`;
        used += cost;
      });
      const text = clipToTokens(steps.join("\n"), budget.planTokens);
      parts.push("PLAN (report progress via update_plan_step):", text);
      sections.push({
        name: "plan",
        tokens: approxTokens(text),
        items: input.plan.steps.length,
      });
    }

    // Conversation memory is NOT assembled here. It has exactly one owner —
    // SharedSessionContextBuilder — which combines the compressed summaries
    // retrieval did not already surface with the recent verbatim turns. This
    // used to emit its own copy of the same summaries, which meant paying
    // twice whenever both fired and losing both whenever the mutual
    // suppression misfired.

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
