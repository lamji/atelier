import type { GuardVerdict } from "./modularity-guard.js";

export const FLEX_LAYOUT_HOOK_ID = "builtin-flex-first-layout";
export const FLEX_LAYOUT_HOOK_NAME = "UI layout: flex-first centering";

const UI_FILE = /\.(?:css|scss|sass|less|tsx|jsx|html|vue|svelte)$/i;
const CSS_BLOCK = /([^{}]+)\{([^{}]*)\}/gs;
const MARKUP_TAG = /<[A-Za-z][^<>]*>/gs;
const CENTER_CSS =
  /(?:align-items|justify-content|place-items|place-content)\s*:\s*center\b/i;
const FLEX_CSS = /display\s*:\s*(?:inline-)?flex\b/i;
const NON_FLEX_CENTER_CSS =
  /(?:display\s*:\s*(?:inline-)?grid\b[^{}]*(?:place-items|place-content)\s*:\s*center|position\s*:\s*(?:absolute|fixed)\b[^{}]*(?:top|left)\s*:\s*50%[^{}]*transform\s*:[^{}]*translate)/i;
const CENTER_UTILITY =
  /(?:^|\s)(?:items-center|justify-center|place-items-center|place-content-center)(?=\s|$)/i;
const FLEX_UTILITY = /(?:^|\s)(?:inline-)?flex(?=\s|$)/i;
const NON_FLEX_CENTER_UTILITY =
  /(?:^|\s)(?:grid|inline-grid)(?=\s|$)[\s\S]*(?:^|\s)(?:place-items-center|place-content-center)(?=\s|$)|(?:^|\s)(?:absolute|fixed)(?=\s|$)[\s\S]*(?:^|\s)(?:left-1\/2|top-1\/2)(?=\s|$)[\s\S]*(?:^|\s)-?translate-[xy]-1\/2(?=\s|$)/i;
const INLINE_CENTER =
  /(?:alignItems|justifyContent|placeItems|placeContent)\s*:\s*["']center["']/i;
const INLINE_FLEX = /display\s*:\s*["'](?:inline-)?flex["']/i;
const NON_FLEX_INLINE_CENTER =
  /display\s*:\s*["'](?:inline-)?grid["'][\s\S]*(?:placeItems|placeContent)\s*:\s*["']center["']|position\s*:\s*["'](?:absolute|fixed)["'][\s\S]*(?:top|left)\s*:\s*["']?50%/i;

/**
 * Refuses newly introduced UI centering that bypasses flexbox.
 *
 * The guard compares violations before and after a write, so legacy grid or
 * absolute-positioned layouts stay editable until that layout is actually
 * changed. It checks complete CSS blocks and markup tags rather than only the
 * replacement text, which lets a small edit reuse an existing flex declaration
 * elsewhere in the same rule or className.
 */
export class FlexLayoutGuard {
  check(
    relPath: string,
    nextContent: string,
    prevContent = ""
  ): GuardVerdict {
    if (!UI_FILE.test(relPath)) return { ok: true };

    const before = this.violations(prevContent);
    const after = this.violations(nextContent);
    const introduced = [...after].find((violation) => !before.has(violation));
    if (!introduced) return { ok: true };

    return {
      ok: false,
      reason:
        `${relPath} introduces non-flex UI centering (${introduced}). ` +
        "Atelier's flex-first layout rule requires the owning container to " +
        "use display: flex (or flex/inline-flex utilities) with align-items " +
        "and/or justify-content centering. For full-screen centering, use " +
        "both axes. Do not replace basic flex centering with grid, absolute " +
        "positioning/transforms, spacer margins, or fixed coordinates.",
    };
  }

  private violations(content: string): Set<string> {
    const found = new Set<string>();

    for (const match of content.matchAll(CSS_BLOCK)) {
      const selector = this.normalize(match[1] ?? "");
      const body = match[2] ?? "";
      if (NON_FLEX_CENTER_CSS.test(body)) {
        found.add(`CSS block ${selector || "(anonymous)"} uses grid/position centering`);
      } else if (CENTER_CSS.test(body) && !FLEX_CSS.test(body)) {
        found.add(`CSS block ${selector || "(anonymous)"} centers without display:flex`);
      }
    }

    for (const match of content.matchAll(MARKUP_TAG)) {
      const tag = match[0];
      const normalized = this.normalizeMarkup(tag);
      const label = /^<([\w.-]+)/.exec(tag)?.[1] ?? "element";
      if (
        NON_FLEX_CENTER_UTILITY.test(normalized) ||
        NON_FLEX_INLINE_CENTER.test(tag)
      ) {
        found.add(`<${label}> uses grid/position centering`);
      } else if (
        (CENTER_UTILITY.test(normalized) && !FLEX_UTILITY.test(normalized)) ||
        (INLINE_CENTER.test(tag) && !INLINE_FLEX.test(tag))
      ) {
        found.add(`<${label}> centers without flex`);
      }
    }

    return found;
  }

  private normalize(value: string): string {
    return value.replace(/\s+/g, " ").trim().slice(-120);
  }

  private normalizeMarkup(value: string): string {
    return value
      .replace(/[\n\r\t"'{}`()\[\],]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}
