/**
 * atelier:// deep-link plumbing. Three delivery paths, all funneled into
 * auth.handleDeepLink:
 *  - Windows/Linux, app already running: OS launches a second instance with
 *    the URL in argv; the `second-instance` event carries it here.
 *  - Windows/Linux, cold start: the URL is in this process's argv.
 *  - macOS: the `open-url` event, both warm and cold.
 */
import path from "node:path";
import { app } from "electron";
import { AUTH_PROTOCOL } from "./auth-config";
import { handleDeepLink } from "./auth";

const SCHEME_PREFIX = `${AUTH_PROTOCOL}://`;

/** First deep-link URL in an argv, if any. */
export function deepLinkInArgv(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(SCHEME_PREFIX)) ?? null;
}

/**
 * Register atelier:// with the OS. Must run before app.whenReady. In dev
 * (`process.defaultApp`, i.e. electron.exe dist/main.cjs) the registration
 * must name the entry script, or the OS would launch a bare Electron.
 */
export function registerProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(AUTH_PROTOCOL, process.execPath, [
        path.resolve(process.argv[1]!),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(AUTH_PROTOCOL);
  }
}

/** Hook warm-app deliveries (macOS open-url; second-instance is wired by
 *  the caller, which also owns window focus). */
export function wireOpenUrl(): void {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (url.startsWith(SCHEME_PREFIX)) void handleDeepLink(url);
  });
}

/** Deliver a cold-start deep link (call once from whenReady). */
export function handleColdStartDeepLink(): void {
  const url = deepLinkInArgv(process.argv);
  if (url) void handleDeepLink(url);
}
