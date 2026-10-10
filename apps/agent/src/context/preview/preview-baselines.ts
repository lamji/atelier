/**
 * What the previewed page showed when the turn was SENT — before any edit.
 *
 * A preview assertion is only evidence of a change if the asserted text
 * was not already there. A turn once "verified" its label fix by asserting
 * that the account id was visible in the header, which it had been all
 * along; the plan went green and the user asked "wait, you marked it
 * pass?". The tool needs the baseline to tell the two apart, and the
 * pipeline is the only place that has it (the hidden preview block rides
 * on the prompt, not on the tool call).
 */
export class PreviewBaselines {
  private texts = new Map<string, string>();

  set(taskId: string, visibleText: string): void {
    if (visibleText.trim()) this.texts.set(taskId, visibleText);
    else this.texts.delete(taskId);
  }

  get(taskId: string): string | null {
    return this.texts.get(taskId) ?? null;
  }

  /** Whether `text` was already visible on the page at send time. */
  had(taskId: string, text: string): boolean {
    const baseline = this.texts.get(taskId);
    if (!baseline || !text.trim()) return false;
    return baseline.toLowerCase().includes(text.trim().toLowerCase());
  }

  release(taskId: string): void {
    this.texts.delete(taskId);
  }
}
