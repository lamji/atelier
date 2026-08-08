import { create } from "zustand";

/**
 * Sign-in state mirrored from the desktop main process (Supabase lives
 * there, not in the renderer). `configured: false` means no Supabase
 * project is set up locally — the login gate steps aside so the app stays
 * usable in that dev state.
 */
interface AuthStore {
  configured: boolean;
  user: AtelierAuthUser | null;
  /** Last login error (deep-link failures land here). */
  error: string | null;
  /** True until the initial getSession() resolves (pre-render, not a UI
   *  loading state — main.tsx awaits it before first paint). */
  ready: boolean;
  setSession: (state: AtelierAuthState) => void;
  setUser: (user: AtelierAuthUser | null, error?: string) => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  configured: true,
  user: null,
  error: null,
  ready: false,

  setSession: ({ configured, user }) =>
    set({ configured, user, ready: true, error: null }),
  setUser: (user, error) => set({ user, error: error ?? null }),
}));

/** Resolve the persisted session and wire live auth events. Called once
 *  before the first render so no screen ever flashes. */
export async function initAuth(): Promise<void> {
  const desktop = window.atelierDesktop;
  if (!desktop) {
    // Browser dev (vite without Electron): no auth surface at all.
    useAuthStore.setState({ configured: false, ready: true });
    return;
  }
  desktop.auth.onChanged((user, error) => {
    useAuthStore.getState().setUser(user, error);
  });
  try {
    const session = await desktop.auth.getSession();
    useAuthStore.getState().setSession(session);
  } catch (error) {
    // Main could not answer (misconfigured Supabase, handler threw). Land
    // on the login screen rather than holding up the whole window.
    useAuthStore.setState({
      ready: true,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
