import {
  BrowserWindow,
  shell,
  webFrameMain,
  type WebFrameMain,
} from "electron";
import { isSafeExternal } from "./ipc";

function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

function isPreviewFrame(win: BrowserWindow, referrerUrl: string): boolean {
  if (!isLocal(referrerUrl)) return false;

  try {
    return (
      new URL(referrerUrl).origin !==
      new URL(win.webContents.getURL()).origin
    );
  } catch {
    return false;
  }
}

function browserUserAgent(userAgent: string): string {
  return userAgent.replace(/\sElectron\/\S+/g, "");
}

function findPreviewFrame(
  win: BrowserWindow,
  referrerUrl: string
): WebFrameMain | undefined {
  const frames = win.webContents.mainFrame.framesInSubtree.filter(
    (frame) => frame !== win.webContents.mainFrame
  );
  const matched = frames.find((frame) => {
    try {
      return (
        isPreviewFrame(win, frame.url) &&
        (frame.url === referrerUrl ||
          new URL(frame.url).origin === new URL(referrerUrl).origin)
      );
    } catch {
      return false;
    }
  });
  if (matched) return matched;

  // Chromium can omit the referrer on a newly-created window. A preview pane
  // normally has one local subframe, so retain popup completion in that case.
  const previewFrames = frames.filter((frame) =>
    isPreviewFrame(win, frame.url)
  );
  return previewFrames.length === 1 ? previewFrames[0] : undefined;
}

function syncAfterPreviewReturn(
  popup: BrowserWindow,
  previewFrame: WebFrameMain
): void {
  const previewOrigin = originOf(previewFrame.url);
  const previousAuthState = previewFrame
    .executeJavaScript(previewAuthStateScript())
    .catch(() => "[]");
  let hasLeftPreviewOrigin = false;
  let completionStarted = false;

  const recordExternalNavigation = (url: string): void => {
    try {
      const parsed = new URL(url);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.origin !== previewOrigin
      ) {
        hasLeftPreviewOrigin = true;
      }
    } catch {
      // Ignore transient or malformed navigation URLs.
    }
  };

  // did-create-window can arrive after the provider navigation has started.
  // Seed from the current URL and also watch navigation starts so a redirect
  // chain cannot return to the preview before we observe its provider page.
  recordExternalNavigation(popup.webContents.getURL());
  popup.webContents.on(
    "did-start-navigation",
    (_event, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) recordExternalNavigation(url);
    }
  );

  popup.webContents.on("did-finish-load", () => {
    if (popup.isDestroyed() || completionStarted) return;

    try {
      const currentOrigin = new URL(popup.webContents.getURL()).origin;
      if (currentOrigin !== previewOrigin) {
        recordExternalNavigation(popup.webContents.getURL());
        return;
      }

      if (hasLeftPreviewOrigin) {
        completionStarted = true;
        completePreviewOAuth(previewFrame, popup, previousAuthState);
      }
    } catch {
      // Ignore transient or malformed navigation URLs.
    }
  });
}

/**
 * Provider redirects from a preview must finish in a top-level window that uses
 * the same Electron session. The preview iframe stays mounted throughout, so
 * its UI and in-memory auth client are still alive when the callback stores
 * the new session.
 */
function previewAuthStateScript(): string {
  return `(() => {
    const entries = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key) {
          entries.push([
            storage === window.localStorage ? "local" : "session",
            key,
            storage.getItem(key),
          ]);
        }
      }
    }
    return JSON.stringify(entries.sort((left, right) =>
      (left[0] + left[1]).localeCompare(right[0] + right[1])
    ));
  })()`;
}

function previewSessionStateScript(): string {
  return `(() => {
    const entries = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key) entries.push([key, window.sessionStorage.getItem(key)]);
    }
    return JSON.stringify(entries);
  })()`;
}

