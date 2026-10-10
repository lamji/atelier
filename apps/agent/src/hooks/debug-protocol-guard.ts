import type { EventBus } from "../events/event-bus.js";
import type { HookDecision, HookGuardContext } from "./hooks-engine.js";
import {
  assertsDefinitiveCause,
  isHedged,
  looksLikeBugReport,
  looksLikeDiagnosticQuestion,
  pastedEvidence,
  symptomOf,
} from "./bug-report.js";

export const DEBUG_PROTOCOL_HOOK_ID = "builtin-observe-before-fix";
export const DEBUG_PROTOCOL_HOOK_NAME =
  "Bug fix: observe the failure before editing";
export const DEBUG_PROTOCOL_MATCHER = "write_file|replace_code|replace_many";

const EDIT_TOOLS = new Set(DEBUG_PROTOCOL_MATCHER.split("|"));

/** Tools whose result can BE the observation. */
const OBSERVATION_TOOLS = new Set([
  "run_terminal",
  "preview_review",
  "preview_console",
  "preview_test",
  "read_file",
  "read_many_files",
]);

/** Tasks kept; old ones are dropped oldest-first. */
const MAX_TASKS = 32;

const EXCERPT_CHARS = 240;

export type EvidenceKind = "request" | "preview" | "log" | "test";

/** One runtime observation: what was looked at and whether it failed. */
export interface Evidence {
  kind: EvidenceKind;
  /** Where it came from: "curl …", "preview_console", "the request". */
  source: string;
  failing: boolean;
  excerpt: string;
  at: number;
}

/** An attempt to observe that saw a login page, a 401, a dead bridge… */
export interface BlockedObservation {
  source: string;
  reason: string;
  at: number;
}

/**
 * `fix` — a change turn: edits wait on the observation, "Fixed" waits on the
 * re-observation. `diagnose` — an answer turn asking why something fails: no
 * edits, but a DEFINITIVE root-cause claim still has to be reproduced or
 * hedged. Both refuse a confident conclusion the turn never reproduced.
 */
export type DebugMode = "fix" | "diagnose";

interface TaskState {
  conversationId: string;
  mode: DebugMode;
  symptom: string;
  /** Read-only edit guard is off for direct turns: no impact tool there. */
  requireIsolate: boolean;
  /** First observation that reproduced the failure. */
  failure: Evidence | null;
  /** Most recent observation of any outcome. */
  latest: Evidence | null;
  lastEditAt: number | null;
  edits: number;
  blocked: BlockedObservation[];
  /** Paths whose callers were checked (impact_of_edit) this turn. */
  isolated: Set<string>;
  /** path → net count of temporary log lines this turn added there. */
  instrumentation: Map<string, number>;
}

/** What a task's report may or may not claim, for the completion gate. */
export interface DebugProtocolStatus {
  armed: boolean;
  observed: boolean;
  lines: string[];
}

/**
 * Enforces the debugging protocol at the tool layer, for every provider.
 *
 * The run this exists for spent an afternoon on one alert message: five
 * rounds of read → theorise → edit → typecheck → "Fixed", and not one of
 * them had looked at the failing request. Every fix was a guess, and every
 * guess cost the user a retest. A prompt rule cannot stop that — the same
 * run had the rule in its skill file — so the order is held here:
 *
 *   STUDY/TRACE  read (unchanged: the existing guards cover reads)
 *   OBSERVE      a runtime observation of the failure, in this turn:
 *                the response body, the preview console, a failing test,
 *                a server log line — or the user pasted one. A screenshot
 *                is not one. Until then, edit tools are refused; the only
 *                edit allowed is INSTRUMENTATION (adding log lines), which
 *                is how the observation gets made when nothing else can.
 *   ISOLATE      impact_of_edit on a file before it is changed.
 *   FIX          edits.
 *   RE-OBSERVE   the same kind of observation again, after the last edit,
 *                coming back clean. A typecheck, or a test written to match
 *                the fix, is not that.
 *   VERIFY       instrumentation removed.
 *   REPORT       the completion gate holds "Fixed" until the above is met;
 *                when observation is impossible the honest exit is
 *                `BLOCKED:` naming what the user has to provide.
 */
