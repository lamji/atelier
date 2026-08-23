import { NextResponse } from "next/server";

/**
 * Sends a visitor to the installer for their platform.
 *
 * It resolves the asset through the GitHub API rather than linking a file
 * name, because the name carries the version (Atelier-Setup-1.0.27.exe) and
 * a hard-coded link would go stale on every release. GitHub's
 * `/releases/latest/download/<name>` shortcut has the same problem — it
 * still needs the exact name. Asking for the latest release and matching by
 * extension means a new release is downloadable the moment it is published,
 * with nothing here to update.
 */
const REPO = "lamji/atelier";

/** Extensions that identify an installer for each platform, best first. */
const ASSET_SUFFIXES: Record<string, string[]> = {
  windows: [".exe"],
  macos: [".dmg", "-mac.zip"],
  linux: [".AppImage", ".deb"],
};

const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface Release {
  tag_name?: string;
  assets?: ReleaseAsset[];
  html_url?: string;
}

/** A release is cached for a few minutes; publishing is not a hot path. */
export const revalidate = 300;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;
  const suffixes = ASSET_SUFFIXES[platform];
  if (!suffixes) {
    return plain(`Unknown platform "${platform}".`, 404);
  }

  let release: Release;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: { Accept: "application/vnd.github+json" },
        next: { revalidate },
      }
    );
    if (!response.ok) {
      // 404 here means no release has been published yet, which is a
      // different thing to tell someone than "it broke".
      return plain(
        response.status === 404
          ? "No release has been published yet. Check back shortly."
          : `GitHub returned ${response.status} asking for the latest release.`,
        response.status === 404 ? 404 : 502
      );
    }
    release = (await response.json()) as Release;
  } catch {
    return plain("Could not reach GitHub to find the latest release.", 502);
  }

  const assets = release.assets ?? [];
  for (const suffix of suffixes) {
    const asset = assets.find((candidate) => candidate.name.endsWith(suffix));
    if (asset) return NextResponse.redirect(asset.browser_download_url, 302);
  }

  // The release exists but carries nothing for this platform — true today
  // for macOS and Linux, which are not built yet. Send them to the release
  // page rather than a dead end.
  const label = PLATFORM_LABELS[platform] ?? platform;
  return release.html_url
    ? NextResponse.redirect(release.html_url, 302)
    : plain(`No ${label} build in the latest release yet.`, 404);
}

function plain(message: string, status: number): NextResponse {
  return new NextResponse(`${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
