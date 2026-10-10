/**
 * What the user can SEE on the page, pulled out of the hidden preview block.
 *
 * The composer attaches the live iframe's DOM, styles and console to every
 * send as `<atelier-hidden-context>`. That block is machine evidence for the
 * model; it was never meant to be read as the user's words. But a 37KB dump
 * riding inside the prompt string is exactly what every text-only reader
 * (intent, retrieval, grounding, summaries) saw — and on a screenshot turn
 * the model grepped a Tailwind class it found in it instead of the label
 * the user pointed at.
 *
 * This module is the one place that turns the block back into the few
 * hundred characters of VISIBLE text a human would name: element labels,
 * the page title, highlighted regions, selected text, and the text nodes of
 * the markup. Everything else in the block (selectors, classes, computed
 * styles, console URLs) is deliberately not here.
 */

const OPEN = "<atelier-hidden-context>";
const CLOSE = "</atelier-hidden-context>";

/** The hidden blocks of a prompt, markers removed, in order. */
export function hiddenBlocks(prompt: string): string[] {
  const blocks: string[] = [];
  let at = 0;
  for (;;) {
    const start = prompt.indexOf(OPEN, at);
    if (start === -1) break;
    const end = prompt.indexOf(CLOSE, start);
    const body =
      end === -1
        ? prompt.slice(start + OPEN.length)
        : prompt.slice(start + OPEN.length, end);
    blocks.push(body.trim());
    if (end === -1) break;
    at = end + CLOSE.length;
  }
  return blocks;
}

/** The body of one tagged section (`<name>…</name>`) inside a block. */
function section(block: string, name: string): string {
  const open = `<${name}>`;
  const close = `</${name}>`;
  const start = block.indexOf(open);
  if (start === -1) return "";
  const end = block.indexOf(close, start);
  return block.slice(start + open.length, end === -1 ? undefined : end);
}

/** Every JSON-quoted string on a line, decoded. */
function quotedOn(line: string): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    try {
      const text = JSON.parse(`"${match[1]}"`) as string;
      if (text.trim()) out.push(text.trim());
    } catch {
      // A malformed quote is not a label.
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/** Text nodes of a markup fragment, tags dropped, entities decoded. */
export function textOfMarkup(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Text inside the regions the user highlighted on the screenshot, plus any
 * selected text. Emitted by the renderer as `<focused-elements>` /
 * `<selection>` sections at the top of the block. Empty when the user
 * highlighted nothing — which is most turns.
 */
export function focusedLiterals(prompt: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (text: string): void => {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 160);
    if (clean.length < 2) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };
  for (const block of hiddenBlocks(prompt)) {
    const focused = section(block, "focused-elements");
    for (const line of focused.split(/\r?\n/)) {
      if (!line.trim().startsWith("-")) continue;
      for (const text of quotedOn(line)) add(text);
    }
    const selection = section(block, "selection");
    for (const line of selection.split(/\r?\n/)) {
      const quoted = quotedOn(line);
      if (quoted.length > 0) quoted.forEach(add);
      else if (/^\s*-/.test(line)) add(line.replace(/^\s*-\s*/, ""));
    }
  }
  return out.slice(0, 12);
}

/**
 * The visible strings of the previewed page, one per line, deduplicated:
 * highlighted text first, then the title, element labels, and finally the
 * markup's text nodes — so a cap cuts the least specific evidence first.
 */
export function previewVisibleText(prompt: string, maxChars = 4_000): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (text: string): void => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || clean === "(unlabelled)") return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(clean);
  };
  for (const literal of focusedLiterals(prompt)) add(literal);
  for (const block of hiddenBlocks(prompt)) {
    const title = /^Title:\s*(.+)$/m.exec(block)?.[1];
    if (title) add(title);
    // The page as rendered (innerText), one visible line per line. Always
    // present since the renderer stopped sending markup by default; it is
    // the section that carries a table's empty-state row, which no
    // interactive element ever names.
    const visible = section(block, "visible-text");
    for (const line of visible.split(/\r?\n/)) add(line);
    const interactive = section(block, "interactive-elements");
    for (const line of interactive.split(/\r?\n/)) {
      // Each line is `selector <tag> "label" (x,y wxh) …`; the label is
      // the only human-visible part.
      const label = quotedOn(line)[0];
      if (label) add(label);
    }
    const markup = section(block, "page-html");
    if (markup) {
      // Split the flattened text on runs of 2+ spaces where tags sat, so
      // each visible chunk stays its own line for literal matching.
      const text = textOfMarkup(markup.replace(/></g, ">  <"));
      for (const piece of text.split(/ {2,}/)) add(piece);
    }
  }
  let out = "";
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) break;
    out += (out ? "\n" : "") + line;
  }
  return out;
}
