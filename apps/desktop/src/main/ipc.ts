import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type WebContents,
  type WebFrameMain,
} from "electron";
import { writeFile } from "node:fs/promises";
import {
  IPC_CHANNELS,
  type DesktopPreviewActResult,
  type DesktopPreviewActStep,
  type DesktopPreviewConsoleEntry,
  type DesktopPreviewContextResult,
  type DesktopPreviewFocusRect,
  type DesktopPreviewSessionCookie,
  type DesktopPreviewSessionResult,
  type DesktopPreviewStorageEntry,
} from "../shared/ipc-contract";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const MAX_PREVIEW_CONSOLE_ENTRIES = 200;
const previewConsoleByContents = new WeakMap<
  WebContents,
  DesktopPreviewConsoleEntry[]
>();

/** Highlight rects the focus pass will walk; more is a mis-drawn screenshot. */
const MAX_PREVIEW_FOCUS_RECTS = 8;
/** Elements named per highlighted region. */
const MAX_PREVIEW_FOCUSED_PER_RECT = 12;
const MAX_PREVIEW_FOCUSED_TEXT_CHARS = 200;
const MAX_PREVIEW_SELECTION_CHARS = 300;
/** innerText of the page as rendered — what a person can read on it. */
const MAX_PREVIEW_VISIBLE_TEXT_CHARS = 4_000;

/**
 * The DOM/CSS/interactive snapshot plus a focus pass. The focus rects are
 * embedded as a JSON literal — data, not code — so the pass runs in the
 * frame's own world with no second round trip.
 */