function restoreSessionStateScript(state: string): string {
  return `(() => {
    const entries = JSON.parse(${JSON.stringify(state)});
    for (const [key, value] of entries) {
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    }
  })()`;
}

/**
 * Chromium codes that mean nothing answered at all, as opposed to a page that
 * loaded and then went wrong. A preview calling a backend nobody has started
 * yet lands here, and that is the case worth explaining in words.
 */
const UNREACHABLE_ERROR_CODES = new Set([
  -7, // ERR_TIMED_OUT
  -15, // ERR_SOCKET_NOT_CONNECTED
  -21, // ERR_NETWORK_CHANGED
  -102, // ERR_CONNECTION_REFUSED
  -104, // ERR_CONNECTION_FAILED
  -105, // ERR_NAME_NOT_RESOLVED
  -106, // ERR_INTERNET_DISCONNECTED
  -109, // ERR_ADDRESS_UNREACHABLE
  -118, // ERR_CONNECTION_TIMED_OUT
  -324, // ERR_EMPTY_RESPONSE
]);

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Why the load failed, in the words the person running the preview needs. */
function loadFailureHint(failedUrl: string, errorCode: number): string {
  if (!UNREACHABLE_ERROR_CODES.has(errorCode)) {
    return "The preview could not open this address.";
  }
  if (isLocal(failedUrl)) {
    return (
      `Nothing is listening on ${originOf(failedUrl)}. That server belongs ` +
      `to the previewed project — sign-in and other API calls cannot work ` +
      `until it is running. Start it, then try again.`
    );
  }
  return `${originOf(failedUrl)} did not respond.`;
}

