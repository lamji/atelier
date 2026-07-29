/**
 * The set of tasks currently running with system knowledge switched OFF.
 *
 * Atelier's code guards exist to enforce its own knowledge engine — check
 * the blast radius before editing, keep one function per file, patch
 * instead of rewriting. A task the user explicitly asked to run as a plain
 * Claude/Codex turn has no knowledge engine behind it (impact_of_edit is
 * not even on its tool surface), so those guards would block edits the run
 * has no way to unblock. They consult this registry and step aside.
 *
 * The consent guards — git flow, database approval, dev server — are NOT
 * listed here on purpose: they ask the user, and bypassing knowledge is
 * not permission to act without them.
 */
export class DirectTaskRegistry {
  private ids = new Set<string>();

  mark(taskId: string): void {
    this.ids.add(taskId);
  }

  release(taskId: string): void {
    this.ids.delete(taskId);
  }

  has(taskId: string | undefined): boolean {
    return taskId !== undefined && this.ids.has(taskId);
  }
}
