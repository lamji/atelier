import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useAuthStore } from "@/state/auth.store";
import { BrandMark } from "@/components/BrandMark";
import { cn } from "@/lib/cn";

/**
 * The front door. One decision on this screen — sign in — so everything
 * else stays quiet: wordmark, one line of intent, the button. The browser
 * handles the actual Google flow; the deep link brings the user back and
 * auth.onChanged navigates away (no spinner-gated flow here).
 */
export function LoginScreen({ configured }: { configured: boolean }) {
  const error = useAuthStore((s) => s.error);
  const [waiting, setWaiting] = useState(false);
  const reduceMotion = useReducedMotion();

  const [abandoned, setAbandoned] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const signIn = async () => {
    setWaiting(true);
    setAbandoned(false);
    const result = await window.atelierDesktop?.auth.startLogin();
    setHint(result?.hint ?? null);
    if (result && !result.ok) setWaiting(false);
  };

  /**
   * Coming back to this window without a session means the browser trip did
   * not finish — a closed tab, a cancelled consent, the wrong account. On
   * success the app is already navigating away, so anything that reaches
   * here is an abandoned attempt and the button has to re-arm. Without this
   * the screen sits on "Waiting for your browser…" until the app restarts.
   */
  useEffect(() => {
    if (!waiting) return;
    const onFocus = () => {
      if (useAuthStore.getState().user) return;
      setWaiting(false);
      setAbandoned(true);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [waiting]);

  return (
    <div className="flex h-full flex-col items-center justify-center bg-background">
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="flex w-full max-w-xs flex-col items-center"
      >
        {/* The mark's bead sits in the ring's gap, so spinning it reads as
            the app warming up rather than as a loading spinner. */}
        <BrandMark className={cn("h-14 w-14", !reduceMotion && "orb-spin")} />
        <h1 className="mt-6 text-2xl font-bold tracking-tight">Atelier</h1>
        <p className="mt-1.5 text-center text-xs text-muted-foreground">
          Your workshop for building software with agents.
        </p>

        <button
          type="button"
          onClick={() => void signIn()}
          disabled={waiting || !configured}
          className={cn(
            "mt-10 flex h-10 w-full items-center justify-center gap-2.5",
            "rounded-xl bg-foreground text-[13px] font-medium text-background",
            "outline-none transition-opacity hover:opacity-90",
            "disabled:opacity-60"
          )}
        >
          <GoogleMark />
          {waiting
            ? "Waiting for your browser…"
            : abandoned
              ? "Try again"
              : "Continue with Google"}
        </button>

        {!configured && (
          <div
            className="mt-4 rounded-xl bg-muted/60 px-3 py-2.5 text-[11px]
              leading-relaxed text-muted-foreground"
          >
            <p className="font-medium text-foreground">Sign-in isn't set up</p>
            <p className="mt-1">
              Add your Supabase URL and anon key to{" "}
              <code className="font-mono">apps/desktop/auth.local.json</code>,
              then restart. The Supabase project needs{" "}
              <code className="font-mono">http://127.0.0.1:53174/auth-callback</code>{" "}
              (and <code className="font-mono">:53175</code>,{" "}
              <code className="font-mono">:53176</code>) in its allowed
              redirect URLs.
            </p>
          </div>
        )}

        {error && (
          <p className="mt-4 text-center text-xs leading-relaxed text-destructive">
            {error}
          </p>
        )}
        {waiting && !error && (
          <p className="mt-4 text-center text-[11px] leading-relaxed text-muted-foreground/70">
            Finish signing in the browser window — Atelier comes back to the
            front by itself.
          </p>
        )}
        {abandoned && !error && (
          <div className="mt-4 space-y-2">
            <p className="text-center text-[11px] leading-relaxed text-muted-foreground/70">
              Sign-in didn't finish. Try again.
            </p>
            {/*
              The failure this explains is silent by design: when a redirect
              URL is not allow-listed, Supabase does not error — it redirects
              to the project's Site URL instead, so the browser lands
              somewhere unrelated and our callback is never called. Without
              naming the URLs, that is undiagnosable.
            */}
            {hint && (
              <p
                className="rounded-lg bg-muted/60 px-3 py-2 text-[10px]
                  leading-relaxed text-muted-foreground"
              >
                {hint}
              </p>
            )}
          </div>
        )}
      </motion.div>

      <p className="absolute bottom-4 text-[10px] text-muted-foreground/50">
        {window.atelierDesktop?.version ?? "dev"}
      </p>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.3-2.1 3.7-5.1 3.7-8.6z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 6-1.1 8-2.9l-3.8-3c-1 .7-2.4 1.2-4.2 1.2-3.2 0-5.9-2.1-6.9-5l-3.9 3C3.2 21.3 7.3 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.1 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3l-4-3C.4 8.3 0 10.1 0 12s.4 3.7 1.2 5.3l3.9-3z"
      />
      <path
        fill="#EA4335"
        d="M12 4.7c2.3 0 3.8 1 4.7 1.8l3.4-3.3C18 1.2 15.2 0 12 0 7.3 0 3.2 2.7 1.2 6.7l4 3c.9-2.9 3.6-5 6.8-5z"
      />
    </svg>
  );
}
