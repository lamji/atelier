import { stripHiddenContext } from "@atelier/shared";

/**
 * Whether a turn reports something that is BROKEN, as opposed to asking for
 * something new. Only the human half of the prompt is read: the hidden
 * preview context that rides on a send is a DOM dump, and its "Runtime
 * errors are present" line would arm every turn taken with a preview open.
 *
 * Deliberately a symptom test, not an "is this a fix" test: a feature
 * request that happens to mention error handling is not a bug report, and a
 * one-word "then?" after a failed fix is — the symptom carried over from the
 * earlier turn, which is why callers pass `carriedSymptom`.
 */
const SYMPTOM = new RegExp(
  [
    "\\bbug\\b",
    "\\bbroken\\b",
    "\\bcrash(es|ed|ing)?\\b",
    "\\bfail(s|ed|ing|ure)?\\b",
    "\\berror(s)?\\b",
    "\\bexception\\b",
    "\\bnot (working|saving|saved|showing|shown|reflect(ing|ed)?|loading|updating|refreshing|displayed)\\b",
    "\\bdoes ?n[o']t (work|save|show|load|update|refresh|appear)\\b",
    "\\bcan ?n?[o']?t (create|delete|save|load|open|see|add|update|log ?in|submit|click)\\b",
    "\\bstill (getting|showing|shows|see|seeing|fails|failing|broken|wrong|the same|happening)\\b",
    "\\bwent wrong\\b",
    "\\bwrong (message|value|result|data|page|count|total|status)\\b",
    "\\bunexpected\\b",
    "\\bstack ?trace\\b",
    "\\b(4\\d\\d|5\\d\\d)\\b",
    "\\binternal server error\\b",
    "\\bis not a function\\b",
    "\\bundefined is not\\b",
    "\\bcannot read propert",
    // "to avoid regression bugs" is a goal, not a symptom; only a
    // regression that HAPPENED reads as one.
    "(?<!\\bavoid\\w* |\\bprevent\\w* |\\bwithout |\\bno |\\bzero )\\bregressions?\\b",
    "\\bthe (actual )?issue\\b",
    "\\bissue is\\b",
    "\\b(only|instead of|instead)\\b.*\\b(generic|blank|empty|stale)\\b",
  ].join("|"),
  "i"
);

/** A request for something new, even when it mentions errors in passing. */
const FEATURE_ASK = new RegExp(
  [
    "^\\s*(add|implement|create|build|write|scaffold|generate|design|document|refactor|rename|introduce|extract)\\b",
    "^\\s*(here(?:'s| is)?|this is|that'?s) what (i|we) (need|want)\\b",
    "^\\s*(i|we) (need|want|would like)\\b",
    "^\\s*requirements?\\b",
  ].join("|"),
  "i"
);

/**
 * A line that belongs to a written SPEC: a bullet, a numbered item, a
 * nested "--" item, or an arrow chain ("prompt -> rag -> llm"). Three of
 * them in one request make it a design, not a bug report — whatever
 * vocabulary the design happens to use.
 */
const SPEC_LINE = /^\s*(?:[-*•]+|\d+[.)]|>+)\s+\S|(?:->|→|=>)/;

/** This many spec-shaped lines make the request a spec. */
const SPEC_LINES = 3;

/**
 * A multi-item feature spec. The observe-before-fix guard once armed on
 * one — a Tree-sitter/RAG/MCP design whose last line said "to avoid
 * regression bugs" — and refused the turn's first edit as a fix made
 * without observing "the failure". A spec describes what to build; there
 * is no failure in it to observe. Pasted runtime evidence (a stack frame,
 * a 500 body) still wins: that is a bug report written as a list.
 */
export function looksLikeSpec(prompt: string): boolean {
  const text = stripHiddenContext(prompt);
  if (pastedEvidence(text)) return false;
  if (FEATURE_ASK.test(text)) return true;
  const specLines = text
    .split(/\r?\n/)
    .filter((line) => SPEC_LINE.test(line)).length;
  return specLines >= SPEC_LINES;
}

/** The user invoked the debugging protocol by name. */
const DEBUG_COMMAND = /^\s*\/(debug|debugging)\b/i;

/** "fix this" beside a screenshot: the picture is the symptom. */
const FIX_WITH_IMAGE = /\bfix\b/i;

export interface BugReportSignals {
  hasImages?: boolean;
  /** The symptom an earlier turn of this conversation was armed with. */
  carriedSymptom?: string | null;
  /**
   * The visible text of the page preview this turn was sent with. Lets a
   * complaint about on-screen COPY be told apart from a runtime failure.
   */
  previewText?: string;
}