/** A JS string literal that cannot close the inline <script> it sits in. */
function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The failure document, shared by the OAuth popup and the preview frame. */
function loadErrorHtml(
  failedUrl: string,
  errorDescription: string,
  errorCode: number
): string {
  const title = "Unable to open this page";
  const detail = errorDescription || "Navigation failed";
  const hint = loadFailureHint(failedUrl, errorCode);
  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="color-scheme" content="light dark" />
        <title>${title}</title>
        <style>
          html, body {
            width: 100%;
            height: 100%;
            margin: 0;
          }
          body {
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            padding: 32px;
            background: Canvas;
            color: CanvasText;
            font: 14px system-ui, sans-serif;
          }
          main {
            display: flex;
            width: min(100%, 440px);
            flex-direction: column;
            gap: 12px;
          }
          h1 {
            margin: 0;
            font-size: 18px;
          }
          p {
            margin: 0;
            color: GrayText;
            line-height: 1.5;
          }
          code {
            overflow-wrap: anywhere;
            border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
            border-radius: 8px;
            padding: 10px;
            background: color-mix(in srgb, CanvasText 6%, Canvas);
            font: 12px ui-monospace, SFMono-Regular, Consolas, monospace;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>${title}</h1>
          <p id="hint"></p>
          <code id="error"></code>
          <code id="url"></code>
        </main>
        <script>
          document.getElementById("hint").textContent = ${jsLiteral(hint)};
          document.getElementById("error").textContent =
            ${jsLiteral(errorCode ? `${detail} (${errorCode})` : detail)};
          document.getElementById("url").textContent = ${jsLiteral(failedUrl)};
        </script>
      </body>
    </html>
  `;
}

const previewPopupsShowingError = new WeakSet<BrowserWindow>();

/** Replace a failed popup navigation with the shared error document. */
function showPreviewPopupError(
  popup: BrowserWindow,
  failedUrl: string,
  errorDescription: string,
  errorCode: number
): void {
  if (popup.isDestroyed() || previewPopupsShowingError.has(popup)) return;
  previewPopupsShowingError.add(popup);

  const html = loadErrorHtml(failedUrl, errorDescription, errorCode);

  // did-fail-load runs inside Chromium's failed-navigation dispatch. Starting
  // another navigation synchronously from that callback aborts the pending
  // loadURL promise, whose catch used to start this same error page again.
  // Leave the native callback first, then perform exactly one replacement.
  setImmediate(() => {
    if (popup.isDestroyed()) return;

    void popup
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .then(() => {
        if (!popup.isDestroyed()) popup.show();
      })
      .catch((error: unknown) => {
        console.error("[preview] Failed to display popup error", error);
      });
  });
}

/**
 * A preview iframe that navigates to a local server which is not running —
 * its own backend, before anyone started it — is left blank, because Electron
 * ships no network error page. Rewrite the document in place: a data: URL
 * navigation would drop the frame's origin, and the preview pane addresses
 * its frame by origin.
 */
function showPreviewFrameError(
  frame: WebFrameMain,
  failedUrl: string,
  errorDescription: string,
  errorCode: number
): void {
  const html = loadErrorHtml(failedUrl, errorDescription, errorCode);
  const script = `(() => {
    document.open();
    document.write(${jsLiteral(html)});
    document.close();
  })()`;
  const failed = (error: unknown): void => {
    console.error("[preview] Failed to display frame error", error);
  };

  try {
    void frame.executeJavaScript(script).catch(failed);
  } catch (error) {
    failed(error);
  }
}

function attachPreviewPopupErrorHandling(popup: BrowserWindow): void {
  popup.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      // ERR_ABORTED is emitted for ordinary redirects and superseded loads.
      if (!isMainFrame || errorCode === -3 || popup.isDestroyed()) return;

      console.error(
        `[preview] Popup failed to load ${validatedUrl}: ${errorDescription} (${errorCode})`
      );
      showPreviewPopupError(
        popup,
        validatedUrl,
        errorDescription,
        errorCode
      );
    }
  );
}

function showPreviewOAuthLoadingScript(): string {
  const html = `
    <head>
      <meta name="color-scheme" content="light dark" />
      <style>
        html, body {
          width: 100%;
          height: 100%;
          margin: 0;
        }
        body {
          display: flex;
          align-items: center;
          justify-content: center;
          background: Canvas;
          color: CanvasText;
          font: 14px system-ui, sans-serif;
        }
      </style>
    </head>
    <body>Opening provider sign-in…</body>
  `;

  return `(() => {
    document.title = "Opening provider sign-in…";
    document.documentElement.innerHTML = ${JSON.stringify(html)};
  })()`;
}

function applyPreviewAuthStateScript(state: string): string {
  return `(() => {
    const entries = JSON.parse(${JSON.stringify(state)});
    for (const [kind, key, value] of entries) {
      const storage =
        kind === "local" ? window.localStorage : window.sessionStorage;
      const oldValue = storage.getItem(key);
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
      window.dispatchEvent(new StorageEvent("storage", {
        key,
        oldValue,
        newValue: value,
        url: window.location.href,
      }));
    }
    window.dispatchEvent(new Event("atelier:oauth-complete"));
    window.location.reload();
  })()`;
}

function completePreviewOAuth(
  previewFrame: WebFrameMain,
  popup: BrowserWindow,
  previousAuthState: Promise<unknown>
): void {
  // Callback pages often exchange the authorization code after their load
  // event. Wait for storage to actually change before closing the popup:
  // accepting unchanged state after a short delay can interrupt that exchange
  // and leave the preview authenticated only until its next refresh. Cookies
  // are already shared by the Electron session, while changed local/session
  // storage is copied back to the preview.
  const deadline = Date.now() + 30_000;

  const finish = (state: string): void => {
    void previewFrame
      .executeJavaScript(applyPreviewAuthStateScript(state))
      .catch((error: unknown) => {
        console.error("[preview] Failed to sync OAuth session", error);
      })
      .finally(() => {
        if (!popup.isDestroyed()) popup.close();
      });
  };

  const pollForSession = (): void => {
    if (popup.isDestroyed()) return;

    void Promise.all([
      previousAuthState,
      popup.webContents.executeJavaScript(previewAuthStateScript()),
    ])
      .then(([before, popupState]) => {
        if (
          typeof popupState === "string" &&
          popupState !== before
        ) {
          finish(popupState);
          return;
        }

        if (Date.now() >= deadline) {
          finish(typeof popupState === "string" ? popupState : "[]");
          return;
        }

        setTimeout(pollForSession, 250);
      })
      .catch(() => {
        if (Date.now() >= deadline) {
          // Cookie-backed providers still succeed without readable storage.
          finish("[]");
          return;
        }
        setTimeout(pollForSession, 250);
      });
  };

  pollForSession();
}

const activePreviewOAuthFrames = new WeakSet<WebFrameMain>();

function openRedirectedPreviewOAuth(
  win: BrowserWindow,
  previewFrame: WebFrameMain,
  url: string
): void {
  if (activePreviewOAuthFrames.has(previewFrame)) return;
  activePreviewOAuthFrames.add(previewFrame);

  const previewUrl = previewFrame.url;
  const previewOrigin = new URL(previewUrl).origin;
  const previousAuthState = previewFrame
    .executeJavaScript(previewAuthStateScript())
    .catch(() => "[]");
  const previewSessionState = previewFrame
    .executeJavaScript(previewSessionStateScript())
    .catch(() => "[]");
  const popup = new BrowserWindow({
    parent: win,
    show: false,
    width: 520,
    height: 720,
    autoHideMenuBar: true,
    webPreferences: {
      session: win.webContents.session,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  let oauthStarted = false;
  let callbackReached = false;
  let pollingStarted = false;
  let completionFallback: ReturnType<typeof setInterval> | undefined;

  const completeIfReturned = (): void => {
    if (pollingStarted || popup.isDestroyed()) return;

    try {
      if (new URL(popup.webContents.getURL()).origin !== previewOrigin) return;
    } catch {
      return;
    }

    pollingStarted = true;
    if (completionFallback) {
      clearInterval(completionFallback);
      completionFallback = undefined;
    }
    completePreviewOAuth(previewFrame, popup, previousAuthState);
  };

  popup.on("closed", () => {
    if (completionFallback) clearInterval(completionFallback);
    activePreviewOAuthFrames.delete(previewFrame);
  });
  attachPreviewPopupErrorHandling(popup);
  popup.webContents.setUserAgent(
    browserUserAgent(win.webContents.getUserAgent())
  );
  popup.webContents.on(
    "did-start-navigation",
    (_event, targetUrl, _isInPlace, isMainFrame) => {
      if (!isMainFrame || !oauthStarted || popup.isDestroyed()) return;

      try {
        if (new URL(targetUrl).origin === previewOrigin) {
          callbackReached = true;
        }
      } catch {
        // Ignore transient or malformed navigation URLs.
      }
    }
  );
  popup.webContents.on("did-finish-load", () => {
    if (!callbackReached) return;
    completeIfReturned();
  });

  void previewSessionState
    .then(async (sessionState) => {
      await popup.loadURL(previewUrl);
      if (popup.isDestroyed()) return;

      if (typeof sessionState === "string") {
        await popup.webContents.executeJavaScript(
          restoreSessionStateScript(sessionState)
        );
      }
      if (popup.isDestroyed()) return;

      await popup.webContents.executeJavaScript(
        showPreviewOAuthLoadingScript()
      );
      if (popup.isDestroyed()) return;

      oauthStarted = true;
      const oauthLoad = popup.loadURL(url);
      popup.show();
      await oauthLoad;
      if (popup.isDestroyed() || pollingStarted) return;

      // Fallback for providers whose successful callback navigation does not
      // emit the expected Electron navigation event. Once the provider page
      // has loaded, poll until the popup returns to the preview origin.
      completionFallback = setInterval(completeIfReturned, 250);
      completeIfReturned();
    })
    .catch((error: unknown) => {
      // did-fail-load owns network failures. Once it has scheduled the error
      // page, the original loadURL rejection is expected and must not start a
      // second replacement navigation.
      if (popup.isDestroyed() || previewPopupsShowingError.has(popup)) return;

      console.error("[preview] Failed to open OAuth window", error);

      const message =
        error instanceof Error ? error.message : String(error);
      showPreviewPopupError(popup, url, message, 0);
    });
}

/**
 * Shell links still open in the system browser. Popups requested by a
 * localhost preview iframe are different: OAuth libraries need the window
 * returned by window.open(), so let Electron create a sandboxed in-app window
 * for those requests instead of opening externally and reporting it blocked.
 * OAuth SDKs that redirect the preview iframe are promoted to a managed
 * top-level window and return their callback to the originating frame, so the
 * preview receives the session instead of an isolated external browser.
 */
export function attachExternalLinkHandling(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url, referrer }) => {
    if (findPreviewFrame(win, referrer.url)) {
      // Providers can reject Electron's embedded-runtime user-agent even though this
      // is a normal top-level BrowserWindow. Set the shared session before the
      // child is created so its very first OAuth request looks like Chromium.
      win.webContents.session.setUserAgent(
        browserUserAgent(win.webContents.getUserAgent())
      );

      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }

    if (isSafeExternal(url) && !isLocal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-frame-navigate", (event) => {
    const frame = event.frame;
    const frameUrl = frame?.url;
    if (
      event.isMainFrame ||
      !frame ||
      !frameUrl ||
      !isPreviewFrame(win, frameUrl) ||
      originOf(event.url) === originOf(frameUrl) ||
      !isSafeExternal(event.url)
    ) {
      return;
    }

    event.preventDefault();
    openRedirectedPreviewOAuth(win, frame, event.url);
  });

  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const frame = details.frame;
      const frameUrl = frame?.url;
      if (
        details.webContentsId !== win.webContents.id ||
        details.resourceType !== "subFrame" ||
        !frame ||
        !frameUrl ||
        !isPreviewFrame(win, frameUrl) ||
        originOf(details.url) === originOf(frameUrl) ||
        !isSafeExternal(details.url)
      ) {
        callback({});
        return;
      }

      // Server-side redirects may bypass will-frame-navigate. Promote any
      // cross-origin preview navigation, including a localhost auth backend,
      // before the iframe can turn into the provider page.
      openRedirectedPreviewOAuth(win, frame, details.url);
      callback({ cancel: true });
    }
  );

  // Every child window gets the error page. window.open referrers are stripped
  // often enough that gating this on the preview check is how a popup whose
  // very first navigation fails ends up showing nothing at all.
  win.webContents.on("did-create-window", (popup, details) => {
    attachPreviewPopupErrorHandling(popup);

    const previewFrame = findPreviewFrame(win, details.referrer.url);
    if (!previewFrame) return;

    popup.webContents.setUserAgent(
      browserUserAgent(win.webContents.getUserAgent())
    );
    syncAfterPreviewReturn(popup, previewFrame);
  });

  win.webContents.on(
    "did-fail-load",
    (
      _event,
      errorCode,
      errorDescription,
      validatedUrl,
      isMainFrame,
      frameProcessId,
      frameRoutingId
    ) => {
      // ERR_ABORTED is emitted for ordinary redirects and superseded loads.
      // Only local subframes are handled here: a non-local navigation was
      // already promoted to a popup, and the app's own main frame reports its
      // failures through the renderer diagnostics.
      if (isMainFrame || errorCode === -3 || !isLocal(validatedUrl)) return;

      const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (!frame) return;

      console.error(
        `[preview] Frame failed to load ${validatedUrl}: ${errorDescription} (${errorCode})`
      );
      showPreviewFrameError(frame, validatedUrl, errorDescription, errorCode);
    }
  );

  win.webContents.on("will-navigate", (event, url) => {
    if (isLocal(url)) return;
    event.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  });
}