function previewContextScript(focus: DesktopPreviewFocusRect[]): string {
  return `(() => {
  const focusRects = ${JSON.stringify(focus)};
  const MAX_FOCUSED_PER_RECT = ${MAX_PREVIEW_FOCUSED_PER_RECT};
  const MAX_FOCUSED_TEXT = ${MAX_PREVIEW_FOCUSED_TEXT_CHARS};
  const MAX_SELECTION = ${MAX_PREVIEW_SELECTION_CHARS};
  const MAX_VISIBLE_TEXT = ${MAX_PREVIEW_VISIBLE_TEXT_CHARS};
  const selectorFor = (element) => {
    if (element.id) {
      return element.tagName.toLowerCase() + '#' + CSS.escape(element.id);
    }
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (sibling) => sibling.tagName === current.tagName
        );
        if (siblings.length > 1) {
          part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return ['html', ...parts].join(' > ');
  };
  const stylesheets = Array.from(document.styleSheets).map((sheet, index) => {
    const source = sheet.href || 'inline stylesheet ' + (index + 1);
    try {
      return '/* ' + source + ' */\\n' +
        Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\\n');
    } catch {
      return '/* ' + source + ' — rules unavailable to CSSOM */';
    }
  });
  const interactive = Array.from(document.querySelectorAll(
    'button, a[href], input, select, textarea, [role="button"], [tabindex]'
  )).map((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim(),
      ariaLabel: element.getAttribute('aria-label'),
      role: element.getAttribute('role'),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      style: {
        color: style.color,
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        font: style.font,
        display: style.display,
        visibility: style.visibility,
      },
    };
  });
  const cleanText = (value, max) =>
    String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
  // What the user can read on the element: its rendered text, or for a
  // form control the value/placeholder that stands in for it.
  const visibleText = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const own = tag === 'select'
        ? (element.selectedOptions[0] && element.selectedOptions[0].textContent)
        : element.value;
      return cleanText(own || element.placeholder, MAX_FOCUSED_TEXT);
    }
    if (tag === 'img') return cleanText(element.alt, MAX_FOCUSED_TEXT);
    return cleanText(element.innerText || element.textContent, MAX_FOCUSED_TEXT);
  };
  // Text the element renders itself (not through a descendant), so the
  // deepest element wins and its ancestors stop repeating the same words.
  const ownText = (element) => {
    let text = '';
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue;
    }
    return cleanText(text, MAX_FOCUSED_TEXT);
  };
  const isLabelled = (element) => {
    const tag = element.tagName.toLowerCase();
    return (
      tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'img' ||
      !!element.getAttribute('aria-label')
    );
  };
  const depthOf = (element) => {
    let depth = 0;
    for (let node = element; node; node = node.parentElement) depth += 1;
    return depth;
  };
  const roundRect = (rect) => ({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
  const SKIPPED = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'path', 'html', 'body',
  ]);
  const allElements = focusRects.length > 0
    ? Array.from(document.querySelectorAll('body *'))
    : [];
  const focused = [];
  focusRects.forEach((focus, index) => {
    const rectArea = focus.width * focus.height;
    const hits = [];
    for (const element of allElements) {
      if (SKIPPED.has(element.tagName.toLowerCase())) continue;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      const overlapWidth =
        Math.min(box.right, focus.x + focus.width) - Math.max(box.left, focus.x);
      const overlapHeight =
        Math.min(box.bottom, focus.y + focus.height) - Math.max(box.top, focus.y);
      if (overlapWidth <= 0 || overlapHeight <= 0) continue;
      // A neighbour whose border merely touches the region is not "under"
      // it: demand real overlap relative to whichever is smaller.
      const overlap = overlapWidth * overlapHeight;
      const smaller = Math.min(box.width * box.height, rectArea);
      if (overlap < 0.3 * smaller) continue;
      const own = ownText(element);
      if (!own && !isLabelled(element)) continue;
      hits.push({ element, box, depth: depthOf(element), own });
    }
    hits.sort((a, b) => b.depth - a.depth);
    for (const hit of hits.slice(0, MAX_FOCUSED_PER_RECT)) {
      focused.push({
        region: index + 1,
        selector: selectorFor(hit.element),
        tag: hit.element.tagName.toLowerCase(),
        text: hit.own || visibleText(hit.element),
        ariaLabel: hit.element.getAttribute('aria-label'),
        rect: roundRect(hit.box),
      });
    }
  });
  const active = document.activeElement;
  const activeElement =
    active && active !== document.body && active !== document.documentElement
      ? {
          selector: selectorFor(active),
          tag: active.tagName.toLowerCase(),
          text: visibleText(active),
        }
      : null;
  const selection = window.getSelection();
  const selectionText = cleanText(selection ? selection.toString() : '', MAX_SELECTION);
  // What a person can read on the page, as rendered (innerText honours
  // visibility). The agent matches the user's words against this to find
  // the label they are looking at when they say "this" or "the text".
  // (visibleText() above is the per-element helper; this is the page's.)
  const pageText = cleanText(
    document.body ? document.body.innerText : '',
    MAX_VISIBLE_TEXT
  );
  return {
    url: location.href,
    title: document.title,
    html: document.documentElement.outerHTML,
    css: stylesheets.join('\\n\\n'),
    interactive,
    focused,
    activeElement,
    selectionText,
    visibleText: pageText,
  };
})()`;
}

/**
 * The renderer's focus rects, checked shape by shape: anything that is not a
 * finite, non-empty rectangle is dropped rather than embedded in the script.
 */
function previewFocusRects(options: unknown): DesktopPreviewFocusRect[] {
  if (!options || typeof options !== "object") return [];
  const focus = (options as { focus?: unknown }).focus;
  if (!Array.isArray(focus)) return [];
  const rects: DesktopPreviewFocusRect[] = [];
  for (const candidate of focus) {
    if (!isCaptureRect(candidate)) continue;
    if (candidate.width <= 0 || candidate.height <= 0) continue;
    rects.push({
      x: candidate.x,
      y: candidate.y,
      width: candidate.width,
      height: candidate.height,
    });
    if (rects.length >= MAX_PREVIEW_FOCUS_RECTS) break;
  }
  return rects;
}

/**
 * Reads the preview frame's own web storage.
 *
 * Cookies come from the Electron session instead — HttpOnly auth cookies are
 * invisible to page script, and those are usually the ones that matter.
 */
