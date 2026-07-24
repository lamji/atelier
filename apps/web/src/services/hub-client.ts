import { BridgeClient } from "./bridge-client.js";

declare const __ATELIER_HUB_PORT__: string;
declare const __ATELIER_HUB_TOKEN__: string;

/** Injected by the supervisor's WebHost (packaged) as window.__ATELIER_HUB__. */
declare global {
  interface Window {
    __ATELIER_HUB__?: { port: number | string; token: string };
  }
}

/** Discover the supervisor: injected global (packaged) or dev define/paste. */
function hubEndpoint(): { url: string; token: string } | null {
  const injected = window.__ATELIER_HUB__;
  if (injected?.port && injected.token) {
    return { url: `ws://127.0.0.1:${injected.port}`, token: injected.token };
  }
  const port =
    __ATELIER_HUB_PORT__ || localStorage.getItem("atelier.hubPort") || "";
  const token =
    __ATELIER_HUB_TOKEN__ || localStorage.getItem("atelier.hubToken") || "";
  if (!port || !token) return null;
  return { url: `ws://127.0.0.1:${port}`, token };
}

/**
 * Control connection to the supervisor. Same WS/rpc/subscribe machinery as
 * the bridge, but talks the projects.* surface and stays connected for the
 * whole session while the bridge re-points per selected project.
 */
export const hub = new BridgeClient({ resolveEndpoint: hubEndpoint });
