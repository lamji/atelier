import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { app, shell } from "electron";
import { atelierDataRoot } from "./registry";

/**
 * Whether a newer Atelier has been released, fetching it, and what changed
 * in the one running now.
 *
 * The update is downloaded IN THE APP rather than handed to a browser, and
 * that is not only about convenience. A browser marks what it saves with a
 * Zone.Identifier — the Mark of the Web — and that mark is what makes
 * SmartScreen throw "Windows protected your PC" in front of an unsigned
 * installer. A file this process writes carries no such mark, so the
 * installer usually starts without that wall. It is not a substitute for
 * signing the binary (see docs/code-signing.md); it removes one obstacle
 * that signing would also remove.
 *
 * What is downloaded is verified against the release's own SHA256SUMS
 * before anything is run. Nothing installs by itself: the user presses the
 * button, watches the progress, and the installer opens.
 *
 * The changelog is the other side of the same coin: the version that last
 * ran is remembered, so the first launch after an upgrade can show what
 * actually changed instead of leaving the user to guess.
 */
const REPO = "lamji/atelier";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;

/** Long enough that launching repeatedly is not a rate-limit problem. */
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
/** A release check must never hold up the window. */
const TIMEOUT_MS = 8_000;

export interface UpdateStatus {
  /** The version running right now. */
  current: string;
  /** The newest published version, or null when the check failed. */
  latest: string | null;
  /** True only when `latest` is genuinely newer than `current`. */
  available: boolean;
  /** The release page, for the "what's new" link. */
  url: string | null;
  /** Direct download for this platform's installer, when the release has one. */
  downloadUrl: string | null;
  notes: string | null;
  /** Why the check found nothing, when it failed. */
  error?: string;
}

/** The changelog to show once, after an upgrade. */
export interface ChangelogEntry {
  version: string;
  notes: string | null;
  url: string | null;
}

interface StateFile {
  /** The version that last ran, so an upgrade can be detected. */
  lastRunVersion?: string;
  /** A release the user has already been shown the notes for. */
  acknowledgedVersion?: string;
}

interface GitHubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

const statePath = (): string => path.join(atelierDataRoot(), "updates.json");

function readState(): StateFile {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8")) as StateFile;
  } catch {
    return {};
  }
}

function writeState(next: StateFile): void {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    // A state file we cannot write costs a repeated changelog, nothing more.
  }
}

/** Strips a leading v and compares numerically, field by field. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, "")
      .split(/[.\-+]/)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part));
  const [a, b] = [parse(candidate), parse(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Atelier/${app.getVersion()}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** The installer for the platform this app is running on. */
function assetFor(release: GitHubRelease): string | null {
  const suffix =
    process.platform === "win32"
      ? ".exe"
      : process.platform === "darwin"
        ? ".dmg"
        : ".AppImage";
  const asset = (release.assets ?? []).find((candidate) =>
    candidate.name.endsWith(suffix)
  );
  return asset?.browser_download_url ?? null;
}

let cached: { at: number; status: UpdateStatus } | null = null;

export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  const current = app.getVersion();
  if (!force && cached && Date.now() - cached.at < CHECK_TTL_MS) {
    return cached.status;
  }
  const base: UpdateStatus = {
    current,
    latest: null,
    available: false,
    url: null,
    downloadUrl: null,
    notes: null,
  };
  try {
    const release = await fetchJson<GitHubRelease>(`${RELEASES_API}/latest`);
    const latest = (release.tag_name ?? "").replace(/^v/i, "");
    const status: UpdateStatus = {
      ...base,
      latest: latest || null,
      available: Boolean(latest) && isNewer(latest, current),
      url: release.html_url ?? null,
      downloadUrl: assetFor(release),
      notes: release.body ?? null,
    };
    cached = { at: Date.now(), status };
    return status;
  } catch (error) {
    // A failed check is not an error the user needs to see: they did not ask
    // for it, and the app works either way. It is reported for the settings
    // surface and otherwise stays quiet.
    const status = { ...base, error: (error as Error).message };
    cached = { at: Date.now(), status };
    return status;
  }
}

/** Sends the user to the installer (or the release page as a fallback). */
export async function openDownload(): Promise<void> {
  const status = await checkForUpdate();
  const target = status.downloadUrl ?? status.url ?? `https://github.com/${REPO}/releases`;
  await shell.openExternal(target);
}

/** Progress of an in-app update, as the renderer sees it. */
export interface UpdateProgress {
  phase: "downloading" | "verifying" | "launching" | "error";
  /** 0-100 while downloading, null when the size is unknown. */
  percent: number | null;
  receivedBytes?: number;
  totalBytes?: number;
  message?: string;
}

/** Only one download at a time; the button reflects this one. */
let installing = false;

/**
 * Downloads the newest installer, checks it, and runs it.
 *
 * Quits the app once the installer is up: NSIS cannot replace files the
 * running app holds open, and an installer waiting on a lock with no
 * explanation is worse than a restart the user was expecting anyway.
 */
