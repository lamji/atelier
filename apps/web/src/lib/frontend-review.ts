import type { ExecutionTimelineVm } from "@/state/sessions.store";

export const FRONTEND_REVIEW_REQUEST_EVENT =
  "atelier:frontend-review-requested";

export interface FrontendReviewRequest {
  conversationId: string;
  taskId: string;
  request: string;
  changedFiles: string[];
}

export interface FrontendReviewTimelineContext {
  screenshotPath?: string;
  displayRequest?: string;
}

const FRONTEND_REVIEW_META_PREFIX = "ATELIER_FRONTEND_REVIEW_META ";

/** Durable metadata embedded in the review request for clean timeline hydration. */
export function frontendReviewTimelineMarker(
  context: FrontendReviewTimelineContext
): string {
  return `${FRONTEND_REVIEW_META_PREFIX}${JSON.stringify(context)}`;
}

export function frontendReviewTimelineContext(
  prompt: string
): FrontendReviewTimelineContext | null {
  const line = prompt
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(FRONTEND_REVIEW_META_PREFIX));
  if (!line) return null;
  try {
    const value = JSON.parse(
      line.slice(FRONTEND_REVIEW_META_PREFIX.length)
    ) as Partial<FrontendReviewTimelineContext>;
    const legacyUrl = prompt.match(
      /^Review the completed frontend task at (.+)\.$/m
    )?.[1];
    const displayRequest =
      typeof value.displayRequest === "string" && value.displayRequest
        ? value.displayRequest
        : legacyUrl
          ? `Review the completed frontend in Page preview · ${legacyUrl}`
          : undefined;
    return {
      ...(typeof value.screenshotPath === "string" && value.screenshotPath
        ? { screenshotPath: value.screenshotPath }
        : {}),
      ...(displayRequest ? { displayRequest } : {}),
    };
  } catch {
    return null;
  }
}

const FRONTEND_EXTENSION =
  /\.(?:tsx|jsx|vue|svelte|css|scss|sass|less|html?|astro)$/i;
const FRONTEND_FILE =
  /(?:^|\/)(?:apps?\/(?:web|frontend|client)|web|frontend|client|ui|components?|pages?|screens?|views?|widgets?)(?:\/|$)/i;
const FRAMEWORK_FILE =
  /(?:\.component\.ts|\.module\.css|\.stories\.[jt]sx?|\/lib\/.*\.dart)$/i;

export function frontendReviewRequest(
  conversationId: string,
  execution: ExecutionTimelineVm
): FrontendReviewRequest | null {
  if (execution.status !== "completed") return null;
  const changedFiles = [
    ...new Set(execution.diffs.map((diff) => diff.path.replace(/\\/g, "/"))),
  ];
  if (!changedFiles.some(isFrontendPath)) return null;
  return {
    conversationId,
    taskId: execution.taskId,
    request: execution.request,
    changedFiles,
  };
}

function isFrontendPath(path: string): boolean {
  return (
    FRONTEND_EXTENSION.test(path) ||
    FRONTEND_FILE.test(path) ||
    FRAMEWORK_FILE.test(path)
  );
}
