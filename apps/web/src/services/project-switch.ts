import { bridge } from "./bridge-client.js";
import { useCliConsoleStore } from "./cli-console.js";
import { attachProject } from "./desktop-port.js";
import { terminalRegistry } from "./terminal-registry.js";
import { setRosterScope } from "./terminal-roster.js";
import { useProjectsStore } from "@/state/projects.store";
import { usePreferencesStore } from "@/state/preferences.store";
import { useConnectionStore } from "@/state/connection.store";
import { resetWorkspaceStores } from "@/state/reset";

let started = false;

/**
 * Mirror the desktop's project list into the store. Called once at app
 * boot; the list itself and every agent status change arrive as pushes.
 */
export function startProjectSync(): void {
  if (started || !window.atelierDesktop) return;
  started = true;
  const desktop = window.atelierDesktop;
  desktop.projects.onChanged((projects) => {
    useProjectsStore.getState().setProjects(projects);
  });
  void desktop.projects
    .list()
    .then((projects) => {
      useProjectsStore.getState().setProjects(projects);
    })
    .catch((error) => {
      // An empty welcome screen and a broken registry read look identical
      // on screen, so make the difference visible somewhere.
      console.error("failed to load the project list", error);
      // Mark it loaded anyway: the app must route somewhere, and the
      // welcome screen is the recoverable option.
      useProjectsStore.getState().setProjects([]);
    });
}

/**
 * Open a workspace: start its agent (idempotent), attach a fresh RPC port,
 * and reset all workspace-scoped state so nothing from the previous project
 * leaks in. On a cold open the workspace screen is raised straight away and
 * fills in when the port lands; see attach() for why.
 */
export async function openWorkspace(id: string): Promise<void> {
  // Adding a project pushes the new list before add() even returns, so the
  // welcome screen's open and the app's "resume most recent" effect can both
  // fire for the same id. Share the one attempt instead of failing one of
  // them — a rejected duplicate used to leave the app on an empty screen.
  const inFlight = pending.get(id);
  if (inFlight) return inFlight;
  const store = useProjectsStore.getState();
  if (store.switching) throw new Error("a workspace switch is in progress");
  const attempt = attach(id).finally(() => pending.delete(id));
  pending.set(id, attempt);
  return attempt;
}

const pending = new Map<string, Promise<void>>();

async function attach(id: string): Promise<void> {
  const store = useProjectsStore.getState();
  /*
   * Cold open — nothing is on screen yet, so there is no working workspace to
   * protect and the shell can be raised BEFORE the agent is up. That is the
   * whole point: forking the agent takes seconds (native module load, schema,
   * SDK boot), and gating the window on it meant the app opened onto a bare
   * "Starting the agent…" spinner every single launch. The shell now mounts
   * immediately and fills in as the port arrives; bridge.rpc queues until then
   * and the status bar already reports "connecting".
   *
   * A switch between live workspaces keeps the old order: there the current
   * workspace is on screen and working, and tearing it down before the new
   * agent answers would trade a spinner for a broken window.
   */
  const coldOpen = store.activeId === null;
  store.setSwitching(true);
  store.setOpenError(null);
  if (coldOpen) {
    // Say "connecting", not "disconnected", for the seconds the fork takes.
    bridge.expectPort();
    applyWorkspace(id);
  }
  try {
    const port = await attachProject(id);
    if (!coldOpen) {
      bridge.disconnect();
      applyWorkspace(id);
    }
    bridge.setPort(port);
    store.setActive(id);
  } catch (error) {
    // The shell was already raised on an agent that never answered; fall back
    // to the picker rather than leaving a dead workspace on screen.
    if (coldOpen) {
      bridge.dropQueued();
      useProjectsStore.getState().setActive(null);
    }
    // The caller is often gone by now (the welcome screen unmounts the
    // moment the project list grows), so the reason has to outlive it.
    const message =
      error instanceof Error ? error.message : "could not open that workspace";
    console.error("failed to open workspace", id, error);
    useProjectsStore.getState().setOpenError(message);
    throw error;
  } finally {
    useProjectsStore.getState().setSwitching(false);
  }
}

/**
 * Point every workspace-scoped surface at `id`: drop the previous project's
 * state, scope preferences, and publish the root the status bar reads. On a
 * cold open this runs before the port exists — which is safe, because all of
 * it is renderer-side and none of it talks to the agent.
 */
function applyWorkspace(id: string): void {
  resetWorkspaceStores();
  terminalRegistry.disposeAll();
  // The CLI session ptys belong to the agent we just left; the pane
  // re-acquires (or opens) this workspace's own from its agent.
  useCliConsoleStore.getState().reset();
  // Each workspace keeps its own composer picks (model, effort, knowledge,
  // vibe); load this project's before anything can read them.
  usePreferencesStore.getState().setProjectScope(id);
  // Terminals belong to the workspace they were opened in, so their saved
  // roster is scoped the same way the composer picks are.
  setRosterScope(id);
  const project = useProjectsStore.getState().projects.find((p) => p.id === id);
  useConnectionStore.getState().setWorkspaceRoot(project?.path ?? null);
  useProjectsStore.getState().setActive(id);
}

/** Leave the workspace (back to the picker); the agent stays warm. */
export function closeWorkspace(): void {
  bridge.disconnect();
  // Nothing is going to answer these now.
  bridge.dropQueued();
  useProjectsStore.getState().setActive(null);
  useProjectsStore.getState().setOpenError(null);
}

export async function addProject(path: string): Promise<AtelierProjectInfo> {
  const desktop = window.atelierDesktop;
  if (!desktop) throw new Error("not running in the desktop app");
  return desktop.projects.add(path);
}

export async function stopProject(id: string): Promise<void> {
  await window.atelierDesktop?.projects.stop(id);
}

export async function removeProject(id: string): Promise<void> {
  await window.atelierDesktop?.projects.remove(id);
}
