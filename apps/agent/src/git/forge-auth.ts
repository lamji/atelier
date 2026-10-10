import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import type { GitForge, GitForgeAuthSource } from "@atelier/protocol";

/**
 * Where a forge credential can be found without ever asking the user for
 * one.
 *
 * API credentials can live in `gh`, the environment, or git's HTTPS
 * credential helper. An SSH checkout is different: its key can access a
 * private repository while every available API token belongs to another
 * account. This module exhausts the API-capable sources; the caller then
 * compares the SSH and API identities before reporting why requests cannot
 * be listed.
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
 * Browser-safe ids for credential selection. A per-process HMAC keeps the
 * actual token and even its reusable hash out of bridge traffic.
 */
const CREDENTIAL_ID_KEY = randomBytes(32);

export function forgeCredentialId(auth: ForgeAuth): string {
  return createHmac("sha256", CREDENTIAL_ID_KEY)
    .update(auth.token)
    .digest("base64url")
    .slice(0, 24);
}

/**
 * Found credentials are cached for the process: they are stable, and the
 * account plus helper probes should not repeat every 90 seconds. A
 * *missing* one is cached only briefly — the user signing in elsewhere
 * is exactly the case this pane must notice on its own.
 */
const MISS_TTL_MS = 120_000;

interface CacheEntry {
  auth: ForgeAuth[];
  at: number;
  host: string;
}

const cache = new Map<string, CacheEntry>();

const keyOf = (forge: GitForge, host: string, repo: string) =>
  `${forge}:${host.toLowerCase()}:${repo.toLowerCase()}`;

/**
 * Every credential that may answer for one repository, in priority order.
 *
 * Returning the whole ladder matters in a company workspace: `gh` can be
 * signed into one account while git's credential helper holds a different
 * repository-scoped account. A 404 from the first token is not proof that
 * the selected repository is invisible to all of them.
 */
export async function forgeAuthCandidates(
  root: string,
  forge: GitForge,
  host: string,
  repo: string
): Promise<ForgeAuth[]> {
  const normalizedHost = host.toLowerCase();
  const key = keyOf(forge, normalizedHost, repo);
  const hit = cache.get(key);
  if (hit && (hit.auth.length > 0 || Date.now() - hit.at < MISS_TTL_MS)) {
    return hit.auth;
  }

  const discovered = [
    // A token the user just added leads: they chose it for this repository
    // seconds ago, which is a stronger signal than anything discovered.
    ...storedFor(normalizedHost),
    envToken(forge, host),
    ...(await cliTokens(root, forge, host)),
    ...(await helperTokens(root, host, repo)),
  ].filter((auth): auth is ForgeAuth => auth !== null);
  const seen = new Set<string>();
  const auth = discovered.filter((candidate) => {
    if (seen.has(candidate.token)) return false;
    seen.add(candidate.token);
    return true;
  });
  cache.set(key, { auth, at: Date.now(), host: normalizedHost });
  return auth;
}

/**
 * Where a user-added token is kept between runs.
 *
 * Installed by the runtime, which owns the settings table — the same table
 * that already holds provider credentials, so this is not a new secret
 * store. Absent in tests and smokes, where an added token simply lives for
 * the process.
 *
 * The first attempt at this deliberately kept added tokens in memory only,
 * on the reasoning that gh should own them. gh turned out to REFUSE tokens
 * it dislikes the scopes of — which is most fine-grained PATs — so "gh owns
 * it" quietly meant "nothing owns it", and the account the user had just
 * added was gone at the next restart.
 */
export interface ForgeTokenStore {
  read(host: string): ForgeAuth[];
  write(host: string, auth: ForgeAuth): void;
  remove(host: string, token: string): void;
}

let store: ForgeTokenStore | null = null;
/** Fallback when no store is installed: this process only. */
const session = new Map<string, ForgeAuth[]>();

export function setForgeTokenStore(next: ForgeTokenStore): void {
  store = next;
}

function storedFor(host: string): ForgeAuth[] {
  const key = host.toLowerCase();
  if (store) {
    try {
      return store.read(key);
    } catch {
      return session.get(key) ?? [];
    }
  }
  return session.get(key) ?? [];
}

