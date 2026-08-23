import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { OpeningScreen } from "@/screens/OpeningScreen";
import { LoginScreen } from "@/screens/LoginScreen";
import { SessionConflictModal } from "@/screens/SessionConflictModal";
import { WelcomeScreen } from "@/screens/WelcomeScreen";
import { WorkspaceSkeleton } from "@/screens/WorkspaceSkeleton";
import { ErrorBoundary } from "@/views/shell/ErrorBoundary";
import { startEventDispatcher } from "@/services/event-dispatcher";
import {
  openWorkspace,
  startProjectSync,
} from "@/services/project-switch";
import { useProjectsStore } from "@/state/projects.store";
import { useAuthStore } from "@/state/auth.store";

/**
 * The workspace carries Monaco, xterm and the graph stack — lazy so the
 * login/welcome chunk stays tiny and first paint is instant.
 */
const loadWorkspace = () => import("@/screens/WorkspaceScreen");
const WorkspaceScreen = lazy(loadWorkspace);

/**
 * Start pulling the workspace chunk before anything needs it.
 *
 * Lazy-loading it keeps first paint instant, but it also meant the chunk only
 * began downloading at the moment we wanted to render it — so the Suspense
 * fallback was on screen for as long as Monaco took to parse, on top of the
 * agent boot. Warming it the moment we know a workspace is coming overlaps
 * that cost with the agent fork instead of stacking the two.
 *
 * import() dedupes, so this and the lazy() below resolve to the one load.
 */
function warmWorkspaceChunk(): void {
  void loadWorkspace().catch(() => {
    // A failed prefetch is not an error: lazy() will retry and surface it.
  });
}

/**
 * Screen flow: workspace picker → workspace. With
 * workspaces on record the most recent one opens straight away, and with
 * none the welcome screen goes straight to the folder picker. Switching and
 * adding both live in the workspace's own selector.
 */
export function App() {
  const user = useAuthStore((s) => s.user);
  const authLoading = useAuthStore((s) => s.loading);
  const initializeAuth = useAuthStore((s) => s.initialize);
  const projects = useProjectsStore((s) => s.projects);
  const activeId = useProjectsStore((s) => s.activeId);
  const loaded = useProjectsStore((s) => s.loaded);

  useEffect(() => initializeAuth(), [initializeAuth]);

  useEffect(() => {
    if (!user) return;
    startEventDispatcher();
    startProjectSync();
    warmWorkspaceChunk();
  }, [user]);

  // Reopen the most recent workspace once, as soon as we know there is one.
  // Guarded by a ref rather than state: leaving a workspace on purpose
  // (removal) must not bounce straight back into it.
  const resumed = useRef(false);
  const canResume = loaded && activeId === null;
  // Layout effect, not effect: openWorkspace flips `switching` synchronously,
  // and running before paint is what keeps the picker from flashing for one
  // frame on the way into the resumed workspace.
  useLayoutEffect(() => {
    if (!user || !canResume || resumed.current || projects.length === 0) return;
    resumed.current = true;
    const recent = [...projects].sort(
      (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)
    )[0];
    if (recent) void openWorkspace(recent.id).catch(() => undefined);
  }, [canResume, projects, user]);

  if (authLoading) return <Shell />;
  if (!user) {
    return (
      <>
        <LoginScreen />
        <SessionConflictModal />
      </>
    );
  }

  // Hold the frame until the registry answers — a sub-second IPC round trip
  // that does not deserve a loading screen of its own.
  if (!loaded) return <Shell />;
  // Projects on record but none attached: the agent is still forking, or the
  // attempt failed. Either way it needs a screen — rendering the empty shell
  // here is what turned a slow or failed open into a black window.
  if (activeId === null) {
    if (projects.length > 0) return <OpeningScreen />;
    return <WelcomeScreen />;
  }
  return (
    <ErrorBoundary where="Workspace">
      {/* The workbench's own frame, not a spinner: the chunk being fetched
          IS this screen, so showing its shape is honest and makes the
          arrival a fill rather than a swap. */}
      <Suspense fallback={<WorkspaceSkeleton />}>
        <WorkspaceScreen />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Empty window chrome: keeps the background painted and the window
 *  draggable during the sub-second gaps between screens. */
function Shell() {
  return <div className="h-full bg-background" />;
}
