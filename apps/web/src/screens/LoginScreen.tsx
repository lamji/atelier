import { useState } from "react";
import { Loader2 } from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/button";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import { BareTitleBar } from "@/views/shell/WindowControls";

export function LoginScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signInWithGoogle = async () => {
    if (!supabase) return;

    setBusy(true);
    setError(null);

    try {
      const desktop = window.atelierDesktop;
      const redirectTo = desktop
        ? await desktop.auth.callbackUrl()
        : `${window.location.origin}${window.location.pathname}`;
      const { data, error: authError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          skipBrowserRedirect: Boolean(desktop),
        },
      });

      if (authError) throw authError;
      if (desktop) {
        if (!data.url) throw new Error("Google sign-in URL was not returned.");
        await desktop.openExternal(data.url);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Google sign-in failed."
      );
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <BareTitleBar />
      <main className="flex min-h-0 flex-1 items-center justify-center px-6 py-10">
        <div className="flex w-full max-w-sm flex-col items-stretch gap-7 rounded-2xl border border-border bg-card/70 p-7 shadow-xl">
          <header className="flex flex-col items-center gap-2 text-center">
            <BrandMark className="h-12 w-12" title="Atelier" />
            <h1 className="text-xl font-semibold tracking-tight">
              Welcome to Atelier
            </h1>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Sign in to continue to your workspaces.
            </p>
          </header>

          {!supabaseConfigured ? (
            <div role="alert" className="rounded-xl bg-destructive/10 px-4 py-3 text-xs leading-relaxed text-destructive">
              Accounts are not configured. Add VITE_SUPABASE_URL and
              VITE_SUPABASE_PUBLISHABLE_KEY to apps/web/.env.local, then restart Atelier.
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {error && (
                <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </p>
              )}

              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void signInWithGoogle()}
                className="w-full"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4">
                    <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.5-.2-2.2H12v4.2h5.4a4.6 4.6 0 0 1-2 3v2.7h3.3c1.9-1.8 2.9-4.4 2.9-7.7Z" />
                    <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.7-2.4l-3.3-2.7c-.9.6-2 1-3.4 1a5.9 5.9 0 0 1-5.5-4.1H3.1v2.8A10 10 0 0 0 12 22Z" />
                    <path fill="#FBBC05" d="M6.5 13.8a6 6 0 0 1 0-3.7V7.4H3.1a10 10 0 0 0 0 9.2l3.4-2.8Z" />
                    <path fill="#EA4335" d="M12 6a5.4 5.4 0 0 1 3.8 1.5l2.9-2.8A9.7 9.7 0 0 0 12 2a10 10 0 0 0-8.9 5.4l3.4 2.7A5.9 5.9 0 0 1 12 6Z" />
                  </svg>
                )}
                {busy ? "Opening Google…" : "Continue with Google"}
              </Button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
