import { useState } from "react";
import { Check, Copy, LogOut, Mail, ShieldCheck, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useAuthStore } from "@/state/auth.store";

/**
 * The signed-in account: who you are, and the way out.
 *
 * Sign-out lives here rather than in the title bar because it is rare and
 * destructive-adjacent — it detaches the workspace and drops every agent
 * connection — so it belongs behind a deliberate trip to Settings with a
 * confirmation step, not one click from the chrome.
 */
export function AccountTab() {
  const user = useAuthStore((s) => s.user);
  const configured = useAuthStore((s) => s.configured);
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [copied, setCopied] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await window.atelierDesktop?.auth.logout();
      // No navigation here: main broadcasts auth.changed, the store clears,
      // and App swaps to the login screen. Doing it twice would race.
    } finally {
      setSigningOut(false);
      setConfirming(false);
    }
  };

  const copyEmail = async () => {
    if (!user?.email) return;
    try {
      await navigator.clipboard.writeText(user.email);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied — the address is on screen and selectable anyway.
    }
  };

  if (!configured || !user) {
    return (
      <p className="rounded-lg bg-muted/40 px-2.5 py-3 text-[11px] leading-relaxed text-muted-foreground/70">
        {configured
          ? "No account is signed in."
          : "Sign-in isn't configured for this build, so there is no account to show."}
      </p>
    );
  }

  const displayName = user.name?.trim() || user.email;

  return (
    <div className="flex flex-col gap-3">
      <section className="space-y-1.5">
        <h3 className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          Account
        </h3>

        <div className="overflow-hidden rounded-lg bg-muted/40">
          <div className="flex items-center gap-3 p-3">
            <Avatar src={user.avatar} name={displayName} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{displayName}</p>
              <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                <Mail className="h-3 w-3 shrink-0" />
                <span className="truncate">{user.email}</span>
              </p>
            </div>
            <Tooltip content={copied ? "Copied" : "Copy email address"}>
              <button
                type="button"
                onClick={() => void copyEmail()}
                aria-label="Copy email address"
                className="tool-btn shrink-0"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </Tooltip>
          </div>

          <div className="flex items-center gap-1.5 border-t border-border/60 px-3 py-2">
            <ShieldCheck className="h-3 w-3 shrink-0 text-success" />
            <span className="text-[10px] text-muted-foreground">
              Signed in with Google
            </span>
            {/* The account id, for support: identifies the row without
                exposing anything a session token would. */}
            <span className="ml-auto truncate font-mono text-[10px] text-muted-foreground/50">
              {user.id}
            </span>
          </div>
        </div>
      </section>

      <section className="space-y-1.5">
        <h3 className="px-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          Session
        </h3>

        {confirming ? (
          <div className="space-y-2 rounded-lg bg-destructive/10 p-2.5">
            <p className="text-[11px] leading-relaxed text-foreground">
              Sign out of Atelier? This closes the current workspace and stops
              its agents. Nothing on disk is changed.
            </p>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={signingOut}
                onClick={() => void signOut()}
                className="!h-6 px-2 py-0.5 text-[10px]"
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={signingOut}
                onClick={() => setConfirming(false)}
                className="!h-6 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setConfirming(true)}
            className="!h-7 w-full justify-start gap-2 px-2.5 text-[11px] hover:text-destructive"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </Button>
        )}
      </section>
    </div>
  );
}

/** Provider avatar, falling back to an initial. */
function Avatar({ src, name }: { src?: string; name: string }) {
  const [broken, setBroken] = useState(false);
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="h-9 w-9 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
        "text-xs font-semibold text-primary"
      )}
      style={{ background: "var(--atelier-brand-soft)" }}
    >
      {initial === "?" ? <UserRound className="h-4 w-4" /> : initial}
    </span>
  );
}
