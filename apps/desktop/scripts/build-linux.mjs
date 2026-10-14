// Builds the Linux packages (AppImage + deb) inside a Linux container.
//
//   node apps/desktop/scripts/build-linux.mjs     (Docker must be running)
//
// The backend ships native modules (better-sqlite3, node-pty, sqlite-vec,
// sharp, onnxruntime) that must be the Linux builds, so the whole pipeline
// runs on Linux rather than cross-packing from Windows. The source is the
// committed HEAD (`git archive`), the same tree a tag points at; the
// packages land in apps/desktop/release/linux/.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const outDir = path.join(desktopRoot, "release", "linux");
const IMAGE = "electronuserland/builder:20";

/** Shared libraries Electron needs to start, even as plain Node. */
const ELECTRON_LIBS = [
  "libnss3", "libatk1.0-0", "libatk-bridge2.0-0", "libcups2", "libdrm2",
  "libgtk-3-0", "libgbm1", "libasound2", "libxss1", "libxshmfence1",
  "libxkbcommon0", "libxcomposite1", "libxdamage1", "libxrandr2",
];

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-linux-"));
const tarball = path.join(stage, "src.tar");
execFileSync("git", ["archive", "--format=tar", "-o", tarball, "HEAD"], {
  cwd: repoRoot,
});
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const steps = [
  "set -e",
  "apt-get update -qq",
  `apt-get install -y -qq ${ELECTRON_LIBS.join(" ")} >/dev/null`,
  "mkdir -p /w && tar -xf /src/src.tar -C /w && cd /w",
  "corepack enable",
  "pnpm install --frozen-lockfile",
  "cd apps/desktop",
  "node scripts/bundle.mjs",
  "node scripts/build-backend.mjs",
  "node scripts/build-icon.mjs",
  "npx electron-builder --config electron-builder.yml --linux --x64 --publish never",
  "cp release/*.AppImage release/*.deb /out/",
];

const docker = spawnSync(
  "docker",
  [
    "run", "--rm",
    "-v", `${stage}:/src:ro`,
    "-v", `${outDir}:/out`,
    IMAGE,
    "bash", "-c", steps.join(" && "),
  ],
  { stdio: "inherit" },
);
fs.rmSync(stage, { recursive: true, force: true });
if (docker.status !== 0) {
  console.error("[build-linux] the container build failed");
  process.exit(docker.status ?? 1);
}
console.log(`[build-linux] packages in ${outDir}:`);
for (const name of fs.readdirSync(outDir)) console.log(`  ${name}`);
