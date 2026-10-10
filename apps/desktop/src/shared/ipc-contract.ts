/**
 * Single source of truth for the renderer <-> main IPC surface.
 *
 * The app is fully native now: auth, the project registry and agent
 * lifecycle live in the main process; per-project RPC rides a transferred
 * MessagePort (see `workspacePort` below), not a socket.
 */

export const IPC_CHANNELS = {
  // projects
  projectsList: "atelier:projects:list",
  projectsAdd: "atelier:projects:add",
  projectsStart: "atelier:projects:start",
  projectsStop: "atelier:projects:stop",
  projectsRemove: "atelier:projects:remove",
  projectsChanged: "atelier:projects:changed",
  projectsAttach: "atelier:projects:attach",
  /** main -> preload; carries the MessagePort for an attach() call. */
  workspacePort: "atelier:workspace-port",
  /** renderer -> main; resolves the loopback URL used for desktop OAuth. */
  oauthCallbackUrl: "atelier:auth:callback-url",
  /** main -> preload; carries a validated Supabase OAuth callback. */
  oauthCallback: "atelier:auth:callback",
  // desktop chrome
  pickFolder: "atelier:pick-folder",
  captureRegion: "atelier:capture-region",
  previewContext: "atelier:preview-context",
  /** renderer -> main; reads the signed-in session behind the preview iframe. */
  previewSession: "atelier:preview-session",
  /** renderer -> main; drives one interaction into the live preview iframe. */
  previewAct: "atelier:preview-act",
  openExternal: "atelier:open-external",
  exportPdf: "atelier:export-pdf",
  windowMinimize: "atelier:window:minimize",
  windowMaximizeToggle: "atelier:window:maximize-toggle",
  windowKioskToggle: "atelier:window:kiosk-toggle",
  windowClose: "atelier:window:close",
  windowIsMaximized: "atelier:window:is-maximized",
  windowIsKiosk: "atelier:window:is-kiosk",
  // updates
  updatesCheck: "atelier:updates:check",
  updatesDownload: "atelier:updates:download",
  /** Download + verify + launch the installer, without leaving the app. */
  updatesInstall: "atelier:updates:install",
  /** main -> renderer, while that runs. */
  updatesProgress: "atelier:updates:progress",
  updatesChangelog: "atelier:updates:changelog",
  updatesAcknowledge: "atelier:updates:acknowledge",
  windowMaximizedChanged: "atelier:window:maximized-changed",
  windowKioskChanged: "atelier:window:kiosk-changed",
} as const;

/** window.postMessage type used by preload to hand a MessagePort to the
 *  main world (ports cannot cross contextBridge). */
export const PORT_MESSAGE_TYPE = "atelier-workspace-port";

export type ProjectRunState = "stopped" | "starting" | "running" | "error";

export interface DesktopProjectInfo {
  id: string;
  name: string;
  path: string;
  status: ProjectRunState;
  working: boolean;
  lastOpenedAt?: number;
  error?: string;
}

export interface DesktopAuthApi {
  /** Starts the loopback listener and returns its Supabase redirect URL. */
  callbackUrl(): Promise<string>;
  /** Receives a validated OAuth callback after browser sign-in. */
  onCallback(cb: (url: string) => void): () => void;
}

export interface DesktopProjectsApi {
  list(): Promise<DesktopProjectInfo[]>;
  add(path: string): Promise<DesktopProjectInfo>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  onChanged(cb: (projects: DesktopProjectInfo[]) => void): () => void;
  /**
   * Ask main for an RPC port to a project's agent (starting it if needed).
   * Resolves when the port has been posted to the main world via a
   * `window.postMessage({type: PORT_MESSAGE_TYPE, attachId}, ports)` — the
   * renderer pairs it up by attachId (see services/desktop-port.ts).
   */
  attach(id: string): Promise<{ attachId: string }>;
}

