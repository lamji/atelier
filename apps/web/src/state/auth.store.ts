import type { User } from "@supabase/supabase-js";
import { create } from "zustand";
import { supabase } from "@/lib/supabase";

async function completeDesktopOAuth(url: string): Promise<User> {
  if (!supabase) throw new Error("Supabase is not configured.");

  const callback = new URL(url);
  const callbackError =
    callback.searchParams.get("error_description") ??
    callback.searchParams.get("error");
  if (callbackError) throw new Error(callbackError);

  const code = callback.searchParams.get("code");
  if (!code) throw new Error("The Google callback did not include an auth code.");

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) throw error;
  if (!data.session?.user) throw new Error("Google sign-in did not create a session.");
  return data.session.user;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  initialized: boolean;
  initialize: () => () => void;
  signOut: () => Promise<string | null>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  initialized: false,

  initialize: () => {
    if (!supabase) {
      set({ loading: false, initialized: true });
      return () => undefined;
    }

    if (!get().initialized) {
      set({ initialized: true });
      void supabase.auth.getSession().then(({ data, error }) => {
        set({
          user: error ? null : data.session?.user ?? null,
          loading: false,
        });
      });
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      set({ user: session?.user ?? null, loading: false });
    });

    const unsubscribeDesktopAuth = window.atelierDesktop?.auth.onCallback(
      (url) => {
        set({ loading: true });
        void completeDesktopOAuth(url)
          .then((user) => set({ user, loading: false }))
          .catch((error: unknown) => {
            console.error("[auth] desktop OAuth callback failed", error);
            set({ user: null, loading: false });
          });
      }
    );

    return () => {
      subscription.unsubscribe();
      unsubscribeDesktopAuth?.();
    };
  },

  signOut: async () => {
    if (!supabase) return "Supabase is not configured.";
    const { error } = await supabase.auth.signOut();
    return error?.message ?? null;
  },
}));