export class DebugProtocolGuard {
  private tasks = new Map<string, TaskState>();
  /**
   * A monotonic counter used to order edits against observations. Wall-clock
   * can't: an edit and the re-observation that follows it routinely land in
   * the same millisecond, and `Date.now()` then can't tell "observed after
   * the fix" from "observed before it". `at` fields hold ticks, not time.
   */
  private clock = 0;
  /**
   * The last symptom a conversation armed with. A follow-up like "then?"
   * carries no symptom words of its own, but continues the same bug thread,
   * so it must stay inside the protocol — this is how the guard knows there
   * is a thread to continue. Cleared when a turn resolves the bug (a clean
   * re-observation) or the conversation moves to a plain feature request.
   */
  private lastSymptom = new Map<string, string>();

  constructor(private bus: EventBus) {}

  /**
   * Arms a task when its prompt reports a failure (`fix`) or asks to diagnose
   * one (`diagnose`). Returns the symptom it armed with, or null. A follow-up
   * that continues an open bug thread is armed from the conversation's carried
   * symptom. `mode` follows the turn: a change turn fixes, an answer turn
   * diagnoses.
   */
  arm(
    taskId: string,
    conversationId: string,
    prompt: string,
    opts: {
      mode?: DebugMode;
      hasImages?: boolean;
      requireIsolate?: boolean;
      /** Visible preview text: a complaint about copy on it never arms. */
      previewText?: string;
    } = {}
  ): string | null {
    const mode: DebugMode = opts.mode ?? "fix";
    const carriedSymptom = this.lastSymptom.get(conversationId) ?? null;
    const armed =
      mode === "fix"
        ? looksLikeBugReport(prompt, { ...opts, carriedSymptom })
        : looksLikeDiagnosticQuestion(prompt) ||
          (carriedSymptom !== null &&
            looksLikeBugReport(prompt, { ...opts, carriedSymptom }));
    if (!armed) {
      // A plain new request (a feature ask) ends the bug thread.
      if (mode === "fix" && prompt.trim() && !opts.hasImages) {
        this.lastSymptom.delete(conversationId);
      }
      return null;
    }
    const symptom = symptomOf(prompt) || carriedSymptom || "the reported failure";
    this.lastSymptom.set(conversationId, symptom);
    const state: TaskState = {
      conversationId,
      mode,
      symptom,
      requireIsolate: opts.requireIsolate !== false,
      failure: null,
      latest: null,
      lastEditAt: null,
      edits: 0,
      blocked: [],
      isolated: new Set(),
      instrumentation: new Map(),
    };
    // The user pasted the evidence: the observation exists before any tool
    // runs, and the model may go straight to tracing it.
    const pasted = pastedEvidence(prompt);
    if (pasted) {
      state.failure = state.latest = {
        kind: "log",
        source: "pasted in the request",
        failing: true,
        excerpt: pasted,
        at: this.tick(),
      };
    }
    this.tasks.set(taskId, state);
    if (this.tasks.size > MAX_TASKS) {
      const oldest = this.tasks.keys().next().value;
      if (oldest !== undefined) this.tasks.delete(oldest);
    }
    return symptom;
  }

  /** Monotonic ordering stamp; see {@link clock}. */
  private tick(): number {
    return ++this.clock;
  }

