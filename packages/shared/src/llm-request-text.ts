/**
 * Text renderings of an `llm.request` event, shared by the agent (which
 * pins the line into chat history) and the web app (which shows it live)
 * so a reloaded transcript reads exactly as the live one did.
 *
 * Typed structurally rather than against @atelier/protocol: shared is a
 * leaf package and must not import the schemas.
 */

export interface LlmRequestSectionLike {
  name: string;
  text: string;
  tokens: number;
  truncated?: boolean;
}

export interface LlmRequestLike {
  purpose: string;
  provider: string;
  model: string;
  round?: number;
  sections?: LlmRequestSectionLike[];
  prompt?: string;
  promptTruncated?: boolean;
  systemTokens?: number;
  promptTokens?: number;
  totalTokens?: number;
  transcript?: Array<{ role: string; chars: number; label?: string }>;
  toolsOffered?: number;
  contextWindow?: number;
  overflow?: boolean;
  elided?: number;
  resumes?: boolean;
}

/** "12.3k" for anything past a thousand, the bare number below it. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(tokens)));
}

/** One line for the timeline row: where it went and how big it was. */
export function llmRequestSummary(request: LlmRequestLike): string {
  const round = request.round ?? 0;
  const where = `${request.provider} · ${request.model} · ${request.purpose}`;
  const total = formatTokenCount(request.totalTokens ?? 0);
  const head =
    round === 0
      ? `Sent to model (${where}): ~${total} tok`
      : `Tool round ${round} sent to model (${where}): ~${total} tok`;
  const parts: string[] = [];
  if (round === 0) {
    for (const section of request.sections ?? []) {
      if (section.tokens <= 0) continue;
      parts.push(`${section.name} ${formatTokenCount(section.tokens)}`);
    }
    parts.push(`prompt ${formatTokenCount(request.promptTokens ?? 0)}`);
    const carried = (request.transcript ?? []).length;
    if (carried > 0) parts.push(`${carried} message(s) carried as transcript`);
  } else {
    const entries = request.transcript ?? [];
    parts.push(`${entries.length} message(s) in transcript`);
  }
  if ((request.toolsOffered ?? 0) > 0) {
    parts.push(`${request.toolsOffered} tool(s)`);
  }
  if (request.contextWindow) {
    parts.push(`window ${formatTokenCount(request.contextWindow)}`);
  }
  if ((request.elided ?? 0) > 0) {
    parts.push(`${request.elided} old tool result(s) elided to fit`);
  }
  const tail = parts.length > 0 ? ` — ${parts.join(" · ")}` : "";
  const warning = request.overflow
    ? " ⚠ exceeds the context window: the backend will drop input"
    : "";
  return `${head}${tail}${warning}`;
}

/** The full body: every section verbatim, then the prompt. */
export function llmRequestDetail(request: LlmRequestLike): string {
  const out: string[] = [];
  const window = request.contextWindow
    ? ` of a ${formatTokenCount(request.contextWindow)} window`
    : "";
  out.push(
    `${request.provider} · ${request.model} · ${request.purpose} · ` +
      `round ${request.round ?? 0} · ~${formatTokenCount(request.totalTokens ?? 0)} tok${window}` +
      (request.resumes ? " · resumes earlier session" : "")
  );
  if ((request.elided ?? 0) > 0) {
    out.push(
      `${request.elided} older tool result(s) were elided (body replaced ` +
        "by a one-line stub) so the request fits the window; the model can " +
        "call the tool again for any of them."
    );
  }
  if (request.overflow) {
    out.push(
      "WARNING: the estimated request is larger than the context window. " +
        "The backend truncates silently, so the model may not have seen the " +
        "start of this context (usually the rules and the retrieved code)."
    );
  }
  for (const section of request.sections ?? []) {
    out.push("");
    out.push(
      `═══ ${section.name} (~${formatTokenCount(section.tokens)} tok)` +
        `${section.truncated ? " — stored copy truncated" : ""} ═══`
    );
    out.push(section.text);
  }
  if (request.prompt) {
    out.push("");
    out.push(
      `═══ user prompt (~${formatTokenCount(request.promptTokens ?? 0)} tok)` +
        `${request.promptTruncated ? " — stored copy truncated" : ""} ═══`
    );
    out.push(request.prompt);
  }
  const transcript = request.transcript ?? [];
  if (transcript.length > 0) {
    out.push("");
    out.push("═══ transcript replayed with this round ═══");
    for (const entry of transcript) {
      const label = entry.label ? ` ${entry.label}` : "";
      out.push(`- ${entry.role}${label}: ${entry.chars} chars`);
    }
  }
  return out.join("\n");
}
