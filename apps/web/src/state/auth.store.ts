import type { User } from "@supabase/supabase-js";
import { create } from "zustand";
import { supabase } from "@/lib/supabase";
import {
  claimAvailableDevice,
  currentDevice,
  readActiveDevice,
  releaseActiveDevice,
  takeOverActiveDevice,
  watchActiveDevice,
  type ActiveDeviceSession,
} from "@/lib/single-session";

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

export interface SessionConflict {
  deviceLabel: string;
  lastActiveAt: string;
}

interface AuthState {
  user: User | null;
  pendingUser: User | null;
  loading: boolean;
  initialized: boolean;
  sessionConflict: SessionConflict | null;
  sessionActionBusy: boolean;
  sessionError: string | null;
  notice: string | null;
  initialize: () => () => void;
  continueOnThisDevice: () => Promise<void>;
  cancelSessionConflict: () => Promise<void>;
  signOut: () => Promise<string | null>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown authentication error.";
}

function toConflict(session: ActiveDeviceSession): SessionConflict {
  return {
    deviceLabel: session.device_label,
    lastActiveAt: session.updated_at,
  };
}

export const useAuthStore = create<AuthState>((set, get) => {
  let stopWatching: (() => void) | null = null;
  let setupToken = 0;

  const stopActiveDeviceWatch = () => {
    stopWatching?.();
    stopWatching = null;
  };

  const invalidateSetup = () => {
    setupToken += 1;
    stopActiveDeviceWatch();
  };

  const signOutDisplacedDevice = async (userId: string, token: number) => {
    if (token !== setupToken || get().user?.id !== userId) return;

    invalidateSetup();
    set({
      user: null,
      pendingUser: null,
      loading: false,
      sessionConflict: null,
      sessionActionBusy: false,
      sessionError: null,
      notice: "You were signed out because this account continued on another device.",
    });
    await supabase?.auth.signOut({ scope: "local" });
  };

  const establishActiveDevice = async (user: User) => {
    const token = ++setupToken;
    stopActiveDeviceWatch();
    const device = currentDevice();

    set({
      user: null,
      pendingUser: user,
      loading: true,
      sessionConflict: null,
      sessionActionBusy: false,
      sessionError: null,
      notice: null,
    });

    try {
      const stop = await watchActiveDevice(user.id, (active) => {
        if (
          token !== setupToken ||
          !active ||
          active.device_id === device.id
        ) {
          return;
        }

        const state = get();
        if (state.user?.id === user.id) {
          void signOutDisplacedDevice(user.id, token);
          return;
        }
        if (state.pendingUser?.id === user.id) {
          set({
            loading: false,
            sessionConflict: toConflict(active),
            sessionError: null,
          });
        }
      });

      if (token !== setupToken) {
        stop();
        return;
      }
      stopWatching = stop;

      const active = await readActiveDevice(user.id);
      if (token !== setupToken) return;

      if (active && active.device_id !== device.id) {
        set({
          loading: false,
          sessionConflict: toConflict(active),
          sessionError: null,
        });
        return;
      }

      const claimed = await claimAvailableDevice(user.id, device);
      if (token !== setupToken) return;

      if (!claimed) {
        const winner = await readActiveDevice(user.id);
        if (!winner || winner.device_id === device.id) {
          throw new Error("Could not determine which device owns this login.");
        }
        set({
          loading: false,
          sessionConflict: toConflict(winner),
          sessionError: null,
        });
        return;
      }

      set({
        user,
        pendingUser: null,
        loading: false,
        sessionConflict: null,
        sessionActionBusy: false,
        sessionError: null,
        notice: null,
      });
    } catch (error) {
      if (token !== setupToken) return;

      console.error("[auth] active-device verification failed", error);
      invalidateSetup();
      set({
        user: null,
        pendingUser: null,
        loading: false,
        sessionConflict: null,
        sessionActionBusy: false,
        sessionError: null,
        notice: `Sign-in could not be secured: ${errorMessage(error)}`,
      });
      await supabase?.auth.signOut({ scope: "local" });
    }
  };

  return {
    user: null,
    pendingUser: null,
    loading: true,
    initialized: false,
    sessionConflict: null,
    sessionActionBusy: false,
    sessionError: null,
    notice: null,

    initialize: () => {
      if (!supabase) {
        set({ loading: false, initialized: true });
        return () => undefined;
      }

      let active = true;
      set({ initialized: true });

      void supabase.auth.getSession().then(({ data, error }) => {
        if (!active) return;
        if (error || !data.session) {
          set({
            user: null,
            pendingUser: null,
            loading: false,
            notice: error ? error.message : null,
          });
          return;
        }
        void establishActiveDevice(data.session.user);
      });

      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        if (!active) return;

        if (!session) {
          invalidateSetup();
          set({
            user: null,
            pendingUser: null,
            loading: false,
            sessionConflict: null,
            sessionActionBusy: false,
            sessionError: null,
          });
          return;
        }

        const state = get();
        if (
          state.user?.id === session.user.id &&
          !state.sessionConflict
        ) {
          return;
        }

        set({ loading: true });
        window.setTimeout(() => {
          if (active) void establishActiveDevice(session.user);
        }, 0);
      });

      const unsubscribeDesktopAuth = window.atelierDesktop?.auth.onCallback(
        (url) => {
          set({ loading: true, notice: null });
          void completeDesktopOAuth(url)
            .then((user) => establishActiveDevice(user))
            .catch((error: unknown) => {
              console.error("[auth] desktop OAuth callback failed", error);
              set({
                user: null,
                pendingUser: null,
                loading: false,
                notice: errorMessage(error),
              });
            });
        }
      );

      return () => {
        active = false;
        subscription.unsubscribe();
        unsubscribeDesktopAuth?.();
        invalidateSetup();
      };
    },

    continueOnThisDevice: async () => {
      const pendingUser = get().pendingUser;
      if (!supabase || !pendingUser) return;

      set({ sessionActionBusy: true, sessionError: null });
      const device = currentDevice();

      try {
        const { error } = await supabase.auth.signOut({ scope: "others" });
        if (error) throw error;

        await takeOverActiveDevice(pendingUser.id, device);
        set({
          user: pendingUser,
          pendingUser: null,
          loading: false,
          sessionConflict: null,
          sessionActionBusy: false,
          sessionError: null,
          notice: null,
        });
      } catch (error) {
        set({
          sessionActionBusy: false,
          sessionError: errorMessage(error),
        });
      }
    },

    cancelSessionConflict: async () => {
      invalidateSetup();
      set({
        user: null,
        pendingUser: null,
        loading: false,
        sessionConflict: null,
        sessionActionBusy: false,
        sessionError: null,
      });
      await supabase?.auth.signOut({ scope: "local" });
    },

    signOut: async () => {
      if (!supabase) return "Supabase is not configured.";

      const userId = get().user?.id;
      const device = currentDevice();
      set({ loading: true, notice: null });

      let releaseError: string | null = null;
      if (userId) {
        try {
          await releaseActiveDevice(userId, device.id);
        } catch (error) {
          releaseError = errorMessage(error);
        }
      }

      const { error } = await supabase.auth.signOut();
      invalidateSetup();
      set({
        user: null,
        pendingUser: null,
        loading: false,
        sessionConflict: null,
        sessionActionBusy: false,
        sessionError: null,
      });
      return error?.message ?? releaseError;
    },
  };
});