  isArmed(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  symptom(taskId: string): string | null {
    return this.tasks.get(taskId)?.symptom ?? null;
  }

  /** A tool returned; if it observed anything, remember what. */
  note(taskId: string, name: string, input: unknown, result: unknown): void {
    const state = this.tasks.get(taskId);
    if (!state) return;
    if (name === "impact_of_edit") {
      const path = pathOf(input);
      if (path) state.isolated.add(normalise(path));
      return;
    }
    if (!OBSERVATION_TOOLS.has(name)) return;
    const seen = classifyEvidence(name, input, result, state.symptom);
    if (!seen) return;
    if ("blocked" in seen) {
      state.blocked.push({ ...seen.blocked, at: this.tick() });
      return;
    }
    // Ordering against edits uses ticks, not the classifier's wall-clock.
    seen.at = this.tick();
    state.latest = seen;
    if (seen.failing && !state.failure) state.failure = seen;
  }

  /** A tool failed; an observation tool failing is a blocked observation. */
  noteFailed(taskId: string, name: string, input: unknown, error: string): void {
    const state = this.tasks.get(taskId);
    if (!state) return;
    if (name === "impact_of_edit") {
      // Isolation was ATTEMPTED; an unindexed file must not wedge the fix.
      const path = pathOf(input);
      if (path) state.isolated.add(normalise(path));
      return;
    }
    if (!OBSERVATION_TOOLS.has(name)) return;
    state.blocked.push({
      source: describeCall(name, input),
      reason: clip(error, EXCERPT_CHARS),
      at: this.tick(),
    });
  }

  noteEdit(taskId: string, _path: string): void {
    const state = this.tasks.get(taskId);
    if (!state) return;
    state.lastEditAt = this.tick();
    state.edits += 1;
  }

  async check(ctx: HookGuardContext): Promise<HookDecision | undefined> {
    if (!EDIT_TOOLS.has(ctx.toolName)) return undefined;
    const state = this.tasks.get(ctx.taskId);
    if (!state) return undefined;

    const instrumentation = instrumentationDelta(ctx.toolName, ctx.input);
    if (instrumentation) {
      for (const [path, delta] of instrumentation) {
        const key = normalise(path);
        state.instrumentation.set(
          key,
          (state.instrumentation.get(key) ?? 0) + delta
        );
      }
      return undefined;
    }

    if (!state.failure) {
      return this.block(ctx, observeFirstReason(state));
    }

    if (state.requireIsolate) {
      const path = pathOf(ctx.input);
      const paths =
        path !== null ? [path] : pathsOf(ctx.input);
      const unchecked = paths.filter(
        (item) => needsIsolation(item) && !state.isolated.has(normalise(item))
      );
      if (unchecked.length > 0) {
        return this.block(
          ctx,
          `ISOLATE before FIX: run impact_of_edit on ${unchecked.join(", ")} ` +
            "so the change is made knowing every caller it reaches. Then " +
            "retry this edit. (Debugging protocol: STUDY → TRACE → OBSERVE → " +
            "ISOLATE → FIX → RE-OBSERVE → VERIFY → REPORT.)"
        );
      }
    }
    return undefined;
  }

  /**
   * What the completion gate must still see before the turn's report may end
   * it. `report` is the model's current answer text; when given, a definitive
   * root-cause or "fixed" claim the turn never reproduced is refused — this is
   * the jumping-to-conclusions block, and it applies to fix and diagnose turns
   * alike.
   */
  status(taskId: string, report?: string): DebugProtocolStatus {
    const state = this.tasks.get(taskId);
    if (!state) return { armed: false, observed: false, lines: [] };

    // Diagnose turns make no edits. The only thing they can owe is a
    // reproduction behind a confident conclusion.
    if (state.mode === "diagnose") {
      const conclusion = report ? this.conclusionLine(state, report) : null;
      return {
        armed: true,
        observed: state.failure !== null,
        lines: conclusion ? [conclusion] : [],
      };
    }

    const lines: string[] = [];
    if (!state.failure) {
      lines.push(
        (state.edits > 0
          ? "The failure was never observed in this turn, so nothing here is a fix. "
          : "The failure was never observed in this turn, so no fix has been made. ") +
          `Symptom: "${state.symptom}". ` +
          observationRoutes(state) +
          " If every route is blocked, end with a line starting `BLOCKED:` that " +
          "names exactly what you need from the user (a signed-in Page preview, " +
          "a token for the request, the server log). Do not claim it is fixed, " +
          "and do not edit on a guess."
      );
      return { armed: true, observed: false, lines };
    }
    if (state.edits > 0) {
      const after =
        state.latest && state.lastEditAt !== null && state.latest.at > state.lastEditAt
          ? state.latest
          : null;
      if (!after) {
        lines.push(
          "RE-OBSERVE after the fix: repeat the observation that reproduced the " +
            `failure (${state.failure.source}) now that the edit is in, and read ` +
            "the result. A typecheck, a build, or a test written to match the fix " +
            "is not that observation. Until it comes back clean the report may " +
            "not say the bug is fixed."
        );
      } else if (after.failing) {
        lines.push(
          "The failure still reproduces after your edit — " +
            `${after.source}: ${after.excerpt}. Do not report it fixed; ` +
            "go back to TRACE with this evidence."
        );
      }
    }
    const leftover = [...state.instrumentation.entries()]
      .filter(([, count]) => count > 0)
      .map(([path]) => path);
    if (leftover.length > 0) {
      lines.push(
        "Remove the temporary log lines you added for diagnosis in " +
          `${leftover.join(", ")} before reporting.`
      );
    }
    const conclusion = report ? this.conclusionLine(state, report) : null;
    if (conclusion) lines.push(conclusion);
    return { armed: true, observed: true, lines };
  }

  /**
   * The jumping-to-conclusions block. A report that states a definitive cause
   * or a completed fix, on a turn that never reproduced the failure and does
   * not hedge, is refused: reproduce it, or mark it a hypothesis. A turn that
   * DID reproduce (state.failure set — including pasted evidence) has earned
   * the conclusion and passes.
   */
  private conclusionLine(state: TaskState, report: string): string | null {
    if (state.failure !== null) return null;
    if (!assertsDefinitiveCause(report)) return null;
    if (isHedged(report)) return null;
    return (
      `This report states a definitive cause or fix for "${state.symptom}", but ` +
      "the failure was never reproduced in this turn — that is a guess presented " +
      "as fact. Either reproduce it now (" +
      observationRoutes(state).replace(/^Observe it first, in this turn: /, "") +
      ") and let the evidence stand behind the claim, or rewrite the conclusion " +
      "as an explicit unverified hypothesis (\"likely\", \"my hypothesis is\", " +
      "\"not yet reproduced\"). If reproduction is impossible, end with a line " +
      "starting `BLOCKED:` naming what you need from the user."
    );
  }

  release(taskId: string): void {
    const state = this.tasks.get(taskId);
    if (state) {
      // The bug thread is closed once a fix has been re-observed coming back
      // clean, so the next unrelated turn is not held to a symptom already
      // gone. Anything short of that leaves the thread open for a follow-up.
      const resolved =
        state.failure !== null &&
        state.edits > 0 &&
        state.latest !== null &&
        !state.latest.failing &&
        state.lastEditAt !== null &&
        state.latest.at > state.lastEditAt;
      if (resolved) this.lastSymptom.delete(state.conversationId);
    }
    this.tasks.delete(taskId);
  }

  private block(ctx: HookGuardContext, reason: string): HookDecision {
    this.bus.publish(
      "hook.blocked",
      { hookId: DEBUG_PROTOCOL_HOOK_ID, name: DEBUG_PROTOCOL_HOOK_NAME, reason },
      ctx.taskId
    );
    return { allowed: false, reason };
  }
}

function observeFirstReason(state: TaskState): string {
  const blocked =
    state.blocked.length > 0
      ? " Attempts that could not observe it: " +
        state.blocked
          .slice(-3)
          .map((item) => `${item.source} → ${item.reason}`)
          .join("; ") +
        "."
      : "";
  return (
    "OBSERVE before FIX. This turn reports a failure " +
    `("${state.symptom}") and nothing in it has observed that failure ` +
    "happening — so any edit now is a guess. " +
    observationRoutes(state) +
    blocked +
    " Adding console.log/logger lines to see the values is allowed before " +
    "this (and is the way in when nothing else shows the failure); every " +
    "other edit waits. If every route is blocked, stop and end with " +
    "`BLOCKED:` naming what you need from the user."
  );
}

function observationRoutes(_state: TaskState): string {
  return (
    "Observe it first, in this turn: (1) preview_console — the in-app Page " +
    "preview's own console, signed in as the user; (2) preview_review on the " +
    "route; (3) preview_test — drive the live preview through the exact " +
    "clicks and inputs that fail, and read the assertions; (4) run_terminal " +
    "with curl/Invoke-RestMethod against the exact request the UI sends, " +
    "and read the status and body; (5) run the test that fails; (6) read " +
    "the server's log."
  );
}

/**
 * Files whose callers are the whole app and none of them care: message
 * catalogues. impact_of_edit on `en.json` returns nothing useful, and the
 * one turn that was held on it for a label change spent its retry there.
 */
const NO_ISOLATION_PATH = new RegExp(
  [
    "/i18n/",
    "/locales?/",
    "translations?\\.(ts|js|json)$",
    "/messages/.*\\.json$",
  ].join("|"),
  "i"
);

/** Whether ISOLATE (impact_of_edit) is owed before this file is changed. */
export function needsIsolation(path: string): boolean {
  return !NO_ISOLATION_PATH.test("/" + normalise(path));
}

// ------------------------------------------------------------- evidence

type Classified = Evidence | { blocked: Omit<BlockedObservation, "at"> };

const REQUEST_COMMAND =
  /\b(curl|Invoke-RestMethod|Invoke-WebRequest|iwr|irm|wget|httpie|http|xh)\b/i;
const TEST_COMMAND =
  /\b(vitest|jest|mocha|ava|pytest|go test|cargo test|dotnet test|phpunit|rspec|(npm|pnpm|yarn|bun) (run )?test)\b/i;
const LOG_COMMAND =
  /\b(tail|cat|Get-Content|gc|type|docker (compose )?logs|journalctl|kubectl logs|pm2 logs)\b/i;
const LOG_PATH = /\.log$|[\\/]logs?[\\/]/i;

/** Output that shows a program failing, however it was produced. */
const FAILURE_MARKERS = new RegExp(
  [
    "\\b(Unhandled|Uncaught)\\b",
    "\\bTraceback\\b",
    "\\b(TypeError|ReferenceError|SyntaxError|RangeError)\\b",
    "\\bInternal Server Error\\b",
    "\\bECONN(REFUSED|RESET)\\b|\\bENOTFOUND\\b|\\bEADDRINUSE\\b",
    "\\[(ERROR|FATAL)\\]",
    "^\\s*at .+:\\d+:\\d+\\)?\\s*$",
    "\"(error|errors)\"\\s*:",
    "\\bError:",
    "\\b\\d+ (failed|failing)\\b",
    "(^|\\s)FAIL(ED)?\\b",
  ].join("|"),
  "im"
);

const AUTH_STATUS = /\b(401|403)\b/;
const AUTH_SYMPTOM = /\b(401|403|auth|unauthori[sz]ed|forbidden|log ?in|token)\b/i;

/** The HTTP status a response shows, from any of the usual renderings. */
export function statusIn(output: string): number | null {
  const patterns = [
    /HTTP\/[\d.]+\s+(\d{3})\b/,
    /\bStatusCode\s*:\s*(\d{3})\b/,
    /"status(?:Code)?"\s*:\s*(\d{3})\b/,
    /\b(\d{3})\s+(?:Bad Request|Unauthorized|Payment Required|Forbidden|Not Found|Conflict|Unprocessable|Too Many|Internal Server Error|Bad Gateway|Service Unavailable)\b/i,
    /\bHTTP\s+(\d{3})\b/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(output);
    if (match) return Number(match[1]);
  }
  return null;
}

export function classifyEvidence(
  name: string,
  input: unknown,
  result: unknown,
  symptom: string
): Classified | null {
  switch (name) {
    case "run_terminal":
      return classifyTerminal(input, result, symptom);
    case "preview_review":
      return classifyPreview("preview_review", result);
    case "preview_console":
      return classifyPreview("preview_console", result);
    case "preview_test":
      return classifyPreviewTest(result);
    case "read_file":
    case "read_many_files":
      return classifyLogRead(input, result);
    default:
      return null;
  }
}

function classifyTerminal(
  input: unknown,
  result: unknown,
  symptom: string
): Classified | null {
  const command = String((input as { command?: unknown })?.command ?? "");
  const run = result as
    | { output?: unknown; exitCode?: unknown; timedOut?: unknown }
    | null
    | undefined;
  const output = typeof run?.output === "string" ? run.output : String(run ?? "");
  const exitCode = typeof run?.exitCode === "number" ? run.exitCode : null;
  const source = describeCall("run_terminal", input);
  const excerpt = failureExcerpt(output);

  if (REQUEST_COMMAND.test(command)) {
    const status = statusIn(output);
    if (status !== null && AUTH_STATUS.test(String(status)) && !AUTH_SYMPTOM.test(symptom)) {
      return {
        blocked: {
          source,
          reason: `the request came back ${status} — no credentials, so this saw the login wall, not the symptom`,
        },
      };
    }
    if (run?.timedOut === true || /Could not resolve host|Connection refused|ECONNREFUSED/i.test(output)) {
      return { blocked: { source, reason: clip(output, EXCERPT_CHARS) || "no response" } };
    }
    const failing =
      (status !== null && status >= 400) || FAILURE_MARKERS.test(output);
    return { kind: "request", source, failing, excerpt, at: Date.now() };
  }
  if (TEST_COMMAND.test(command)) {
    const failing =
      (exitCode !== null && exitCode !== 0) || /\b\d+ failed\b|(^|\s)FAIL\b/m.test(output);
    return { kind: "test", source, failing, excerpt, at: Date.now() };
  }
  if (LOG_COMMAND.test(command) && /\.log\b|\blogs?\b/i.test(command)) {
    return {
      kind: "log",
      source,
      failing: FAILURE_MARKERS.test(output),
      excerpt,
      at: Date.now(),
    };
  }
  // Anything else only counts when it visibly failed: running the server
  // or a script and watching it throw is an observation; a clean typecheck
  // is not.
  if (FAILURE_MARKERS.test(output) && statusIn(output) !== 200) {
    return { kind: "log", source, failing: true, excerpt, at: Date.now() };
  }
  return null;
}

function classifyPreview(
  tool: "preview_review" | "preview_console",
  result: unknown
): Classified | null {
  const review = result as
    | {
        status?: unknown;
        routeReached?: unknown;
        message?: unknown;
        requestedUrl?: unknown;
        url?: unknown;
        debug?: { consoleErrors?: unknown; pageErrors?: unknown; failedRequests?: unknown };
        consoleErrors?: unknown;
      }
    | null
    | undefined;
  if (!review || typeof review !== "object") return null;
  const status = String(review.status ?? "");
  const url = String(review.requestedUrl ?? review.url ?? "");
  const source = url ? `${tool} ${url}` : tool;
  if (status === "issues") {
    const errors = [
      ...stringList(review.debug?.consoleErrors),
      ...stringList(review.debug?.pageErrors),
      ...stringList(review.debug?.failedRequests),
      ...stringList(review.consoleErrors),
    ];
    return {
      kind: "preview",
      source,
      failing: true,
      excerpt: clip(errors.join(" | ") || String(review.message ?? ""), EXCERPT_CHARS),
      at: Date.now(),
    };
  }
  if ((status === "ready" || status === "clean") && review.routeReached !== false) {
    return {
      kind: "preview",
      source,
      failing: false,
      excerpt: "console clean",
      at: Date.now(),
    };
  }
  return {
    blocked: {
      source,
      reason: clip(String(review.message ?? (status || "unavailable")), EXCERPT_CHARS),
    },
  };
}

function classifyPreviewTest(result: unknown): Classified | null {
  const report = result as
    | { status?: unknown; url?: unknown; failed?: unknown; reason?: unknown }
    | null
    | undefined;
  if (!report || typeof report !== "object") return null;
  const status = String(report.status ?? "");
  const source = `preview_test${report.url ? " " + String(report.url) : ""}`;
  if (status === "failed") {
    const failed = Array.isArray(report.failed) ? report.failed.join("; ") : "";
    return {
      kind: "test",
      source,
      failing: true,
      excerpt: clip(failed || String(report.reason ?? "assertion failed"), EXCERPT_CHARS),
      at: Date.now(),
    };
  }
  if (status === "passed") {
    return { kind: "test", source, failing: false, excerpt: "assertions held", at: Date.now() };
  }
  return {
    blocked: { source, reason: clip(String(report.reason ?? (status || "unavailable")), EXCERPT_CHARS) },
  };
}

function classifyLogRead(input: unknown, result: unknown): Classified | null {
  const paths = pathsOf(input).filter((path) => LOG_PATH.test(path));
  if (paths.length === 0) return null;
  const text =
    typeof result === "string" ? result : JSON.stringify(result ?? "");
  return {
    kind: "log",
    source: `read ${paths.join(", ")}`,
    failing: FAILURE_MARKERS.test(text),
    excerpt: failureExcerpt(text),
    at: Date.now(),
  };
}

function failureExcerpt(output: string): string {
  const line = output
    .split(/\r?\n/)
    .find((item) => FAILURE_MARKERS.test(item) || statusIn(item) !== null);
  return clip((line ?? output).trim(), EXCERPT_CHARS);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) =>
    typeof item === "string" ? item : JSON.stringify(item)
  );
}

