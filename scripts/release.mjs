/**
 * One command to cut a release: bump, build, tag, publish.
 *
 *   npm run release            # 1.0.27 -> 1.0.28
 *   npm run release -- minor   # 1.0.27 -> 1.1.0
 *   npm run release -- 2.0.0   # explicit
 *   npm run release -- --dry-run     # say what would happen, change nothing
 *   npm run release -- --no-publish  # bump, build and tag; upload by hand
 *   npm run release -- --allow-unsigned  # ship a SmartScreen warning on purpose
 *
 * The version lives in apps/desktop/package.json — electron-builder reads it
 * for the artifact name, and the git tag follows it, so those three can never
 * drift apart.
 *
 * Every release is signed. The build is not started without a signing
 * credential, and the installer is not tagged or published until Windows
 * itself confirms the signature on it — see apps/desktop/scripts/signing.mjs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmArgs } from "../apps/desktop/scripts/package-manager.mjs";
import { resolveSigning, verifySignature } from "../apps/desktop/scripts/signing.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopManifest = path.join(repoRoot, "apps", "desktop", "package.json");
const releaseDir = path.join(repoRoot, "apps", "desktop", "release");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const publish = !args.includes("--no-publish");
const allowUnsigned = args.includes("--allow-unsigned");
const bump = args.find((arg) => !arg.startsWith("--")) ?? "patch";

function say(message) {
  console.log(`[release] ${message}`);
}

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

/**
 * Runs a command, showing its output; returns false instead of throwing.
 *
 * `shell` is opt-in per call, not a Windows default. A shell concatenates
 * argv instead of passing it, so anything containing a space is split —
 * which quietly turned `--pretty=format:- %s` into two arguments and made
 * git reject "%s" as a revision. Only .cmd shims (corepack, pnpm) actually
 * need one; git.exe and gh.exe do not.
 */
function run(cmd, cmdArgs, opts = {}) {
  if (dryRun) {
    say(`would run: ${cmd} ${cmdArgs.join(" ")}`);
    return true;
  }
  const result = spawnSync(cmd, cmdArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    ...opts,
  });
  return result.status === 0;
}