export function rememberForgeToken(
  host: string,
  token: string,
  login?: string
): void {
  const key = host.toLowerCase();
  const auth: ForgeAuth = { token, source: "stored", login };
  if (store) {
    try {
      store.write(key, auth);
      clearForgeAuth(host);
      return;
    } catch {
      // Fall through to the in-memory copy rather than losing it entirely.
    }
  }
  const existing = session.get(key) ?? [];
  if (!existing.some((entry) => entry.token === token)) {
    session.set(key, [...existing, auth]);
  }
  clearForgeAuth(host);
}

/** Drops a stored token — the picker's "forget this account". */
export function forgetForgeToken(host: string, token: string): void {
  const key = host.toLowerCase();
  if (store) {
    try {
      store.remove(key, token);
    } catch {
      // Nothing to do; the in-memory copy is cleared below either way.
    }
  }
  session.set(key, (session.get(key) ?? []).filter((a) => a.token !== token));
  clearForgeAuth(host);
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
  const normalizedHost = host.toLowerCase();
  for (const [key, entry] of cache) {
    if (entry.host === normalizedHost) cache.delete(key);
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
 * Every token the forge CLI is holding for this host. GitHub CLI can keep
 * several accounts at once; the active account for repo A is not necessarily
 * the account whose SSH key or organization access owns repo B.
 */
async function cliTokens(
  root: string,
  forge: GitForge,
  host: string
): Promise<ForgeAuth[]> {
  if (forge === "github") {
    const status = await runProbe(
      "gh",
      ["auth", "status", "--hostname", host],
      root
    );
    const logins = [
      ...new Set(
        [...status.out.matchAll(/Logged in to \S+ (?:as|account) (\S+)/g)]
          .map((match) => match[1] ?? "")
          .filter(Boolean)
      ),
    ];
    const found: ForgeAuth[] = [];
    for (const login of logins) {
      const probe = await runProbe(
        "gh",
        ["auth", "token", "--hostname", host, "--user", login],
        root
      );
      const token = firstLine(probe.out);
      if (probe.code === 0 && isTokenish(token)) {
        found.push({ token, source: "cli-token", login });
      }
    }
    // Older gh versions may return a token but not name the account in
    // `auth status`; keep that compatibility path after account probing.
    if (found.length === 0) {
      const probe = await runProbe(
        "gh",
        ["auth", "token", "--hostname", host],
        root
      );
      const token = firstLine(probe.out);
      if (probe.code === 0 && isTokenish(token)) {
        found.push({ token, source: "cli-token" });
      }
    }
    return found;
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
      return [{ token, source: "cli-token" }];
    }
  }
  return [];
}

/**
 * git's HTTPS credential helper — the Windows credential manager, macOS
 * keychain, `store`, whatever is configured. For an HTTPS remote this may
 * be the credential used to push; SSH remotes authenticate with a key and
 * are diagnosed separately by the request-list caller.
 */
async function helperTokens(
  root: string,
  host: string,
  repo: string
): Promise<ForgeAuth[]> {
  const requests = [
    `protocol=https\nhost=${host}\npath=${repo}\n\n`,
    `protocol=https\nhost=${host}\npath=${repo}.git\n\n`,
    `protocol=https\nhost=${host}\n\n`,
  ];
  const found: ForgeAuth[] = [];
  const seen = new Set<string>();
  for (const stdin of requests) {
    const probe = await runProbe("git", ["credential", "fill"], root, stdin);
    if (probe.code !== 0) continue;
    const fields = new Map<string, string>();
    for (const line of probe.out.split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
    const token = fields.get("password") ?? "";
    if (!isTokenish(token) || seen.has(token)) continue;
    seen.add(token);
    const user = fields.get("username") ?? "";
    // Helpers park a placeholder in `username` when the password IS the
    // token; showing "PersonalAccessToken" as the account helps nobody.
    const login = /token|oauth|^x-access-token$/i.test(user) ? "" : user;
    found.push({
      token,
      source: "credential-helper",
      ...(login ? { login } : {}),
    });
  }
  return found;
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
