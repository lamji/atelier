import { isInertFile } from "./inert-file.js";

/** Conventional test-file shapes for the JS/TS runners a script invokes. */
const TEST_FILE = /(^|[\\/])__tests__[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/;

function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/**
 * The changed test files, but ONLY when the change touched nothing else.
 *
 * A full suite is the honest answer to a source edit: anything importing the
 * file that moved can now fail, and narrowing the run would report green on
 * tests that were never executed. When the only code that moved is test code,
 * that risk is gone and re-running every other suite is minutes spent
 * re-confirming the previous result — the case the agent hits constantly
 * while it iterates on one spec file.
 *
 * Returns an empty array to mean "no narrowing", which is what the runner
 * treats as a full run.
 */
export function testOnlyPaths(changedFiles: string[]): string[] {
  const live = changedFiles.filter((path) => !isInertFile(path));
  if (live.length === 0) return [];
  if (!live.every(isTestFile)) return [];
  return live.map((path) => path.replaceAll("\\", "/"));
}