const PREVIEW_SESSION_SCRIPT = `(() => {
  const read = (store) => {
    const entries = [];
    try {
      for (let index = 0; index < store.length; index += 1) {
        const name = store.key(index);
        if (name === null) continue;
        const value = store.getItem(name);
        if (typeof value === 'string') entries.push({ name, value });
      }
    } catch {
      // A storage-blocked origin simply contributes nothing.
    }
    return entries;
  };
  return {
    url: location.href,
    localStorage: read(localStorage),
    sessionStorage: read(sessionStorage),
  };
})()`;

const MAX_PREVIEW_STORAGE_ENTRIES = 200;
const MAX_PREVIEW_STORAGE_VALUE_CHARS = 128_000;

/** Default deadline for a waitFor step, in ms. */
const PREVIEW_WAIT_DEFAULT_MS = 6_000;

/**
 * The in-frame test driver, injected whole so all the DOM helpers live in the
 * frame's own world. It runs one step and resolves `{ ok, detail, error }`.
 *
 * Runs from the privileged main process (WebFrameMain.executeJavaScript), so
 * it reaches into the preview's cross-origin frame that renderer script never
 * could. The step is embedded as a JSON literal — data, not code.
 */
function previewActScript(step: DesktopPreviewActStep, defaultWaitMs: number): string {
  return `(async () => {
  const step = ${JSON.stringify(step)};
  const DEFAULT_WAIT = ${defaultWaitMs};
  const isVisible = (el) => {
    if (!el) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' &&
      Number(style.opacity) !== 0;
  };
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const byText = (text, opts) => {
    const want = norm(text);
    const nodes = Array.from(document.querySelectorAll('body *'));
    const matches = nodes.filter((el) => {
      if (opts && opts.visibleOnly && !isVisible(el)) return false;
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' ');
      const hay = norm(own) || norm(el.getAttribute && el.getAttribute('aria-label'));
      if (hay && hay.includes(want)) return true;
      // Fall back to full textContent for leaf-ish controls (a button whose
      // label is one nested span).
      return el.children.length <= 2 && norm(el.textContent).includes(want);
    });
    // The deepest match is the actual control, not a wrapping container.
    matches.sort((a, b) =>
      (b.compareDocumentPosition(a) & 8) ? 1 : (a.contains(b) ? 1 : -1));
    return matches[matches.length - 1] || null;
  };
  const resolveEl = (sel, text, visibleOnly) => {
    if (sel) {
      const found = Array.from(document.querySelectorAll(sel));
      const vis = found.find((el) => isVisible(el));
      return (visibleOnly ? vis : found[0]) || found[0] || null;
    }
    if (text) return byText(text, { visibleOnly });
    return null;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setNativeValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
  };
  try {
    if (step.action === 'navigate') {
      const url = /^https?:/i.test(step.target)
        ? step.target
        : location.origin + (step.target.startsWith('/') ? step.target : '/' + step.target);
      location.href = url;
      return { ok: true, detail: 'navigating to ' + url };
    }
    if (step.action === 'click') {
      const el = resolveEl(step.selector, step.text, true);
      if (!el) return { ok: false, error: 'no element for ' + (step.selector || step.text) };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, detail: 'clicked ' + (step.selector || JSON.stringify(step.text)) };
    }
    if (step.action === 'fill') {
      const el = resolveEl(step.selector, null, true);
      if (!el) return { ok: false, error: 'no input for ' + step.selector };
      el.focus();
      setNativeValue(el, step.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, detail: 'filled ' + step.selector };
    }
    if (step.action === 'press') {
      const el = step.selector ? resolveEl(step.selector, null, true) : document.activeElement;
      const target = el || document.body;
      for (const type of ['keydown', 'keypress', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, {
          key: step.key, bubbles: true, cancelable: true,
        }));
      }
      if (step.key === 'Enter' && target.form) {
        if (typeof target.form.requestSubmit === 'function') target.form.requestSubmit();
        else target.form.submit();
      }
      return { ok: true, detail: 'pressed ' + step.key };
    }
    if (step.action === 'waitFor') {
      const deadline = Date.now() + (step.timeoutMs || DEFAULT_WAIT);
      const wantHidden = step.state === 'hidden';
      while (Date.now() < deadline) {
        const el = resolveEl(step.selector, step.text, !wantHidden);
        const present = wantHidden ? !el || !isVisible(el) : !!el && isVisible(el);
        if (present) return { ok: true, detail: 'waited for ' + (step.selector || step.text) };
        await sleep(120);
      }
      return { ok: false, error: 'timed out waiting for ' +
        (step.selector || step.text) + ' to be ' + (step.state || 'visible') };
    }
    if (step.action === 'assert') {
      const label = step.description;
      if (step.absent) {
        const el = resolveEl(step.selector, step.text, false);
        return el
          ? { ok: false, error: label + ' — expected absent, but it is present' }
          : { ok: true, detail: label };
      }
      if (step.notText !== undefined) {
        const scope = step.selector ? resolveEl(step.selector, null, false) : document.body;
        const hay = norm(scope ? scope.textContent : '');
        return hay.includes(norm(step.notText))
          ? { ok: false, error: label + ' — found unexpected text "' + step.notText + '"' }
          : { ok: true, detail: label };
      }
      if (step.text !== undefined) {
        const scope = step.selector ? resolveEl(step.selector, null, false) : document.body;
        const hay = norm(scope ? scope.textContent : '');
        return hay.includes(norm(step.text))
          ? { ok: true, detail: label }
          : { ok: false, error: label + ' — text "' + step.text + '" not found' };
      }
      const el = resolveEl(step.selector, null, false);
      if (step.visible) {
        return el && isVisible(el)
          ? { ok: true, detail: label }
          : { ok: false, error: label + ' — "' + step.selector + '" is not visible' };
      }
      return el
        ? { ok: true, detail: label }
        : { ok: false, error: label + ' — "' + step.selector + '" not found' };
    }
    return { ok: false, error: 'unknown action' };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
})()`;
}

