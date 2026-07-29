/** A leading YAML block — `---\n…\n---` at the very top of the file. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** The file without its leading YAML block, unchanged when it has none. */
export function stripFrontmatter(content: string): string {
  const fm = FRONTMATTER.exec(content);
  return fm ? content.slice(fm[0].length) : content;
}

/**
 * Rewrites (or adds) the `status:` line of a markdown file's YAML
 * frontmatter, creating the block when the file has none.
 *
 * Shared rather than copied: the Markdown panel's dropdown and the agent's
 * task lifecycle both write this line, and two implementations drifting is
 * exactly what leaves one note showing two different states.
 */
export function upsertFrontmatterStatus(
  content: string,
  status: string
): string {
  const fm = FRONTMATTER.exec(content);
  if (!fm) return `---\nstatus: ${status}\n---\n\n${content}`;
  const body = fm[1]!;
  const nextBody = /^status\s*:/im.test(body)
    ? body.replace(/^status\s*:.*$/im, `status: ${status}`)
    : `status: ${status}\n${body}`;
  return `---\n${nextBody}\n---\n${content.slice(fm[0].length)}`;
}