/** A short "then?", "and?", "still broken" that continues a bug thread. */
const FOLLOW_UP = /^\s*(then|and|so|now|still|again|what now|why)\b[\s?!.]*$/i;

export function looksLikeBugReport(
  prompt: string,
  signals: BugReportSignals = {}
): boolean {
  const human = stripHiddenContext(prompt).trim();
  if (!human && !signals.hasImages) return false;
  if (DEBUG_COMMAND.test(human)) return true;
  // "I still see 'Save changes'" beside a preview that shows exactly that
  // text is a request to change the words, not a failure to observe.
  if (looksLikeCopyComplaint(human, signals.previewText ?? "")) return false;
  if (signals.carriedSymptom && FOLLOW_UP.test(human)) return true;
  if (signals.hasImages && FIX_WITH_IMAGE.test(human)) return true;
  if (looksLikeSpec(human)) return false;
  return SYMPTOM.test(human);
}

/**
 * The symptom words a copy complaint uses: the user can SEE the text and
 * wants it different. Anything else in {@link SYMPTOM} — a 500, a crash,
 * "not saving" — is about behaviour, and stays a bug report.
 */
const COPY_COMPLAINT_SOURCE = [
  "\\bstill (see|seeing|showing|shows)\\b",
  "\\bwrong (message|label|text|copy|wording)\\b",
].join("|");
const COPY_COMPLAINT = new RegExp(COPY_COMPLAINT_SOURCE, "i");
const COPY_COMPLAINT_ALL = new RegExp(COPY_COMPLAINT_SOURCE, "gi");

/** Vocabulary of a failure at runtime; its presence means a real bug. */
const RUNTIME_VOCABULARY =
  /error|exception|crash|4\d\d|5\d\d|stack|fail|not (loading|saving)|undefined|null/i;

/** Text in quotes of any style: the exact copy the user is pointing at. */
const QUOTED = /["“”']([^"“”'\n]{2,120})["“”']/g;

/** Phrases of this many words are specific enough to be UI copy. */
const PHRASE_WORDS = 3;

/**
 * Whether the human prompt complains about visible COPY rather than a
 * failure: "still see 'Something went wrong'" or "wrong label on the
 * button", where the quoted text (or a three-word phrase of the request)
 * is literally on the page right now, and nothing in the request talks
 * about errors, statuses or crashes.
 *
 * The observe-before-fix guard once armed on exactly this: the user
 * pointed at a label, the guard demanded a runtime observation of a
 * "failure" that was a string, and the turn spent itself on curl. Copy the
 * user can read off the screen is already observed.
 */
export function looksLikeCopyComplaint(human: string, previewText: string): boolean {
  const text = stripHiddenContext(human).trim();
  if (!text || !previewText) return false;
  if (RUNTIME_VOCABULARY.test(text)) return false;
  if (!COPY_COMPLAINT.test(text)) return false;
  // The symptom must come ONLY from the copy family: with those words
  // removed nothing else in the request reads as a failure.
  const rest = text.replace(COPY_COMPLAINT_ALL, " ");
  if (SYMPTOM.test(rest)) return false;
  return literalsOf(text).some((literal) => onScreen(literal, previewText));
}

/** Quoted strings first, then every 3-word window of the request. */
function literalsOf(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(QUOTED)) {
    if (match[1]) out.push(match[1]);
  }
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i + PHRASE_WORDS <= words.length; i += 1) {
    out.push(words.slice(i, i + PHRASE_WORDS).join(" "));
  }
  return out;
}

function onScreen(literal: string, previewText: string): boolean {
  const needle = squash(literal);
  return needle.length >= 2 && squash(previewText).includes(needle);
}

/** Case, whitespace and surrounding punctuation are not meaning here. */
function squash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The symptom sentence to carry: the first line of the human prompt that
 * names the failure, clipped. Shown back in hook reasons so the model is
 * told what it has to observe, not just that it has to observe something.
 */
export function symptomOf(prompt: string): string {
  const human = stripHiddenContext(prompt).trim();
  const line =
    human
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item && SYMPTOM.test(item)) ??
    human.split(/\r?\n/)[0] ??
    "";
  return line.length > 160 ? line.slice(0, 157) + "…" : line;
}

/**
 * Runtime evidence the user PASTED: a stack frame, a log line, a response
 * body with an error status. A screenshot is not this — pixels of an error
 * dialog say nothing about which request failed or with what body, and a
 * whole afternoon was once spent guessing at exactly that.
 */