// ------------------------------------------------------ instrumentation

/**
 * A line that only prints. Adding these is how a failure gets observed
 * when no request, test or log shows it, so it is the one edit the guard
 * lets through before the observation — and the one it insists is removed
 * before the report.
 */
const LOG_LINE =
  /^\s*(\/\/.*)?$|^\s*(console\.(log|error|warn|info|debug|trace|table|dir)\(|(logger?|log)\.(log|error|warn|info|debug|trace|verbose)\(|print\(|pprint\(|debugPrint\(|eprintln!\(|println!\(|dbg!\(|System\.out\.println\(|fmt\.Print(ln|f)?\(|log\.Print(ln|f)?\(|error_log\(|var_dump\(|Rails\.logger\.|puts )/;

/** Continuation of a multi-line log call: arguments, closing paren. */
const LOG_CONTINUATION = /^[\s)\]};,]*$|^\s*[`'"].*[`'"],?\)?;?\s*$|^\s*[\w.$[\]'"`]+,?\)?;?\s*$/;

/**
 * Whether an edit ONLY adds (or only removes) log lines, and where.
 * Returns path → net lines added, or null when the edit changes anything
 * else. write_file never qualifies: a whole-file write cannot be read as
 * "just logging".
 */
export function instrumentationDelta(
  toolName: string,
  input: unknown
): Map<string, number> | null {
  if (toolName === "replace_code") {
    const edit = input as { path?: unknown; oldString?: unknown; newString?: unknown };
    const delta = logDelta(edit.oldString, edit.newString);
    if (delta === null || typeof edit.path !== "string") return null;
    return new Map([[edit.path, delta]]);
  }
  if (toolName === "replace_many") {
    const edits = (input as { edits?: unknown })?.edits;
    if (!Array.isArray(edits) || edits.length === 0) return null;
    const out = new Map<string, number>();
    for (const edit of edits as Array<{ path?: unknown; oldString?: unknown; newString?: unknown }>) {
      const delta = logDelta(edit.oldString, edit.newString);
      if (delta === null || typeof edit.path !== "string") return null;
      out.set(edit.path, (out.get(edit.path) ?? 0) + delta);
    }
    return out;
  }
  return null;
}

function logDelta(oldString: unknown, newString: unknown): number | null {
  if (typeof oldString !== "string" || typeof newString !== "string") return null;
  const before = countLines(oldString);
  const after = countLines(newString);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [line, count] of after) {
    const gone = before.get(line) ?? 0;
    for (let i = gone; i < count; i += 1) added.push(line);
  }
  for (const [line, count] of before) {
    const kept = after.get(line) ?? 0;
    for (let i = kept; i < count; i += 1) removed.push(line);
  }
  if (added.length === 0 && removed.length === 0) return null;
  const onlyLogs = (lines: string[]): boolean =>
    lines.some((line) => LOG_LINE.test(line) && line.trim() !== "" && !line.trim().startsWith("//")) &&
    lines.every((line) => LOG_LINE.test(line) || LOG_CONTINUATION.test(line));
  if (removed.length === 0 && onlyLogs(added)) {
    return added.filter((line) => line.trim() !== "").length;
  }
  if (added.length === 0 && onlyLogs(removed)) {
    return -removed.filter((line) => line.trim() !== "").length;
  }
  return null;
}

function countLines(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

// ------------------------------------------------------------- helpers

function pathOf(input: unknown): string | null {
  const path = (input as { path?: unknown } | null)?.path;
  return typeof path === "string" && path ? path : null;
}

function pathsOf(input: unknown): string[] {
  const single = pathOf(input);
  if (single) return [single];
  const bag = input as { edits?: unknown; files?: unknown } | null;
  const list = Array.isArray(bag?.edits)
    ? bag.edits
    : Array.isArray(bag?.files)
      ? bag.files
      : [];
  return list
    .map((item) => (typeof item === "string" ? item : pathOf(item)))
    .filter((item): item is string => typeof item === "string" && item !== "");
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function describeCall(name: string, input: unknown): string {
  if (name === "run_terminal") {
    const command = String((input as { command?: unknown })?.command ?? "");
    return clip(command.replace(/\s+/g, " ").trim(), 120) || "run_terminal";
  }
  const url = (input as { url?: unknown } | null)?.url;
  if (typeof url === "string") return `${name} ${url}`;
  const paths = pathsOf(input);
  return paths.length > 0 ? `${name} ${paths.join(", ")}` : name;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
