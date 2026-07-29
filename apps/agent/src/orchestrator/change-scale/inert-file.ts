/**
 * Files no compiler, linter, test, or code reviewer can reason about: a
 * value in an env file, a line of prose, an image, a regenerated lockfile.
 * Nothing in them can duplicate a pattern, make a branch unreachable, or
 * break a caller — the defect classes the validate and review stages exist
 * to catch simply cannot occur there.
 *
 * Deliberately a DENY list, not an allow list: an unrecognised extension
 * counts as code and keeps its full review, so a new language never loses
 * scrutiny by being unknown here.
 */

/** Data/doc/asset extensions — nothing executable, nothing type-checked. */
const INERT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "markdown",
  "txt",
  "rst",
  "log",
  "csv",
  "tsv",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "webp",
  "avif",
  "woff",
  "woff2",
  "ttf",
  "eot",
]);

/**
 * Exact filenames that are inert regardless of extension. Lockfiles are
 * generated, and repo-hygiene dotfiles carry no program logic.
 */
const INERT_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "go.sum",
  "cargo.lock",
  "poetry.lock",
  "composer.lock",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  "license",
]);

/**
 * `.env`, `.env.local`, `.env.example`, `.env.production` — a key/value
 * file read at runtime. Note this is the *file* being inert, not the
 * change being unimportant: an env value can absolutely break an app, but
 * only code the reviewer reads elsewhere can show that.
 */
const ENV_FILE = /^\.env(\..+)?$/;

export function isInertFile(relPath: string): boolean {
  const base = relPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  if (!base) return false;
  if (ENV_FILE.test(base)) return true;
  if (INERT_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return INERT_EXTENSIONS.has(base.slice(dot + 1));
}