const PASTED_EVIDENCE = new RegExp(
  [
    "^\\s*at .+\\(.+:\\d+:\\d+\\)",
    "\\bTraceback \\(most recent call last\\)",
    "\\[(ERROR|FATAL|error|fatal)\\]",
    "\\bHTTP/[\\d.]+ [45]\\d\\d\\b",
    "\"status(Code)?\"\\s*:\\s*[45]\\d\\d",
    "\\b(Unhandled|Uncaught) (Promise )?(Rejection|Exception|Error)\\b",
    "\\b(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError)\\b\\s*:",
    "\"(error|code|message)\"\\s*:\\s*\"",
    "\\bECONN(REFUSED|RESET)\\b|\\bENOTFOUND\\b|\\bEADDRINUSE\\b",
  ].join("|"),
  "m"
);

/**
 * A question that asks to DIAGNOSE a failure — "why is X failing", "what's
 * causing Y", "where does this break". These are answered, not implemented,
 * but they are the turns where a confident root-cause guess does the most
 * damage, so the conclusion gate arms on them too. A plain "how do I…" or
 * "what does this do" is not one.
 */
const DIAGNOSTIC_QUESTION = new RegExp(
  [
    "\\bwhy (is|are|does|do|did|would|won'?t|can'?t|isn'?t|aren'?t)\\b",
    "\\bwhat(?:'s| is| are)? (?:the )?(?:causing|caus(?:e|es)|reason|wrong|the issue|the problem)\\b",
    "\\bwhat(?:'s| is)? making\\b",
    "\\bwhere (?:is|does|do)\\b.*\\b(fail|break|wrong|error|lost|dropped)",
    "\\b(root ?cause|diagnos(e|is)|trace|figure out|find out|explain why)\\b",
    "\\bhow (come|is it)\\b",
  ].join("|"),
  "i"
);

export function looksLikeDiagnosticQuestion(prompt: string): boolean {
  const human = stripHiddenContext(prompt).trim();
  if (!human) return false;
  if (looksLikeSpec(human)) return false;
  return DIAGNOSTIC_QUESTION.test(human) || (SYMPTOM.test(human) && human.includes("?"));
}

/**
 * A report that states a DEFINITIVE cause or a completed fix — the claim the
 * user is entitled to see reproduced. "the root cause is", "this is caused by",
 * "the bug is in", "fixed in", "the problem is that". Matched only as a
 * confident assertion; a hedged version is caught by {@link isHedged}.
 */
const DEFINITIVE_CLAIM = new RegExp(
  [
    "\\b(the )?root ?cause (is|was|:)",
    "\\bis (?:being )?caused by\\b",
    "\\bthe (bug|issue|problem|error|failure|defect) (is|was|lies|lives|comes from|stems from|is in|is that|is caused)",
    "\\bthis (is|was) (?:happening )?because\\b",
    "\\bthe reason (is|was|for this is)\\b",
    "\\b(fixed|resolved|corrected|patched) (it|the|in|by|this)\\b",
    "\\bthe fix (is|was)\\b",
    "\\bnow (?:it )?(works|working|resolves|passes|succeeds)\\b",
    "\\bshould now (work|be fixed|resolve|pass)\\b",
  ].join("|"),
  "i"
);

/** Language that admits the diagnosis is not confirmed — allowed to pass. */
const HEDGE = new RegExp(
  [
    "\\b(likely|probabl|possibl|maybe|perhaps|might be|may be|could be|appears? to|seems? to|suspect|hypothesi|my (?:best )?guess|i think|i believe|presumabl|potential(?:ly)?)\\b",
    "\\b(not (?:yet )?(?:verified|confirmed|reproduced|tested)|haven'?t (?:verified|confirmed|reproduced|tested)|unverified|untested|without (?:reproducing|testing|verifying))\\b",
    "\\bneeds? (?:to be )?(?:verified|confirmed|reproduced|tested)\\b",
    "\\bif (?:this is|that'?s|my|the) (?:right|correct|assumption)\\b",
  ].join("|"),
  "i"
);

export function assertsDefinitiveCause(report: string): boolean {
  return DEFINITIVE_CLAIM.test(report);
}

export function isHedged(report: string): boolean {
  return HEDGE.test(report);
}

export function pastedEvidence(prompt: string): string | null {
  const human = stripHiddenContext(prompt);
  const match = PASTED_EVIDENCE.exec(human);
  if (!match) return null;
  const start = human.lastIndexOf("\n", match.index) + 1;
  const end = human.indexOf("\n", match.index + match[0].length);
  const line = human.slice(start, end === -1 ? undefined : end).trim();
  return line.length > 200 ? line.slice(0, 197) + "…" : line;
}
