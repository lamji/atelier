import { isInertFile } from "./inert-file.js";

/**
 * Whether a change put anything in front of the code-shaped stages. The
 * heavyweight tail of the pipeline — validators, the embedding clone
 * sweep, the independent-review repair loop — only earns its cost when
 * real code moved. Run it on a one-line env or markdown edit and it does
 * not find defects; it invents adjacent work, because a reviewer asked to
 * judge a config value has nothing in its rubric to judge and reaches for
 * the repo around it instead.
 */
export function touchesCode(changedFiles: string[]): boolean {
  return changedFiles.some((path) => !isInertFile(path));
}