function previewSameSite(
  value: string | undefined
): DesktopPreviewSessionCookie["sameSite"] {
  if (value === "strict") return "Strict";
  if (value === "no_restriction") return "None";
  // Chromium treats an unspecified SameSite as Lax, and so does Playwright.
  return "Lax";
}

function previewStorageEntries(value: unknown): DesktopPreviewStorageEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: DesktopPreviewStorageEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { name, value: stored } = entry as Record<string, unknown>;
    if (typeof name !== "string" || typeof stored !== "string") continue;
    if (stored.length > MAX_PREVIEW_STORAGE_VALUE_CHARS) continue;
    entries.push({ name, value: stored });
    if (entries.length >= MAX_PREVIEW_STORAGE_ENTRIES) break;
  }
  return entries;
}

function isSafeExternal(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function isCaptureRect(value: unknown): value is {
  x: number;
  y: number;
  width: number;
  height: number;
  previewUrl?: string;
} {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return (
    typeof rect.x === "number" &&
    Number.isFinite(rect.x) &&
    typeof rect.y === "number" &&
    Number.isFinite(rect.y) &&
    typeof rect.width === "number" &&
    Number.isFinite(rect.width) &&
    rect.width > 0 &&
    typeof rect.height === "number" &&
    Number.isFinite(rect.height) &&
    rect.height > 0
  );
}

function localPreviewOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    return local && (url.protocol === "http:" || url.protocol === "https:")
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Resolve the exact live iframe so SPA navigation and runtime state are preserved. */
function previewFrame(
  webContents: WebContents,
  requestedUrl: unknown
): WebFrameMain | null {
  const origin = localPreviewOrigin(requestedUrl);
  if (!origin) return null;
  for (const frame of webContents.mainFrame.framesInSubtree) {
    try {
      if (new URL(frame.url).origin === origin) return frame;
    } catch {
      // Ignore transient or non-URL child frames.
    }
  }
  return null;
}

function previewFrameUrl(webContents: WebContents, requestedUrl: unknown): string | null {
  return previewFrame(webContents, requestedUrl)?.url ?? null;
}

/** Keep a bounded DevTools-style buffer for local preview frames. */
export function wirePreviewContextEvents(win: BrowserWindow): void {
  const entries: DesktopPreviewConsoleEntry[] = [];
  previewConsoleByContents.set(win.webContents, entries);
  win.webContents.on("console-message", (_event, level, message, line, source) => {
    if (level < 2 || !localPreviewOrigin(source)) return;
    entries.push({
      level: level >= 3 ? "error" : "warning",
      message: message.slice(0, 2_000),
      source: source || null,
      line: Number.isFinite(line) ? line : null,
      timestamp: Date.now(),
    });
    if (entries.length > MAX_PREVIEW_CONSOLE_ENTRIES) {
      entries.splice(0, entries.length - MAX_PREVIEW_CONSOLE_ENTRIES);
    }
  });
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.pickFolder, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
      title: "Open Folder",
    });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(
    IPC_CHANNELS.captureRegion,
    async (event, rect: unknown) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !isCaptureRect(rect)) return null;
      const contentSize = win.getContentSize();
      const contentWidth = contentSize[0] ?? 0;
      const contentHeight = contentSize[1] ?? 0;
      if (contentWidth < 1 || contentHeight < 1) return null;
      const x = Math.max(0, Math.min(Math.floor(rect.x), contentWidth - 1));
      const y = Math.max(0, Math.min(Math.floor(rect.y), contentHeight - 1));
      const width = Math.min(Math.ceil(rect.width), contentWidth - x);
      const height = Math.min(Math.ceil(rect.height), contentHeight - y);
      if (width < 1 || height < 1) return null;
      const image = await win.webContents.capturePage({ x, y, width, height });
      return {
        dataUrl: image.toDataURL(),
        frameUrl: previewFrameUrl(event.sender, rect.previewUrl),
      };
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.previewContext,
    async (
      event,
      requestedUrl: unknown,
      options?: unknown
    ): Promise<DesktopPreviewContextResult | null> => {
      const frame = previewFrame(event.sender, requestedUrl);
      const origin = localPreviewOrigin(requestedUrl);
      if (!frame || !origin) return null;
      // The one-argument call (no options) still takes the same path: an
      // empty focus list simply skips the DOM walk.
      const script = previewContextScript(previewFocusRects(options));
      const snapshot = (await frame.executeJavaScript(script)) as
        | Omit<DesktopPreviewContextResult, "console" | "capturedAt">
        | null;
      if (!snapshot || typeof snapshot.html !== "string") return null;
      const consoleEntries = previewConsoleByContents.get(event.sender) ?? [];
      return {
        ...snapshot,
        console: consoleEntries.filter(
          (entry) => localPreviewOrigin(entry.source) === origin
        ),
        capturedAt: Date.now(),
      };
    }
  );

  /**
   * Hands the review browser the session the user is already signed into.
   *
   * Without it, Playwright opens an empty profile, the app bounces it to its
   * login route, and the review audits /auth instead of the changed screen.
   */
  ipcMain.handle(
    IPC_CHANNELS.previewSession,
    async (event, requestedUrl: unknown): Promise<DesktopPreviewSessionResult | null> => {
      const frame = previewFrame(event.sender, requestedUrl);
      const origin = localPreviewOrigin(requestedUrl);
      if (!frame || !origin) return null;

      const storage = (await frame
        .executeJavaScript(PREVIEW_SESSION_SCRIPT)
        .catch(() => null)) as
        | { url?: unknown; localStorage?: unknown; sessionStorage?: unknown }
        | null;

      const liveUrl =
        typeof storage?.url === "string" && localPreviewOrigin(storage.url) === origin
          ? storage.url
          : frame.url;

      const raw = await event.sender.session.cookies
        .get({ url: liveUrl })
        .catch(() => []);
      const cookies: DesktopPreviewSessionCookie[] = raw.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? new URL(origin).hostname,
        path: cookie.path ?? "/",
        expires:
          typeof cookie.expirationDate === "number"
            ? Math.floor(cookie.expirationDate)
            : -1,
        httpOnly: cookie.httpOnly === true,
        secure: cookie.secure === true,
        sameSite: previewSameSite(cookie.sameSite),
      }));

      return {
        url: liveUrl,
        origin,
        cookies,
        localStorage: previewStorageEntries(storage?.localStorage),
        sessionStorage: previewStorageEntries(storage?.sessionStorage),
        capturedAt: Date.now(),
      };
    }
  );

  /**
   * Drives one test-case interaction into the live preview iframe.
   *
   * The frontend review runs against the browser the user is already looking
   * at — signed in, already loaded — so the review is fast and needs no
   * external Chromium. Localhost-only: the frame is resolved by the same
   * local-origin check the read-only handlers use, so this can never reach a
   * remote page.
   */
  ipcMain.handle(
    IPC_CHANNELS.previewAct,
    async (
      event,
      requestedUrl: unknown,
      step: DesktopPreviewActStep
    ): Promise<DesktopPreviewActResult | null> => {
      const frame = previewFrame(event.sender, requestedUrl);
      const origin = localPreviewOrigin(requestedUrl);
      if (!frame || !origin) return null;
      try {
        const result = (await frame.executeJavaScript(
          previewActScript(step, PREVIEW_WAIT_DEFAULT_MS)
        )) as DesktopPreviewActResult | null;
        if (!result || typeof result.ok !== "boolean") {
          return { ok: false, detail: "", error: "no result from the preview frame" };
        }
        return {
          ok: result.ok,
          detail: typeof result.detail === "string" ? result.detail : "",
          ...(result.error ? { error: String(result.error) } : {}),
        };
      } catch (error) {
        return {
          ok: false,
          detail: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, url: unknown) => {
    if (typeof url !== "string" || !isSafeExternal(url)) return;
    await shell.openExternal(url);
  });

  ipcMain.handle(
    IPC_CHANNELS.exportPdf,
    async (event, html: unknown, suggestedName: unknown) => {
      if (typeof html !== "string") return null;
      const parent = BrowserWindow.fromWebContents(event.sender);
      const name =
        typeof suggestedName === "string" && suggestedName ? suggestedName : "export";
      const options = {
        title: "Export PDF",
        defaultPath: `${name}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      };
      const target = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options);
      if (target.canceled || !target.filePath) return null;
      await writePdf(html, target.filePath);
      return target.filePath;
    }
  );

  ipcMain.on(IPC_CHANNELS.windowMinimize, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isKiosk()) return;
    win.minimize();
  });

  ipcMain.on(IPC_CHANNELS.windowMaximizeToggle, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isKiosk()) {
      win.setKiosk(false);
      sendKioskState(win);
      return;
    }
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on(IPC_CHANNELS.windowKioskToggle, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    win.setKiosk(!win.isKiosk());
    sendKioskState(win);
  });

  ipcMain.on(IPC_CHANNELS.windowClose, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle(IPC_CHANNELS.windowIsMaximized, (event) => {
    return (
      BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
    );
  });

  ipcMain.handle(IPC_CHANNELS.windowIsKiosk, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isKiosk() ?? false;
  });
}

/**
 * Prints an HTML document to a PDF file through an offscreen window.
 *
 * The window is hidden, sandboxed, and loaded from a data: URL with no
 * node integration: the HTML is rendered markdown, and rendering it in
 * the app's own window would give document content a foothold there.
 */
async function writePdf(html: string, filePath: string): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      javascript: false,
    },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
    });
    await writeFile(filePath, pdf);
  } finally {
    win.destroy();
  }
}

/** Forward maximize/kiosk changes to the renderer for the titlebar icons. */
export function wireMaximizedEvents(win: BrowserWindow): void {
  const send = (maximized: boolean): void => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.windowMaximizedChanged, maximized);
    }
  };
  win.on("maximize", () => send(true));
  win.on("unmaximize", () => send(false));
  win.on("enter-full-screen", () => sendKioskState(win));
  win.on("leave-full-screen", () => sendKioskState(win));
}

function sendKioskState(win: BrowserWindow): void {
  if (!win.isDestroyed()) {
    win.webContents.send(IPC_CHANNELS.windowKioskChanged, win.isKiosk());
  }
}

export { isSafeExternal };
