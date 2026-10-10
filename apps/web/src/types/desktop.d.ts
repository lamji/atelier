// Mirrors AtelierDesktopApi in apps/desktop/src/shared/ipc-contract.ts.
// Kept as a local declaration so @atelier/web has no dependency on the
// desktop package; the preload bridge is the runtime source of truth.
export {};

declare global {
  type AtelierProjectRunState = "stopped" | "starting" | "running" | "error";

  interface AtelierProjectInfo {
    id: string;
    name: string;
    path: string;
    status: AtelierProjectRunState;
    working: boolean;
    lastOpenedAt?: number;
    error?: string;
  }

  interface AtelierDesktopAuthApi {
    /** Starts Electron's loopback listener and returns its OAuth redirect URL. */
    callbackUrl(): Promise<string>;
    /** Receives the Supabase callback after browser-based desktop login. */
    onCallback(cb: (url: string) => void): () => void;
  }

  interface AtelierDesktopProjectsApi {
    list(): Promise<AtelierProjectInfo[]>;
    add(path: string): Promise<AtelierProjectInfo>;
    start(id: string): Promise<void>;
    stop(id: string): Promise<void>;
    remove(id: string): Promise<void>;
    onChanged(cb: (projects: AtelierProjectInfo[]) => void): () => void;
    attach(id: string): Promise<{ attachId: string }>;
  }

  interface AtelierDesktopWindowApi {
    minimize(): void;
    maximizeToggle(): void;
    kioskToggle(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    isKiosk(): Promise<boolean>;
    onMaximizedChanged(cb: (maximized: boolean) => void): () => void;
    onKioskChanged(cb: (kiosk: boolean) => void): () => void;
  }

  interface AtelierDesktopCaptureRect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface AtelierDesktopCaptureRequest extends AtelierDesktopCaptureRect {
    previewUrl?: string;
  }

  interface AtelierDesktopCaptureResult {
    dataUrl: string;
    frameUrl: string | null;
  }

  type AtelierDesktopPreviewActStep =
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

  interface AtelierDesktopPreviewActResult {
    ok: boolean;
    detail: string;
    error?: string;
  }

  interface AtelierDesktopPreviewConsoleEntry {
    level: "warning" | "error";
    message: string;
    source: string | null;
    line: number | null;
    timestamp: number;
  }

  interface AtelierDesktopPreviewInteractiveElement {
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

  interface AtelierDesktopPreviewFocusRect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface AtelierDesktopPreviewFocusedElement {
    /** 1-based index of the highlight rect the element sits under. */
    region: number;
    selector: string;
    tag: string;
    text: string;
    ariaLabel: string | null;
    rect: AtelierDesktopPreviewFocusRect;
  }

  interface AtelierDesktopPreviewActiveElement {
    selector: string;
    tag: string;
    text: string;
  }

  interface AtelierDesktopPreviewContextResult {
    url: string;
    title: string;
    html: string;
    css: string;
    interactive: AtelierDesktopPreviewInteractiveElement[];
    console: AtelierDesktopPreviewConsoleEntry[];
    capturedAt: number;
    /** Elements under the requested focus rects; absent when none were asked for. */
    focused?: AtelierDesktopPreviewFocusedElement[];
    /** Null when focus sits on body/html, i.e. nothing is really focused. */
    activeElement?: AtelierDesktopPreviewActiveElement | null;
    /** window.getSelection() of the preview document, <= 300 chars. */
    selectionText?: string;
    /** document.body.innerText, whitespace-collapsed, <= 4000 chars. */
    visibleText?: string;
  }

  interface AtelierDesktopPreviewSessionCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }

  interface AtelierDesktopPreviewStorageEntry {
    name: string;
    value: string;
  }

  /** Credential material — never render it, log it, or put it in a prompt. */
  interface AtelierDesktopPreviewSessionResult {
    url: string;
    origin: string;
    cookies: AtelierDesktopPreviewSessionCookie[];
    localStorage: AtelierDesktopPreviewStorageEntry[];
    sessionStorage: AtelierDesktopPreviewStorageEntry[];
    capturedAt: number;
  }

  interface AtelierDesktopUpdateStatus {
    current: string;
    latest: string | null;
    available: boolean;
    url: string | null;
    downloadUrl: string | null;
    notes: string | null;
    error?: string;
  }

  interface AtelierDesktopChangelogEntry {
    version: string;
    notes: string | null;
    url: string | null;
  }

  interface AtelierDesktopUpdateProgress {
    phase: "downloading" | "verifying" | "launching" | "error";
    percent: number | null;
    receivedBytes?: number;
    totalBytes?: number;
    message?: string;
  }

  interface AtelierDesktopUpdatesApi {
    check(force?: boolean): Promise<AtelierDesktopUpdateStatus>;
    download(): Promise<void>;
    install(): Promise<void>;
    onProgress(
      cb: (progress: AtelierDesktopUpdateProgress) => void
    ): () => void;
    changelog(): Promise<AtelierDesktopChangelogEntry | null>;
    acknowledge(version: string): Promise<void>;
  }

  interface AtelierDesktopApi {
    platform: "win32" | "darwin" | "linux";
    version: string;
    auth: AtelierDesktopAuthApi;
    projects: AtelierDesktopProjectsApi;
    updates: AtelierDesktopUpdatesApi;
    pickFolder(): Promise<string | null>;
    /** Captures a renderer-relative rectangle and its live preview route. */
    captureRegion(
      request: AtelierDesktopCaptureRequest
    ): Promise<AtelierDesktopCaptureResult | null>;
    /** Reads runtime evidence from the exact iframe displayed in Page preview. */
    getPreviewContext(
      previewUrl: string,
      options?: { focus?: AtelierDesktopPreviewFocusRect[] }
    ): Promise<AtelierDesktopPreviewContextResult | null>;
    /** Reads cookies + web storage of the signed-in preview iframe. */
    getPreviewSession(
      previewUrl: string
    ): Promise<AtelierDesktopPreviewSessionResult | null>;
    /** Drives one test-case interaction into the live preview iframe. */
    previewAct(
      previewUrl: string,
      step: AtelierDesktopPreviewActStep
    ): Promise<AtelierDesktopPreviewActResult | null>;
    /** Filesystem path of a dropped File (null if unavailable). */
    pathForFile(file: File): string | null;
    openExternal(url: string): Promise<void>;
    /** Renders HTML to PDF and prompts for a save location. */
    exportPdf(html: string, suggestedName: string): Promise<string | null>;
    window: AtelierDesktopWindowApi;
  }

  interface Window {
    atelierDesktop?: AtelierDesktopApi;
  }
}
