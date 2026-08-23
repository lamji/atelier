import { supabase } from "@/lib/supabase";

const DEVICE_ID_KEY = "atelier.device-id";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let ephemeralDeviceId: string | null = null;

export interface DeviceIdentity {
  id: string;
  label: string;
}

export interface ActiveDeviceSession {
  device_id: string;
  device_label: string;
  updated_at: string;
}

function platformLabel(): string | null {
  const platform = navigator.platform.trim();
  if (!platform) return null;
  if (platform.startsWith("Win")) return "Windows";
  if (platform.startsWith("Mac")) return "macOS";
  if (platform.includes("Linux")) return "Linux";
  return platform.slice(0, 40);
}

export function currentDevice(): DeviceIdentity {
  let id = ephemeralDeviceId;

  try {
    const stored = window.localStorage.getItem(DEVICE_ID_KEY);
    if (stored && UUID_PATTERN.test(stored)) {
      id = stored;
    } else {
      id = crypto.randomUUID();
      window.localStorage.setItem(DEVICE_ID_KEY, id);
    }
  } catch {
    id ??= crypto.randomUUID();
  }

  ephemeralDeviceId = id;
  const surface = window.atelierDesktop ? "Atelier desktop" : "Atelier web";
  const platform = platformLabel();

  return {
    id,
    label: platform ? `${surface} on ${platform}` : surface,
  };
}

export async function readActiveDevice(
  userId: string
): Promise<ActiveDeviceSession | null> {
  if (!supabase) throw new Error("Supabase is not configured.");

  const { data, error } = await supabase
    .from("active_sessions")
    .select("device_id, device_label, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function claimAvailableDevice(
  userId: string,
  device: DeviceIdentity
): Promise<boolean> {
  if (!supabase) throw new Error("Supabase is not configured.");

  const row = {
    user_id: userId,
    device_id: device.id,
    device_label: device.label,
    updated_at: new Date().toISOString(),
  };
  const { error: insertError } = await supabase
    .from("active_sessions")
    .insert(row);

  if (!insertError) return true;
  if (insertError.code !== "23505") throw insertError;

  const active = await readActiveDevice(userId);
  if (active?.device_id !== device.id) return false;

  const { error: updateError } = await supabase
    .from("active_sessions")
    .update({
      device_label: device.label,
      updated_at: row.updated_at,
    })
    .eq("user_id", userId)
    .eq("device_id", device.id);

  if (updateError) throw updateError;
  return true;
}

export async function takeOverActiveDevice(
  userId: string,
  device: DeviceIdentity
): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured.");

  const { error } = await supabase.from("active_sessions").upsert(
    {
      user_id: userId,
      device_id: device.id,
      device_label: device.label,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (error) throw error;
}

export async function releaseActiveDevice(
  userId: string,
  deviceId: string
): Promise<void> {
  if (!supabase) return;

  const { error } = await supabase
    .from("active_sessions")
    .delete()
    .eq("user_id", userId)
    .eq("device_id", deviceId);

  if (error) throw error;
}

export async function watchActiveDevice(
  userId: string,
  onChanged: (session: ActiveDeviceSession | null) => void
): Promise<() => void> {
  if (!supabase) return () => undefined;

  // Held locally: the guard above narrows `supabase` here, but not inside the
  // unsubscribe closure returned at the end.
  const client = supabase;
  const channel = client
    .channel(`active-session:${userId}:${crypto.randomUUID()}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "active_sessions",
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        onChanged(
          payload.eventType === "DELETE"
            ? null
            : (payload.new as ActiveDeviceSession)
        );
      }
    );

  try {
    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status, error) => {
        if (status === "SUBSCRIBED") resolve();
        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          reject(error ?? new Error("Could not monitor the active login."));
        }
      });
    });
  } catch (error) {
    // Removing a channel synchronously from its CLOSED callback re-enters the
    // same callback in Supabase Realtime until the renderer stack overflows.
    // Clean up only after the status callback has unwound.
    await client.removeChannel(channel);
    throw error;
  }

  // Realtime reconnects automatically, but it does not replay an UPDATE that
  // happened while the client was offline. This low-frequency ownership check
  // closes that gap without making polling the primary mechanism.
  const pollId = window.setInterval(() => {
    void readActiveDevice(userId)
      .then(onChanged)
      .catch((error: unknown) => {
        console.warn("[auth] active-device fallback check failed", error);
      });
  }, 30_000);

  return () => {
    window.clearInterval(pollId);
    void client.removeChannel(channel);
  };
}