export interface DesktopWindowApi {
  minimize(): void;
  maximizeToggle(): void;
  kioskToggle(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  isKiosk(): Promise<boolean>;
  onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
  onKioskChanged(cb: (kiosk: boolean) => void): () => void;
}

export interface DesktopCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopCaptureRequest extends DesktopCaptureRect {
  /** Preview URL used to identify the navigated iframe in Electron. */
  previewUrl?: string;
}

export interface DesktopCaptureResult {
  dataUrl: string;
  /** Live iframe URL, including client-side route, when Electron can resolve it. */
  frameUrl: string | null;
}

/**
 * One interaction driven into the live preview iframe by the frontend-review
 * test runner. Screenshots are NOT here — the renderer captures those through
 * the existing region-capture path; everything that touches the DOM runs in
 * the frame from the privileged main process, which can reach across the
 * preview's origin boundary.
 */
export type DesktopPreviewActStep =
  | { action: "navigate"; target: string }
  | { action: "click"; selector?: string; text?: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "press"; key: string; selector?: string }
  | {
      action: "waitFor";
      selector?: string;
      text?: string;
      state?: "visible" | "hidden";
      timeoutMs?: number;
    }
  | {
      action: "assert";
      description: string;
      selector?: string;
      text?: string;
      notText?: string;
      visible?: boolean;
      absent?: boolean;
    };

export interface DesktopPreviewActResult {
  ok: boolean;
  detail: string;
  error?: string;
}

export interface DesktopPreviewConsoleEntry {
  level: "warning" | "error";
  message: string;
  source: string | null;
  line: number | null;
  timestamp: number;
}

export interface DesktopPreviewInteractiveElement {
  selector: string;
  tag: string;
  text: string;
  ariaLabel: string | null;
  role: string | null;
  rect: { x: number; y: number; width: number; height: number };
  style: {
    color: string;
    backgroundColor: string;
    borderColor: string;
    font: string;
    display: string;
    visibility: string;
  };
}

/**
 * A region of the preview the user highlighted on a screenshot, in the
 * iframe's own CSS pixels (viewport coordinates, the same space
 * getBoundingClientRect reports). The renderer maps the normalized
 * screenshot highlights into this space before asking.
 */
export interface DesktopPreviewFocusRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopPreviewContextOptions {
  /** Highlighted regions; each gets its own pass over the DOM. */
  focus?: DesktopPreviewFocusRect[];
}

/** An element found under one highlighted region. */
export interface DesktopPreviewFocusedElement {
  /** 1-based index of the focus rect this element was found under. */
  region: number;
  selector: string;
  tag: string;
  /** Visible text (innerText, or an input's value/placeholder), <= 200 chars. */
  text: string;
  ariaLabel: string | null;
  rect: { x: number; y: number; width: number; height: number };
}

/** document.activeElement of the preview, when it is a real element. */
export interface DesktopPreviewActiveElement {
  selector: string;
  tag: string;
  text: string;
}

/** Live runtime evidence from the exact iframe currently shown in Page preview. */
export interface DesktopPreviewContextResult {
  url: string;
  title: string;
  html: string;
  css: string;
  interactive: DesktopPreviewInteractiveElement[];
  console: DesktopPreviewConsoleEntry[];
  capturedAt: number;
  /** Elements under the requested focus rects; absent when none were asked for. */
  focused?: DesktopPreviewFocusedElement[];
  /** Null when focus sits on body/html, i.e. nothing is really focused. */
  activeElement?: DesktopPreviewActiveElement | null;
  /** window.getSelection() of the preview document, <= 300 chars. */
  selectionText?: string;
  /** document.body.innerText, whitespace-collapsed, <= 4000 chars. */
  visibleText?: string;
}

/** One cookie of the preview origin, already shaped for Playwright. */
export interface DesktopPreviewSessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds; -1 for a session cookie, matching Playwright. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface DesktopPreviewStorageEntry {
  name: string;
  value: string;
}

/**
 * The authenticated browser state sitting behind Page preview.
 *
 * This is credential material: it is handed straight to the review browser
 * and must never be written to a transcript, a log or a prompt.
 */
export interface DesktopPreviewSessionResult {
  /** Live frame URL, including the client-side route. */
  url: string;
  origin: string;
  cookies: DesktopPreviewSessionCookie[];
  localStorage: DesktopPreviewStorageEntry[];
  sessionStorage: DesktopPreviewStorageEntry[];
  capturedAt: number;
}

/** What a release check found. */
export interface DesktopUpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  url: string | null;
  downloadUrl: string | null;
  notes: string | null;
  error?: string;
}

/** Release notes shown once, on the first launch after an upgrade. */
export interface DesktopChangelogEntry {
  version: string;
  notes: string | null;
  url: string | null;
}

/** Progress of an in-app update. */
export interface DesktopUpdateProgress {
  phase: "downloading" | "verifying" | "launching" | "error";
  percent: number | null;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface DesktopUpdatesApi {
  /** `force` skips the cache — for a Check now button. */
  check(force?: boolean): Promise<DesktopUpdateStatus>;
  /** Opens the installer download (or the release page) in the browser. */
  download(): Promise<void>;
  /** Downloads and runs the installer in place; the app quits to let it. */
  install(): Promise<void>;
  /** Progress for install(); returns an unsubscribe. */
  onProgress(cb: (progress: DesktopUpdateProgress) => void): () => void;
  /** The changelog to show once, or null when there is nothing new. */
  changelog(): Promise<DesktopChangelogEntry | null>;
  acknowledge(version: string): Promise<void>;
}

export interface AtelierDesktopApi {
  platform: "win32" | "darwin" | "linux";
  version: string;
  auth: DesktopAuthApi;
  projects: DesktopProjectsApi;
  updates: DesktopUpdatesApi;
  /** Native directory picker; resolves null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** Captures a renderer-relative rectangle and its live preview route. */
  captureRegion(request: DesktopCaptureRequest): Promise<DesktopCaptureResult | null>;
  /**
   * Reads the DOM, authored CSS and diagnostics from the displayed preview
   * iframe. `options.focus` adds a pass that names the elements under the
   * user's screenshot highlights; the one-argument call still works.
   */
  getPreviewContext(
    previewUrl: string,
    options?: DesktopPreviewContextOptions
  ): Promise<DesktopPreviewContextResult | null>;
  /** Reads cookies + web storage of the signed-in preview iframe. */
  getPreviewSession(previewUrl: string): Promise<DesktopPreviewSessionResult | null>;
  /** Drives one test-case interaction into the live preview iframe. */
  previewAct(
    previewUrl: string,
    step: DesktopPreviewActStep
  ): Promise<DesktopPreviewActResult | null>;
  /** Filesystem path of a dropped File (null if unavailable). */
  pathForFile(file: File): string | null;
  openExternal(url: string): Promise<void>;
  /**
   * Renders a self-contained HTML document to PDF and asks where to save
   * it. Resolves the saved path, or null when the user cancels.
   */
  exportPdf(html: string, suggestedName: string): Promise<string | null>;
  window: DesktopWindowApi;
}