/** Captured output, or null when the command is missing or fails. */
function capture(cmd, cmdArgs) {
  try {
    return execFileSync(cmd, cmdArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      // stderr swallowed: probing for something absent (a tag that does not
      // exist yet, gh on a machine without it) is a question, not an error,
      // and its complaint on the console reads like a failed release.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function nextVersion(current, how) {
  if (/^\d+\.\d+\.\d+/.test(how)) return how;
  const [major, minor, patch] = current.split(".").map(Number);
  if (how === "major") return `${major + 1}.0.0`;
  if (how === "minor") return `${major}.${minor + 1}.0`;
  if (how === "patch") return `${major}.${minor}.${patch + 1}`;
  fail(`unknown bump "${how}" — use patch, minor, major, or an exact version`);
}

// ── preflight ────────────────────────────────────────────────────────────
// Everything that can stop a release is checked BEFORE the twelve-minute
// build, not after it.
const manifest = JSON.parse(fs.readFileSync(desktopManifest, "utf8"));
const current = manifest.version;
const version = nextVersion(current, bump);
const tag = `v${version}`;

say(`${current} -> ${version}${dryRun ? "  (dry run)" : ""}`);

if (capture("git", ["rev-parse", "--is-inside-work-tree"]) !== "true") {
  fail("not a git repository");
}
if (capture("git", ["tag", "--list", tag])) {
  fail(`tag ${tag} already exists — pick another version`);
}
if (publish) {
  if (!capture("gh", ["--version"])) {
    fail("the GitHub CLI is required to publish. Install gh, or pass --no-publish");
  }
  if (spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status !== 0) {
    fail("gh is not signed in — run `gh auth login`, or pass --no-publish");
  }
}

/**
 * Signing is decided here, not after the build.
 *
 * electron-builder signs when a credential is in the environment and quietly
 * does not when it is absent — the difference between a download Windows
 * accepts and one that opens "Windows protected your PC" on every machine
 * that fetches it. Finding that out at the end costs a build; finding it out
 * here costs a sentence.
 */
const signing = resolveSigning();
if (signing.problems.length) {
  fail(
    `signing is half-configured (${signing.mode}):\n` +
      signing.problems.map((problem) => `  - ${problem}`).join("\n")
  );
}
for (const warning of signing.warnings) say(`note: ${warning}`);
if (signing.mode === "none") {
  if (!allowUnsigned) {
    fail(
      "no signing credential — refusing to build an installer nobody can run " +
        "without clicking past SmartScreen.\n" +
        "  Azure Trusted Signing: AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, " +
        "AZURE_SIGN_PROFILE + AZURE_TENANT_ID/AZURE_CLIENT_ID/AZURE_CLIENT_SECRET\n" +
        "  Certificate file:      CSC_LINK (.pfx path or its base64) + CSC_KEY_PASSWORD\n" +
        "  See docs/code-signing.md. To publish unsigned anyway, pass --allow-unsigned."
    );
  }
  say("WARNING: --allow-unsigned — SmartScreen will warn everyone who downloads this");
} else {
  say(`signing: ${signing.label}`);
}

const dirty = capture("git", ["status", "--porcelain"]);
if (dirty) {
  // Not fatal: the version bump is a commit of its own and everything else
  // stays where it is. Worth saying out loud, because what ships is the
  // WORKING TREE, not the last commit.
  const count = dirty.split("\n").filter(Boolean).length;
  say(`note: ${count} uncommitted change(s) — the build ships your working tree`);
}

// ── bump ─────────────────────────────────────────────────────────────────
if (!dryRun) {
  fs.writeFileSync(
    desktopManifest,
    JSON.stringify({ ...manifest, version }, null, 2) + "\n",
    "utf8"
  );
}
say(
  dryRun
    ? `would set apps/desktop/package.json to ${version}`
    : `apps/desktop/package.json set to ${version}`
);

// ── build ────────────────────────────────────────────────────────────────
say("building the installer (this takes a few minutes)…");
// Trailing arguments ride through `pnpm run` to the last command in the
// script — electron-builder — which is how the Azure signing options reach
// it without a static config file having to name one signer forever.
const dist = pnpmArgs(["--filter", "@atelier/desktop", "dist", ...signing.builderArgs]);
// The one call that needs a shell: pnpm/corepack are .cmd shims on Windows.
if (!run(dist.cmd, dist.args, { shell: process.platform === "win32" })) {
  // Leave the bump in place: the next attempt reuses it rather than
  // skipping a version number on every failed build.
  fail("the build failed — version left at " + version + ", nothing tagged");
}

const artifact = path.join(releaseDir, `Atelier-Setup-${version}.exe`);
if (!dryRun && !fs.existsSync(artifact)) {
  fail(`the build finished but ${path.basename(artifact)} is missing`);
}
/**
 * A second copy under a name with no version in it.
 *
 * GitHub's /releases/latest/download/<name> shortcut needs the EXACT asset
 * name, so a versioned file can never be fetched from a stable URL — and a
 * stable URL is the whole point of
 *
 *   curl -L https://github.com/lamji/atelier/releases/latest/download/Atelier-Setup.exe
 *
 * Both are uploaded: the versioned one so an old release stays identifiable
 * after download, and this one so scripts have something durable to point
 * at.
 */
const stableName = "Atelier-Setup.exe";
const stableArtifact = path.join(releaseDir, stableName);

/** The hash people can check a download against. */
function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

let digest = "";
if (!dryRun) {
  const mb = Math.round(fs.statSync(artifact).size / 1024 / 1024);
  digest = sha256(artifact);
  fs.copyFileSync(artifact, stableArtifact);
  say(`built ${path.basename(artifact)} (${mb} MB)`);
  say(`sha256 ${digest}`);
}

/**
 * Whether this build carries an Authenticode signature — asked of Windows,
 * not inferred from the environment.
 *
 * "A credential was present" and "this exe is signed" are different claims,
 * and every way they can come apart (a signer that failed and was swallowed,
 * a certificate that expired, a chain the machine will not trust) ends the
 * same way: a release whose whole download experience is the dialog signing
 * was supposed to remove. So the artifact is verified before anything is
 * tagged, while the only thing that has been spent is the build.
 */
let signature = { checked: false, valid: false, status: "not built", message: "", subject: "", timestamped: false };
if (!dryRun) {
  signature = verifySignature(artifact);
  if (signature.valid) {
    say(`signed by ${signature.subject}${signature.timestamped ? " (timestamped)" : ""}`);
    if (!signature.timestamped) {
      say("note: no RFC 3161 countersignature — this signature dies with the certificate");
    }
  } else if (allowUnsigned) {
    say(`WARNING: unsigned build (${signature.status}) — publishing it anyway`);
  } else {
    fail(
      `the installer is not validly signed: ${signature.status}` +
        (signature.message ? ` — ${signature.message}` : "") +
        `\n  ${path.basename(artifact)} is on disk and the version is bumped, ` +
        "but nothing has been tagged or published.\n" +
        "  Fix the signing setup (docs/code-signing.md) and run the release again."
    );
  }
} else {
  say(
    signing.mode === "none"
      ? "would build unsigned and publish it anyway (--allow-unsigned)"
      : "would refuse to tag unless Windows reports a valid signature on the installer"
  );
}
const signed = signature.valid;

// ── tag ──────────────────────────────────────────────────────────────────
run("git", ["add", "--", "apps/desktop/package.json"]);
run("git", ["commit", "-m", `Release ${version}`]);
run("git", ["tag", "-a", tag, "-m", `Atelier ${version}`]);
say(dryRun ? `would tag ${tag}` : `committed and tagged ${tag}`);

// ── publish ──────────────────────────────────────────────────────────────
if (!publish) {
  say("skipping publish (--no-publish). To do it later:");
  say(`  gh release create ${tag} "${artifact}" --title "Atelier ${version}"`);
  process.exit(0);
}

// Release notes are the commits since the last tag: what actually changed,
// written by the people who changed it.
const previous = capture("git", [
  "describe",
  "--tags",
  "--abbrev=0",
  dryRun ? "HEAD" : `${tag}^`,
]);
const range = previous ? `${previous}..HEAD` : "HEAD";
const log =
  capture("git", ["log", "--no-merges", "--pretty=format:- %s", range]) ?? "";
const notes = [
  `Windows installer for Atelier ${version}.`,
  "",
  "### Download",
  "",
  "```",
  `curl -L https://github.com/lamji/atelier/releases/latest/download/${stableName} -o ${stableName}`,
  "```",
  "",
  "`" + stableName + "` and `" + path.basename(artifact) + "` are the same " +
    "file — the first has a stable URL for scripts, the second stays " +
    "identifiable once downloaded.",
  "",
  "### Verify",
  "",
  "```",
  `sha256: ${digest}`,
  "```",
  "",
  "PowerShell: `Get-FileHash " + stableName + " -Algorithm SHA256`",
  "",
  signed
    ? `This build is code-signed by \`${signature.subject}\`` +
      (signature.timestamped ? " and timestamped" : "") +
      ", so Windows runs it without a SmartScreen warning:\n\n" +
      "```\n" +
      `Get-AuthenticodeSignature ${stableName} | Format-List Status, SignerCertificate\n` +
      "```"
    : "**This build is not code-signed**, so SmartScreen will warn: choose " +
      "*More info* → *Run anyway*. Check the SHA-256 above before running it.",
  "",
  "The installer checks for the tools Atelier needs (git, Node.js) and " +
    "offers to install any that are missing.",
  "",
  log ? "### Changes\n\n" + log : "",
].join("\n");
const notesFile = path.join(releaseDir, `notes-${version}.md`);
if (!dryRun) fs.writeFileSync(notesFile, notes, "utf8");

run("git", ["push", "origin", "HEAD"]);
run("git", ["push", "origin", tag]);

// The checksum file is an asset too: a hash inside release notes cannot be
// verified by a script, and a script is what downloads this.
const sumsFile = path.join(releaseDir, "SHA256SUMS.txt");
if (!dryRun) {
  fs.writeFileSync(
    sumsFile,
    `${digest}  ${stableName}\n${digest}  ${path.basename(artifact)}\n`,
    "utf8"
  );
}

if (
  !run("gh", [
    "release",
    "create",
    tag,
    artifact,
    stableArtifact,
    sumsFile,
    "--title",
    `Atelier ${version}`,
    "--notes-file",
    notesFile,
  ])
) {
  fail(`the upload failed — the tag is pushed, retry with:\n` +
    `  gh release create ${tag} "${artifact}" --notes-file "${notesFile}"`);
}

say(
  dryRun
    ? `dry run finished — nothing was changed, built, tagged or published`
    : `published https://github.com/lamji/atelier/releases/tag/${tag}`
);
