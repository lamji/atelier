import { spawn } from "node:child_process";
import type { GitForge, GitForgeAuthSource } from "@atelier/protocol";

/**
 * Where a forge credential can be found without ever asking the user for
 * one.
 *
 * The premise: if the user can push, they are already authenticated to
 * this forge — the credential is sitting in `gh`, in the environment, or
 * in git's own credential helper. A panel that answers "sign in with
 * `gh auth login`" while the same window is happily listing that repo's
 * changes is telling the user something they know to be false, so this
 * module exhausts every place git itself would look before anything is
 * allowed to say "signed out".
 *
 * Nothing here throws. Every probe is a spawn that can be missing, slow
 * or hostile, and this runs on a 90-second timer.
 */

export interface ForgeAuth {
  token: string;
  source: GitForgeAuthSource;
  /** Account the credential belongs to, when the source volunteered one. */
  login?: string;
}

/** Probes are spawns; none of them may hold the poll open. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * A found credential is cached for the process: it is stable, and three
 * spawns every 90 seconds to re-learn it is three spawns too many. A
 * *missing* one is cached only briefly — the user signing in elsewhere
 * is exactly the case this pane must notice on its own.
 */
const MISS_TTL_MS = 120_000;

interface CacheEntry {
  auth: ForgeAuth | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

const keyOf = (forge: GitForge, host: string) => `${forge}:${host.toLowerCase()}`;

/**
 * The credential to use for `host`, or null when there genuinely is not
 * one. Order is "most specific first": an explicit token in the
 * environment beats the CLI's, which beats whatever git pushes with.
 */
export async function forgeAuth(
  root: string,
  forge: GitForge,
  host: string
): Promise<ForgeAuth | null> {
  const key = keyOf(forge, host);
  const hit = cache.get(key);
  if (hit && (hit.auth || Date.now() - hit.at < MISS_TTL_MS)) return hit.auth;

  const auth =
    envToken(forge, host) ??
    (await cliToken(root, forge, host)) ??
    (await helperToken(root, host));
  cache.set(key, { auth, at: Date.now() });
  return auth;
}

/**
 * Forget cached credentials — for one host, or all of them. Called on a
 * 401 (the token is stale or scoped wrong, and re-probing may find a
 * better one) and by the pane's Connect button.
 */
export function clearForgeAuth(host?: string): void {
  if (!host) {
    cache.clear();
    return;
  }
  const suffix = `:${host.toLowerCase()}`;
  for (const key of [...cache.keys()]) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
}

/**
 * Tokens CI and shells already agree on. `GH_*`/`GITHUB_*` are what
 * `gh` itself reads, so honouring them keeps this pane consistent with
 * every `gh` command the user runs in the terminal beside it.
 */
function envToken(forge: GitForge, host: string): ForgeAuth | null {
  const dotCom =
    forge === "github"
      ? /^(www\.)?github\.com$/i.test(host)
      : /^(www\.)?gitlab\.com$/i.test(host);
  const names =
    forge === "github"
      ? dotCom
        ? ["GH_TOKEN", "GITHUB_TOKEN"]
        : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_TOKEN"]
      : ["GITLAB_TOKEN", "GL_TOKEN", "GITLAB_ACCESS_TOKEN"];
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return { token: value, source: "env" };
  }
  return null;
}

/**
 * The token the forge's own CLI is holding. Read rather than shelled
 * through, so the REST path below works even where `gh pr list` does
 * not — an old CLI, a missing `--json` field, a broken PATH entry.
 */
async function cliToken(
  root: string,
  forge: GitForge,
  host: string
): Promise<ForgeAuth | null> {
  if (forge === "github") {
    const probe = await runProbe("gh", ["auth", "token", "--hostname", host], root);
    const token = firstLine(probe.out);
    if (probe.code !== 0 || !isTokenish(token)) return null;
    const login = await ghLogin(root, host);
    return { token, source: "cli-token", ...(login ? { login } : {}) };
  }
  // glab has moved this between `config get` spellings across versions;
  // both are cheap and only one of them will answer.
  for (const args of [
    ["config", "get", "token", "--host", host],
    ["config", "get", "-h", host, "token"],
  ]) {
    const probe = await runProbe("glab", args, root);
    const token = firstLine(probe.out);
    if (probe.code === 0 && isTokenish(token)) {
      return { token, source: "cli-token" };
    }
  }
  return null;
}

/**
 * git's own credential helper — the Windows credential manager, macOS
 * keychain, `store`, whatever is configured. This is the credential the
 * user's pushes are already going out with, which makes it the honest
 * answer to "I can see git changes, so I am logged in".
 */
async function helperToken(root: string, host: string): Promise<ForgeAuth | null> {
  const probe = await runProbe(
    "git",
    ["credential", "fill"],
    root,
    `protocol=https\nhost=${host}\n\n`
  );
  if (probe.code !== 0) return null;
  const fields = new Map<string, string>();
  for (const line of probe.out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const token = fields.get("password") ?? "";
  if (!isTokenish(token)) return null;
  const user = fields.get("username") ?? "";
  // Helpers park a placeholder in `username` when the password IS the
  // token; showing "PersonalAccessToken" as the account helps nobody.
  const login = /token|oauth|^x-access-token$/i.test(user) ? "" : user;
  return { token, source: "credential-helper", ...(login ? { login } : {}) };
}

/** The account `gh` is acting as, for the pane's status strip. */
async function ghLogin(root: string, host: string): Promise<string> {
  const { out } = await runProbe("gh", ["auth", "status", "--hostname", host], root);
  // gh has phrased this as "Logged in to github.com as NAME" and
  // "... account NAME" across versions.
  return out.match(/Logged in to \S+ (?:as|account) (\S+)/)?.[1] ?? "";
}

/**
 * Rejects the things a failed probe prints into stdout — help text, a
 * prompt, an error sentence — that would otherwise be spent as a token
 * and come back as a puzzling 401.
 */
function isTokenish(value: string): boolean {
  return value.length >= 8 && value.length <= 500 && !/\s/.test(value);
}

function firstLine(out: string): string {
  return out.split("\n")[0]?.trim() ?? "";
}

/**
 * Spawn, feed optional stdin, and never outlive PROBE_TIMEOUT_MS: `git
 * credential fill` with no helper configured will sit waiting for a
 * username that no one is there to type.
 */
function runProbe(
  cmd: string,
  args: string[],
  cwd: string,
  stdin?: string
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    });
    let out = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      done(-1);
    }, PROBE_TIMEOUT_MS);

    function done(code: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, out: out.trim() });
    }

    child.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (out += d.toString("utf8")));
    // A missing binary arrives here, not as a throw from spawn().
    child.on("error", () => done(-1));
    child.on("close", (code) => done(code ?? -1));
    child.stdin?.on("error", () => {});
    if (stdin !== undefined) child.stdin?.write(stdin);
    child.stdin?.end();
  });
}
