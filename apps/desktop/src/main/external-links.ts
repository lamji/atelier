import { BrowserWindow, shell, type WebFrameMain } from "electron";
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

function closeAfterPreviewReturn(
  popup: BrowserWindow,
  previewOrigin: string
): void {
  let hasLeftPreviewOrigin = false;

  popup.webContents.on("did-finish-load", () => {
    if (popup.isDestroyed()) return;

    try {
      const currentOrigin = new URL(popup.webContents.getURL()).origin;
      if (currentOrigin !== previewOrigin) {
        hasLeftPreviewOrigin = true;
        return;
      }

      if (hasLeftPreviewOrigin) popup.close();
    } catch {
      // Ignore transient or malformed navigation URLs.
    }
  });
}

/**
 * OAuth redirects from a preview must finish in a top-level window that uses
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
        if (key?.startsWith("sb-") && key.endsWith("-auth-token")) {
          entries.push([
            storage === window.localStorage ? "local" : "session",
            key,
            storage.getItem(key),
          ]);
        }
      }
    }
    return JSON.stringify(entries.sort((left, right) =>
      left[1].localeCompare(right[1])
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
    <body>Opening Google sign-in…</body>
  `;

  return `(() => {
    document.title = "Opening Google sign-in…";
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
    window.location.reload();
  })()`;
}

function completePreviewOAuth(
  previewFrame: WebFrameMain,
  popup: BrowserWindow,
  previousAuthState: Promise<unknown>
): void {
  const deadline = Date.now() + 30_000;

  const closePopup = (): void => {
    if (!popup.isDestroyed()) popup.close();
  };

  const pollForSession = (): void => {
    if (popup.isDestroyed()) return;

    void Promise.all([
      previousAuthState,
      previewFrame.executeJavaScript(previewAuthStateScript()),
      popup.webContents.executeJavaScript(previewAuthStateScript()),
    ])
      .then(([before, previewState, popupState]) => {
        const changedState = [popupState, previewState].find(
          (state) =>
            typeof state === "string" &&
            state !== "[]" &&
            state !== before
        );

        if (typeof changedState === "string") {
          void previewFrame
            .executeJavaScript(applyPreviewAuthStateScript(changedState))
            .catch((error: unknown) => {
              console.error("[preview] Failed to sync OAuth session", error);
            })
            .finally(closePopup);
          return;
        }

        if (Date.now() >= deadline) {
          console.error("[preview] Timed out waiting for OAuth session");
          closePopup();
          return;
        }

        setTimeout(pollForSession, 250);
      })
      .catch(() => {
        if (Date.now() >= deadline) {
          closePopup();
          return;
        }
        setTimeout(pollForSession, 250);
      });
  };

  pollForSession();
}

function openRedirectedPreviewOAuth(
  win: BrowserWindow,
  previewFrame: WebFrameMain,
  url: string
): void {
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
    if (!callbackReached || pollingStarted || popup.isDestroyed()) return;

    try {
      if (new URL(popup.webContents.getURL()).origin !== previewOrigin) return;
    } catch {
      return;
    }

    pollingStarted = true;
    completePreviewOAuth(previewFrame, popup, previousAuthState);
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
    })
    .catch((error: unknown) => {
      console.error("[preview] Failed to open OAuth window", error);
      if (!popup.isDestroyed()) popup.close();
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
    if (isPreviewFrame(win, referrer.url)) {
      // Google rejects Electron's embedded-runtime user-agent even though this
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
      isLocal(event.url) ||
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
        isLocal(details.url) ||
        !isSafeExternal(details.url)
      ) {
        callback({});
        return;
      }

      // Server-side redirects may bypass will-frame-navigate. Keep this
      // request-level redirect as a fallback while preserving the local frame.
      openRedirectedPreviewOAuth(win, frame, details.url);
      callback({ redirectURL: frameUrl });
    }
  );

  win.webContents.on("did-create-window", (popup, details) => {
    if (!isPreviewFrame(win, details.referrer.url)) return;
    closeAfterPreviewReturn(
      popup,
      new URL(details.referrer.url).origin
    );
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isLocal(url)) return;
    event.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  });
}
