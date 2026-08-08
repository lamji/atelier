/**
 * Pairs projects.attach() calls with the MessagePorts the preload forwards.
 *
 * Ports cannot cross contextBridge, so the preload re-posts each one into
 * the page via window.postMessage({type, attachId}, ports). attachProject()
 * makes the invoke, then waits for the matching message.
 */
const PORT_MESSAGE_TYPE = "atelier-workspace-port";
const PORT_TIMEOUT_MS = 10_000;

const waiting = new Map<string, (port: MessagePort) => void>();
let listening = false;

function ensureListener(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data as { type?: string; attachId?: string } | null;
    if (data?.type !== PORT_MESSAGE_TYPE || !data.attachId) return;
    const port = event.ports[0];
    const resolve = waiting.get(data.attachId);
    if (port && resolve) {
      waiting.delete(data.attachId);
      resolve(port);
    }
  });
}

/**
 * Start (if needed) and attach to a project's agent; resolves with the RPC
 * MessagePort. Throws if the desktop bridge is missing (browser build) or
 * the agent fails to start.
 */
export async function attachProject(projectId: string): Promise<MessagePort> {
  const desktop = window.atelierDesktop;
  if (!desktop) throw new Error("not running in the desktop app");
  ensureListener();
  const { attachId } = await desktop.projects.attach(projectId);
  return new Promise<MessagePort>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(attachId);
      reject(new Error("workspace port never arrived"));
    }, PORT_TIMEOUT_MS);
    waiting.set(attachId, (port) => {
      clearTimeout(timer);
      resolve(port);
    });
  });
}
