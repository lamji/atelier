import { useCallback, useEffect, useState } from "react";
import { isDesktop } from "@/lib/desktop";

/** Re-checks while the app stays open; a session can outlive a release. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

/** What the header button is doing right now. */
export type UpdateStage =
  | "idle"
  | "downloading"
  | "verifying"
  | "launching"
  | "error";

export interface UpdatesVm {
  /** The newer version, when one exists — otherwise null. */
  available: string | null;
  /** Where the in-app install has got to. */
  stage: UpdateStage;
  /** 0-100 while downloading, null when the size is unknown. */
  percent: number | null;
  /** Why it stopped, when it stopped badly. */
  error: string | null;
  /** Downloads and runs the installer without leaving the app. */
  install: () => void;
  /** The version running now. */
  current: string;
  /** Release notes for the version just installed, shown once. */
  changelog: { version: string; notes: string | null; url: string | null } | null;
  /** True while a check is in flight, for the "Check now" affordance. */
  checking: boolean;
  download: () => void;
  check: () => void;
  dismissChangelog: () => void;
}

/**
 * Update state for the shell: is there a newer release, and did this launch
 * follow an upgrade.
 *
 * Both questions are answered by the main process (it owns the version and
 * the network call); this is the thin renderer half. In the browser build
 * there is no desktop bridge and no installer to update, so everything here
 * stays inert rather than pretending.
 */
export function useUpdatesViewModel(): UpdatesVm {
  const desktop = isDesktop() ? window.atelierDesktop : undefined;
  const [available, setAvailable] = useState<string | null>(null);
  const [current, setCurrent] = useState(desktop?.version ?? "dev");
  const [checking, setChecking] = useState(false);
  const [changelog, setChangelog] =
    useState<UpdatesVm["changelog"]>(null);
  const [stage, setStage] = useState<UpdateStage>("idle");
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Progress arrives from the main process, which owns the download.
  useEffect(() => {
    const updates = desktop?.updates;
    if (!updates) return;
    return updates.onProgress((progress) => {
      setStage(progress.phase);
      setPercent(progress.percent);
      setError(progress.phase === "error" ? (progress.message ?? "") : null);
    });
  }, [desktop]);

  const check = useCallback(
    (force = false) => {
      const updates = desktop?.updates;
      if (!updates) return;
      setChecking(true);
      void updates
        .check(force)
        .then((status) => {
          setCurrent(status.current);
          setAvailable(status.available ? status.latest : null);
        })
        // A failed check is not the user's problem: they did not ask for it,
        // and the app is unaffected. The button simply does not appear.
        .catch(() => undefined)
        .finally(() => setChecking(false));
    },
    [desktop]
  );

  useEffect(() => {
    check();
    const timer = setInterval(() => check(), RECHECK_MS);
    return () => clearInterval(timer);
  }, [check]);

  // The one-shot changelog: asked for once per launch, and only answered
  // when the version actually changed since the last run.
  useEffect(() => {
    const updates = desktop?.updates;
    if (!updates) return;
    void updates
      .changelog()
      .then((entry) => setChangelog(entry))
      .catch(() => undefined);
  }, [desktop]);

  const dismissChangelog = useCallback(() => {
    const version = changelog?.version;
    setChangelog(null);
    if (version) void desktop?.updates.acknowledge(version).catch(() => undefined);
  }, [changelog, desktop]);

  const download = useCallback(() => {
    void desktop?.updates.download().catch(() => undefined);
  }, [desktop]);

  /**
   * Fetches and runs the installer in place. The app quits once the
   * installer is up — NSIS cannot replace files this process holds open —
   * so there is no success state to render here.
   */
  const install = useCallback(() => {
    const updates = desktop?.updates;
    if (!updates) return;
    setStage("downloading");
    setPercent(0);
    setError(null);
    void updates.install().catch((cause: unknown) => {
      setStage("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [desktop]);

  return {
    available,
    current,
    changelog,
    checking,
    stage,
    percent,
    error,
    install,
    download,
    check: () => check(true),
    dismissChangelog,
  };
}
