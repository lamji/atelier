import type { EventFrame } from "@atelier/protocol";
import { BridgeClient } from "./bridge-client.js";
import { hub } from "./hub-client.js";
import { useProjectsStore } from "@/state/projects.store";
import { useWorkspaceActivityStore } from "@/state/workspace-activity.store";

/**
 * Watches the workspaces you are not looking at.
 *
 * Each project runs its own agent process, and those processes stay warm
 * after you switch away — so "the supervisor says running" only means the
 * process is alive, never that work is happening. To report activity
 * honestly, this opens a second, read-only bridge link to every warm
 * background agent: it seeds from task.list and then follows agent.status.
 *
 * Deliberately client-side. The supervisor has no channel to the agents'
 * status, and inventing one would mean changing the backend.
 */
class WorkspaceActivityMonitor {
  private clients = new Map<string, BridgeClient>();
  /** Guards against two syncs racing on the same project's endpoint. */
  private opening = new Set<string>();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    // Re-sync whenever the project list, their statuses, or the active
    // project changes — that is exactly when the watch set changes.
    useProjectsStore.subscribe(() => this.sync());
    this.sync();
  }

  private sync(): void {
    const { projects, activeId } = useProjectsStore.getState();
    // The active project is covered by the main bridge; never double-watch.
    const wanted = new Set(
      projects
        .filter((p) => p.status === "running" && p.id !== activeId)
        .map((p) => p.id)
    );

    for (const id of [...this.clients.keys()]) {
      if (!wanted.has(id)) this.drop(id);
    }
    for (const id of wanted) {
      if (!this.clients.has(id) && !this.opening.has(id)) void this.watch(id);
    }
    // A project the monitor no longer covers must not leave a stale badge.
    const activity = useWorkspaceActivityStore.getState();
    for (const id of Object.keys(activity.byProject)) {
      if (!wanted.has(id)) activity.forget(id);
    }
  }

  private async watch(id: string): Promise<void> {
    this.opening.add(id);
    try {
      // Idempotent for an already-running agent: returns its live endpoint
      // without spawning anything (we only ask for projects already up).
      const { endpoint } = await hub.rpc("projects.start", { id });
      // The watch set may have moved on while we awaited.
      const { projects, activeId } = useProjectsStore.getState();
      const still = projects.some(
        (p) => p.id === id && p.status === "running" && p.id !== activeId
      );
      if (!still || this.clients.has(id)) return;

      const client = new BridgeClient({
        resolveEndpoint: () => ({
          url: `ws://127.0.0.1:${endpoint.port}`,
          token: endpoint.token,
        }),
      });
      this.clients.set(id, client);

      const store = useWorkspaceActivityStore.getState();
      client.onStatus((state) => {
        if (state === "connected") {
          store.set(id, { observed: true });
          void this.seed(id, client);
        } else {
          // Without a link we cannot claim to know; drop the claim rather
          // than leave a dot asserting something stale.
          store.set(id, { observed: false, working: false, tasks: 0 });
        }
      });
      client.subscribe("agent.status", (frame: EventFrame) => {
        const status = (frame.payload as { status?: string }).status;
        if (status === undefined) return;
        store.set(id, { working: status === "working" });
      });
      client.connect();
    } catch {
      // Agent not reachable; sync() retries on the next status change.
    } finally {
      this.opening.delete(id);
    }
  }

  /** Current truth on connect: events only report transitions. */
  private async seed(id: string, client: BridgeClient): Promise<void> {
    try {
      const { tasks } = await client.rpc("task.list", { activeOnly: true });
      useWorkspaceActivityStore
        .getState()
        .set(id, { tasks: tasks.length, working: tasks.length > 0 });
    } catch {
      // Leave the event stream to fill it in.
    }
  }

  private drop(id: string): void {
    this.clients.get(id)?.disconnect();
    this.clients.delete(id);
    useWorkspaceActivityStore.getState().forget(id);
  }
}

export const workspaceActivity = new WorkspaceActivityMonitor();
