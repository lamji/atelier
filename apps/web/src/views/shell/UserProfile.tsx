import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Crown, LogOut, User, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { Tooltip } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/state/auth.store";

export function UserProfile() {
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const [open, setOpen] = useState(false);
  const [upgradeRequested, setUpgradeRequested] = useState(false);

  useEffect(() => {
    if (!open) {
      setUpgradeRequested(false);
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!user) return null;

  const avatarUrl: string | undefined =
    user.user_metadata?.avatar_url ?? undefined;
  const fullName: string | undefined =
    user.user_metadata?.full_name ?? undefined;
  const email = user.email;
  const plan =
    String(user.app_metadata?.plan ?? "free").toLowerCase() === "pro"
      ? "Pro"
      : "Free";

  const initials = fullName
    ? fullName
        .split(" ")
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase()
    : (email?.[0]?.toUpperCase() ?? "?");

  return (
    <div className="flex shrink-0 flex-col items-center pb-2">
      <Tooltip
        side="right"
        content={open ? "Close profile" : (fullName ?? email ?? "Profile")}
      >
        <button
          type="button"
          aria-label="User profile"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className={cn("dock-tile overflow-hidden", open && "dock-tile-on")}
        >
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="h-6 w-6 rounded-full object-cover"
            />
          ) : (
            <span className="text-[11px] font-semibold leading-none">
              {initials}
            </span>
          )}
        </button>
      </Tooltip>

      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              className="fixed inset-0 z-[210] flex items-center justify-center bg-black/55 p-6"
            >
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label="User profile"
                initial={{ opacity: 0, scale: 0.97, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, y: 10 }}
                transition={{ type: "spring", stiffness: 300, damping: 28 }}
                onClick={(event) => event.stopPropagation()}
                className="modal-surface island flex w-[min(92vw,400px)] flex-col overflow-hidden"
              >
                <div className="modal-titlebar flex h-12 shrink-0 items-center px-3">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <User className="h-4 w-4 text-primary" />
                    Atelier
                  </span>
                  <span className="flex flex-1 items-center justify-center text-sm font-semibold">
                    Profile
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setOpen(false)}
                    aria-label="Close profile"
                    className="h-7 w-7 rounded-full border border-border bg-card hover:bg-destructive hover:text-white"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="flex items-center gap-4 p-6">
                  {avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-14 w-14 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary">
                      {initials}
                    </span>
                  )}
                  <div className="flex min-w-0 flex-col gap-0.5">
                    {fullName && (
                      <span className="truncate text-base font-semibold">
                        {fullName}
                      </span>
                    )}
                    {email && (
                      <span className="truncate text-sm text-muted-foreground">
                        {email}
                      </span>
                    )}
                  </div>
                </div>

                <div className="border-t border-border-subtle px-6 py-4">
                  <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-primary/5 p-4">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        Current plan
                      </span>
                      <span className="flex items-center gap-1.5 text-sm font-semibold">
                        <Crown className="h-4 w-4 text-primary" />
                        {plan}
                      </span>
                    </div>
                    {plan === "Free" ? (
                      <Button
                        type="button"
                        size="sm"
                        disabled={upgradeRequested}
                        onClick={() => setUpgradeRequested(true)}
                      >
                        {upgradeRequested ? "Upgrade requested" : "Upgrade to Pro"}
                      </Button>
                    ) : (
                      <Badge className="bg-primary/10 text-primary">
                        Pro account
                      </Badge>
                    )}
                  </div>
                  {upgradeRequested && plan === "Free" && (
                    <p role="status" className="mt-2 text-xs text-muted-foreground">
                      Pro upgrades are coming soon.
                    </p>
                  )}
                </div>

                <div className="border-t border-border-subtle px-6 pb-6 pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setOpen(false);
                      void signOut();
                    }}
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </Button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
