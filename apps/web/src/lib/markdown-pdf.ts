import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Markdown → PDF, via a self-contained print document.
 *
 * The desktop shell renders the HTML offscreen and writes a real PDF; in
 * the browser there is no such thing, so it opens a print window and lets
 * the user pick "Save as PDF" — same destination, different plumbing.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Print CSS. Deliberately light-on-white — a PDF is not a dark theme. */
const PRINT_CSS = `
  @page { size: A4; margin: 18mm 16mm; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 11pt; line-height: 1.55; color: #16181d; background: #fff;
    margin: 0;
  }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.5em; }
  h1 { font-size: 20pt; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; }
  p, li { orphans: 2; widows: 2; }
  ul, ol { padding-left: 1.3em; }
  code {
    font-family: "Cascadia Mono", Consolas, monospace; font-size: 9.5pt;
    background: #f2f3f5; padding: 0.1em 0.3em; border-radius: 3px;
  }
  pre {
    background: #f6f7f9; border: 1px solid #e3e5e9; border-radius: 6px;
    padding: 10px 12px; overflow-wrap: break-word; white-space: pre-wrap;
  }
  pre code { background: none; padding: 0; }
  blockquote {
    margin: 1em 0; padding: 0.2em 0 0.2em 1em;
    border-left: 3px solid #d7dae0; color: #4b5058;
  }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; }
  th, td { border: 1px solid #dcdfe4; padding: 5px 8px; text-align: left; }
  th { background: #f4f5f7; }
  img { max-width: 100%; }
  a { color: #1b5fbf; text-decoration: none; }
`;

/** A complete HTML document for the markdown, ready to print. */
export function markdownPrintDocument(markdown: string, title: string): string {
  // Rendered through the same react-markdown + GFM stack the chat uses, so
  // a document looks in the PDF the way it looked on screen.
  const body = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm] }, markdown)
  );
  return (
    "<!doctype html><html><head><meta charset='utf-8'>" +
    `<title>${escapeHtml(title)}</title>` +
    `<style>${PRINT_CSS}</style></head><body>${body}</body></html>`
  );
}

/** Strips directories and the .md suffix for the default file name. */
export function pdfNameFor(title: string): string {
  return (
    title
      .replace(/\.md$/i, "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .trim() || "document"
  );
}

export interface ExportResult {
  ok: boolean;
  /** Where it was saved (desktop only); null when handed to a print dialog. */
  path: string | null;
}

export async function exportMarkdownToPdf(
  markdown: string,
  title: string
): Promise<ExportResult> {
  const html = markdownPrintDocument(markdown, title);
  const name = pdfNameFor(title);

  if (window.atelierDesktop) {
    const path = await window.atelierDesktop.exportPdf(html, name);
    // A cancelled save dialog is a choice, not a failure.
    return { ok: path !== null, path };
  }

  const win = window.open("", "_blank", "noopener,noreferrer");
  if (!win) return { ok: false, path: null };
  win.document.write(html);
  win.document.close();
  // Give the document a tick to lay out before the print dialog measures it.
  win.setTimeout(() => win.print(), 150);
  return { ok: true, path: null };
}