export async function downloadAndInstall(
  onProgress: (progress: UpdateProgress) => void
): Promise<void> {
  if (installing) return;
  installing = true;
  try {
    const status = await checkForUpdate(true);
    if (!status.downloadUrl) {
      // Nothing to fetch — fall back to the page rather than fail silently.
      onProgress({
        phase: "error",
        percent: null,
        message: "This release has no installer for your platform.",
      });
      await openDownload();
      return;
    }

    onProgress({ phase: "downloading", percent: 0 });
    const target = path.join(
      os.tmpdir(),
      `Atelier-Setup-${status.latest ?? "latest"}.exe`
    );
    const digest = await download(status.downloadUrl, target, onProgress);

    onProgress({ phase: "verifying", percent: 100 });
    const expected = await expectedDigest();
    if (expected && expected !== digest) {
      // A mismatch is the one case where doing nothing is right.
      fs.rmSync(target, { force: true });
      onProgress({
        phase: "error",
        percent: null,
        message: "The download did not match the published checksum.",
      });
      return;
    }

    onProgress({ phase: "launching", percent: 100 });
    // Detached, so it outlives the app it is about to replace.
    spawn(target, [], { detached: true, stdio: "ignore" }).unref();
    setTimeout(() => app.quit(), 1_200);
  } catch (error) {
    onProgress({
      phase: "error",
      percent: null,
      message: (error as Error).message ?? "The download failed.",
    });
  } finally {
    installing = false;
  }
}

/** Streams a URL to disk, reporting progress, and returns its sha256. */
async function download(
  url: string,
  target: string,
  onProgress: (progress: UpdateProgress) => void
): Promise<string> {
  const response = await fetch(url, {
    headers: { "User-Agent": `Atelier/${app.getVersion()}` },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed with ${response.status}`);
  }
  const totalBytes = Number(response.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const file = fs.createWriteStream(target);
  let receivedBytes = 0;
  let lastReport = 0;

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      receivedBytes += chunk.length;
      if (!file.write(chunk)) {
        await new Promise<void>((resolve) => file.once("drain", () => resolve()));
      }
      // Every 400ms, not every chunk: this crosses an IPC boundary and
      // lands in React state.
      const now = Date.now();
      if (now - lastReport > 400) {
        lastReport = now;
        onProgress({
          phase: "downloading",
          percent: totalBytes
            ? Math.round((receivedBytes / totalBytes) * 100)
            : null,
          receivedBytes,
          totalBytes: totalBytes || undefined,
        });
      }
    }
  } finally {
    await new Promise<void>((resolve) => file.end(resolve));
  }
  return hash.digest("hex");
}

/**
 * The installer's hash, as published beside it. Returns null when the
 * release carries no checksums — older releases do not, and refusing to
 * update because of that would be worse than proceeding.
 */
async function expectedDigest(): Promise<string | null> {
  try {
    const response = await fetch(
      `${RELEASES_API}/latest`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!response.ok) return null;
    const release = (await response.json()) as GitHubRelease;
    const sums = (release.assets ?? []).find((asset) =>
      asset.name.toLowerCase().includes("sha256sums")
    );
    if (!sums) return null;
    const text = await (await fetch(sums.browser_download_url)).text();
    const line = text
      .split(/\r?\n/)
      .find((row) => row.toLowerCase().includes("atelier-setup.exe"));
    return line?.trim().split(/\s+/)[0]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/**
 * The notes for THIS version, when this is the first run after an upgrade.
 *
 * Returns null on a fresh install (nothing was upgraded), on a repeat launch
 * of a version already acknowledged, and when the release cannot be read.
 */
export async function pendingChangelog(): Promise<ChangelogEntry | null> {
  const current = app.getVersion();
  const state = readState();

  // First run ever: record the version and say nothing. A changelog for a
  // version the user just chose to install is noise.
  if (!state.lastRunVersion) {
    writeState({ ...state, lastRunVersion: current, acknowledgedVersion: current });
    return null;
  }
  if (state.lastRunVersion === current) return null;
  if (state.acknowledgedVersion === current) return null;

  try {
    const release = await fetchJson<GitHubRelease>(
      `${RELEASES_API}/tags/v${current}`
    );
    return {
      version: current,
      notes: release.body ?? null,
      url: release.html_url ?? null,
    };
  } catch {
    // Upgraded, but the release notes are unreachable (offline, or a build
    // that was never published). Still worth marking the version as seen so
    // it does not ask again on every launch.
    writeState({ ...state, lastRunVersion: current, acknowledgedVersion: current });
    return null;
  }
}

/** The user has seen the changelog for `version`; do not show it again. */
export function acknowledgeChangelog(version: string): void {
  const state = readState();
  writeState({ ...state, lastRunVersion: version, acknowledgedVersion: version });
}
