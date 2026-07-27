const RECENT_MS = 48 * 60 * 60 * 1000;
const BOOST = 0.1;

/**
 * Recently modified files are disproportionately likely to be what the
 * user is talking about. Uses the indexer's files.mtime — no git calls.
 */
export function recencyBoost(
  path: string,
  mtimeByPath: Map<string, number>,
  now: number
): number {
  const mtime = mtimeByPath.get(path);
  if (mtime === undefined) return 0;
  return now - mtime <= RECENT_MS ? BOOST : 0;
}
