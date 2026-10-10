import { z } from "zod";

/**
 * The signed-in browser state behind Page preview, lifted out of the in-app
 * iframe so the review browser can reuse it.
 *
 * These values are credentials. They travel renderer -> agent only, are held
 * in memory for one short window, and must never reach a prompt, a tool
 * result or a log line.
 */
export const PreviewSessionCookie = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  /** Unix seconds; -1 for a session cookie. */
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
});

export const PreviewStorageEntry = z.object({
  name: z.string(),
  value: z.string(),
});

/** One DevTools console line from the displayed preview iframe. */
export const PreviewConsoleEntry = z.object({
  level: z.enum(["log", "info", "warning", "error", "debug"]),
  message: z.string(),
  source: z.string().nullable(),
  line: z.number().nullable(),
  timestamp: z.number(),
});
export type PreviewConsoleEntry = z.infer<typeof PreviewConsoleEntry>;

export const PreviewConsoleCapture = z.object({
  url: z.string(),
  title: z.string(),
  capturedAt: z.number(),
  console: z.array(PreviewConsoleEntry),
});
export type PreviewConsoleCapture = z.infer<typeof PreviewConsoleCapture>;

/**
 * One step of a frontend review test case, executed against the LIVE in-app
 * Page preview iframe through the privileged desktop bridge — no external
 * browser. Authored by the agent before the review runs, so the review checks
 * the requested outcome instead of guessing from a screenshot.
 */
export const PreviewTestStep = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("navigate"),
    /** A route path ("/workspace?x=1") or a full localhost URL. */
    target: z.string(),
  }),
  z.object({
    action: z.literal("click"),
    selector: z.string().optional(),
    /** Click the element whose visible text matches, when no selector. */
    text: z.string().optional(),
  }),
  z.object({
    action: z.literal("fill"),
    selector: z.string(),
    value: z.string(),
  }),
  z.object({
    action: z.literal("press"),
    key: z.string(),
    selector: z.string().optional(),
  }),
  z.object({
    action: z.literal("waitFor"),
    selector: z.string().optional(),
    text: z.string().optional(),
    state: z.enum(["visible", "hidden"]).default("visible"),
    timeoutMs: z.number().int().positive().max(30_000).optional(),
  }),
  z.object({
    action: z.literal("assert"),
    /** What this checks, in the agent's words — shown in the result. */
    description: z.string(),
    selector: z.string().optional(),
    /** Passes when this text is present (or, with `absent`, is not). */
    text: z.string().optional(),
    /** Passes when this text is NOT present. */
    notText: z.string().optional(),
    /** Passes when the selector matches a visible element. */
    visible: z.boolean().optional(),
    /** Passes when the selector matches nothing. */
    absent: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("screenshot"),
    label: z.string().optional(),
  }),
]);
export type PreviewTestStep = z.infer<typeof PreviewTestStep>;

export const PreviewTestCase = z.object({
  /** One line naming the behaviour under test. */
  title: z.string(),
  /** The route the test opens on, path or full localhost URL. */
  url: z.string().optional(),
  steps: z.array(PreviewTestStep).min(1).max(40),
});
export type PreviewTestCase = z.infer<typeof PreviewTestCase>;

export const PreviewTestStepResult = z.object({
  index: z.number().int(),
  action: z.string(),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  error: z.string().optional(),
  /** Present for a screenshot step: the saved image path. */
  screenshotPath: z.string().optional(),
});
export type PreviewTestStepResult = z.infer<typeof PreviewTestStepResult>;

export const PreviewTestReport = z.object({
  /** passed — every assertion held; failed — one did not; unavailable — no preview. */
  status: z.enum(["passed", "failed", "unavailable"]),
  title: z.string(),
  url: z.string(),
  steps: z.array(PreviewTestStepResult),
  assertions: z.object({
    total: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
  }),
  consoleErrors: z.array(z.string()),
  reason: z.string().optional(),
});
export type PreviewTestReport = z.infer<typeof PreviewTestReport>;

export const previewMethods = {
  /** Publishes the live preview session for the next preview_review call. */
  "preview.session.set": {
    params: z.object({
      /** Live frame URL, including the client-side route. */
      url: z.string(),
      origin: z.string(),
      cookies: z.array(PreviewSessionCookie),
      localStorage: z.array(PreviewStorageEntry),
      sessionStorage: z.array(PreviewStorageEntry),
      capturedAt: z.number(),
    }),
    result: z.object({
      accepted: z.boolean(),
      /** Why a snapshot was rejected, for the renderer's console only. */
      reason: z.string().optional(),
    }),
  },
  /** Drops the held session, e.g. when Page preview closes or signs out. */
  "preview.session.clear": {
    params: z.object({ origin: z.string().optional() }).optional(),
    result: z.object({ cleared: z.boolean() }),
  },
  /**
   * The renderer's answer to `preview.capture.requested`: the displayed
   * iframe's console, read through the desktop bridge. Console text is
   * diagnostic output, not a credential, so it may reach a tool result.
   */
  "preview.capture.resolve": {
    params: z.object({
      id: z.string(),
      capture: PreviewConsoleCapture.nullable(),
      /** Why there is no capture: no preview open, bridge unavailable… */
      reason: z.string().optional(),
    }),
    result: z.object({ ok: z.boolean() }),
  },
  /**
   * The renderer's answer to `preview.test.requested`: the outcome of running
   * the authored test case against the live in-app preview iframe.
   */
  "preview.test.resolve": {
    params: z.object({
      id: z.string(),
      report: PreviewTestReport.nullable(),
      reason: z.string().optional(),
    }),
    result: z.object({ ok: z.boolean() }),
  },
} as const;
