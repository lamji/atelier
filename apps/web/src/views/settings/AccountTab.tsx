import { useEffect, useState, type FormEvent } from "react";
import { Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/state/auth.store";

interface Profile {
  full_name: string | null;
  username: string | null;
  website: string | null;
}

const EMPTY_PROFILE: Profile = {
  full_name: null,
  username: null,
  website: null,
};

export function AccountTab() {
  const user = useAuthStore((state) => state.user);
  const signOut = useAuthStore((state) => state.signOut);
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase || !user) return;
    let active = true;
    void supabase
      .from("profiles")
      .select("full_name, username, website")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data, error: loadError }) => {
        if (!active) return;
        if (loadError) setError(loadError.message);
        if (data) setProfile(data);
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [user]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !user) return;

    setSaving(true);
    setError(null);
    setStatus(null);
    const normalized = {
      full_name: profile.full_name?.trim() || null,
      username: profile.username?.trim().toLowerCase() || null,
      website: profile.website?.trim() || null,
    };
    const { error: saveError } = await supabase
      .from("profiles")
      .update(normalized)
      .eq("id", user.id);
    setSaving(false);

    if (saveError) {
      setError(
        saveError.code === "23505"
          ? "That username is already taken."
          : saveError.message
      );
      return;
    }
    setProfile(normalized);
    setStatus("Saved.");
  };

  if (!user) return null;

  return (
    <div className="flex flex-col gap-5">
      <section className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background/40 p-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-xs font-semibold">Signed in as</span>
          <span className="truncate text-xs text-muted-foreground">{user.email}</span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void signOut()}
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign out
        </Button>
      </section>

      <form onSubmit={(event) => void save(event)} className="flex flex-col gap-4 rounded-xl border border-border bg-background/40 p-4">
        <div>
          <h3 className="text-sm font-semibold">Profile</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            These details belong to your Atelier account.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <>
            <label className="flex flex-col gap-1.5 text-xs font-medium">
              Name
              <Input
                maxLength={80}
                autoComplete="name"
                value={profile.full_name ?? ""}
                onChange={(event) =>
                  setProfile((current) => ({ ...current, full_name: event.target.value }))
                }
                placeholder="Ada Lovelace"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-medium">
              Username
              <Input
                pattern="[A-Za-z0-9_-]{3,32}"
                value={profile.username ?? ""}
                onChange={(event) =>
                  setProfile((current) => ({ ...current, username: event.target.value }))
                }
                placeholder="ada"
              />
              <span className="text-[10px] text-muted-foreground">
                3–32 letters, numbers, hyphens, or underscores.
              </span>
            </label>
            <label className="flex flex-col gap-1.5 text-xs font-medium">
              Website
              <Input
                type="url"
                value={profile.website ?? ""}
                onChange={(event) =>
                  setProfile((current) => ({ ...current, website: event.target.value }))
                }
                placeholder="https://example.com"
              />
            </label>

            {error && (
              <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
            {status && (
              <p role="status" className="rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary">
                {status}
              </p>
            )}

            <div className="flex items-center justify-end">
              <Button type="submit" size="sm" disabled={saving}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
