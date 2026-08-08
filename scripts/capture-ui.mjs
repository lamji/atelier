// Capture real screenshots of the running desktop app for the README and the
// GitHub Pages landing page.
//
// It launches a SECOND Electron instance against an isolated profile
// (.atelier-data/capture) so it never touches — or fights the single-instance
// lock of — a dev stack you already have open, then drives that window over
// Chromium's DevTools Protocol: click a rail destination, wait, screenshot.
// CDP rather than Playwright because the driving is a handful of clicks and
// `ws` is already a dependency here.
//
// Usage (from repo root):  node scripts/capture-ui.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const agentRoot = path.join(repoRoot, "apps", "agent");
const webDist = path.join(repoRoot, "apps", "web", "dist");
const outDir = path.join(repoRoot, "docs", "assets");

// Isolated everything: LOCALAPPDATA drives the project registry + per-project
// knowledge DB, --user-data-dir drives Electron's own profile and the
// single-instance lock.
const profile = path.join(repoRoot, ".atelier-data", "capture");
const CDP_PORT = 9333;
const WORKSPACE_TIMEOUT_MS = 240_000;

const desktopRequire = createRequire(path.join(desktopRoot, "package.json"));
const electronBinary = String(desktopRequire("electron"));
const { WebSocket } = desktopRequire("ws");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[capture] ${msg}`);

// ------------------------------------------------------------------ profile
// Same slug rule as apps/desktop/src/main/registry.ts — the record has to
// point at the data dir the app would have chosen itself.
function projectSlug(root) {
  return root
    .replace(/[\\/:]+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .toLowerCase();
}

function seedRegistry() {
  const dataRoot = path.join(profile, "atelier");
  const dataDir = path.join(dataRoot, "projects", projectSlug(repoRoot));
  fs.mkdirSync(dataDir, { recursive: true });
  const record = {
    id: "proj_capture",
    name: path.basename(repoRoot),
    path: repoRoot,
    dataDir,
    addedAt: 1,
    lastOpenedAt: 2,
  };
  fs.writeFileSync(
    path.join(dataRoot, "projects.json"),
    JSON.stringify([record], null, 2),
  );
  // Pre-size the window so every shot has the same 16:10 frame.
  fs.writeFileSync(
    path.join(dataRoot, "desktop-window.json"),
    JSON.stringify({ bounds: { x: 60, y: 40, width: 1600, height: 1000 } }),
  );
  log(`profile seeded -> ${dataRoot}`);
}

// --------------------------------------------------------------------- CDP
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`CDP timeout: ${method}`));
      }, 30_000);
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? "eval failed");
    }
    return res.result?.value;
  }

  async shot(name) {
    const { data } = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const file = path.join(outDir, name);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    // A PNG cannot be read back here, so record what was on screen: enough
    // to tell a populated workspace from an empty shell without opening it.
    const text = await this.eval(
      `(document.documentElement.dataset.theme ?? '?') + ' | ' +
        document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 500)`,
    );
    fs.appendFileSync(
      path.join(profile, "shots.log"),
      `${name}\n  ${text}\n\n`,
    );
    log(`shot ${name} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  }
}

async function pageTarget() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  const targets = await res.json();
  return targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

async function waitForTarget(deadline) {
  while (Date.now() < deadline) {
    try {
      const target = await pageTarget();
      if (target) return target;
    } catch {
      // devtools endpoint not up yet
    }
    await sleep(500);
  }
  throw new Error("Electron never exposed a CDP page target");
}

// -------------------------------------------------------------- UI driving
const clickByLabel = (label) => `(() => {
  const el = document.querySelector('[aria-label=${JSON.stringify(label)}]');
  if (!el) return false;
  el.click();
  return true;
})()`;

async function click(cdp, label, settleMs = 1800) {
  const ok = await cdp.eval(clickByLabel(label));
  if (!ok) log(`! no element labelled "${label}" — skipped`);
  await sleep(settleMs);
  return ok;
}

/** React ignores a plain .value assignment; go through the native setter. */
const typeInComposer = (text) => `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(text)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`;

/**
 * The theme persists in the capture profile's localStorage, so the run that
 * ended in light used to start the next one in light — and every "dark" shot
 * came out light. Drive it to the theme we want instead of assuming.
 */
async function ensureTheme(cdp, want) {
  const current = () =>
    cdp.eval(`document.documentElement.dataset.theme ?? 'dark'`);
  if ((await current()) === want) return;
  await click(cdp, want === "dark" ? "Switch to dark theme" : "Switch to light theme", 1200);
  const now = await current();
  if (now !== want) log(`! theme is ${now}, wanted ${want}`);
}

async function waitForWorkspace(cdp) {
  const deadline = Date.now() + WORKSPACE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await cdp.eval(
      `Boolean(document.querySelector('[aria-label="Workspace status"]'))`,
    );
    if (ready) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * First open indexes the whole repo. The status bar reads "Syncing n/m"
 * while it runs and "Synced …" once it lands, so wait for the transition
 * rather than for a fixed number of seconds — and don't mistake the moment
 * before it starts for the moment after it finishes.
 */
async function waitForIndex(cdp, maxMs) {
  const status = `(document.querySelector('[aria-label="Workspace status"]')?.innerText ?? '')`;
  const startDeadline = Date.now() + 90_000;
  while (Date.now() < startDeadline) {
    const text = await cdp.eval(status);
    if (/Syncing|Synced/.test(text)) break;
    await sleep(1000);
  }
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const text = await cdp.eval(status);
    if (text.includes("Synced")) {
      log(`index complete — status: ${text.replace(/\s+/g, " ").trim()}`);
      return true;
    }
    await sleep(3000);
  }
  log("index still running — capturing anyway");
  return false;
}

// -------------------------------------------------------------------- main
fs.mkdirSync(outDir, { recursive: true });
for (const required of [
  path.join(desktopRoot, "dist", "main.cjs"),
  path.join(agentRoot, "dist-electron", "utility-main.mjs"),
  path.join(webDist, "index.html"),
]) {
  if (!fs.existsSync(required)) {
    console.error(`[capture] missing build output: ${required}`);
    console.error("[capture] build the desktop, agent and web bundles first");
    process.exit(1);
  }
}

seedRegistry();
fs.rmSync(path.join(profile, "shots.log"), { force: true });

log(`launching Electron (cdp ${CDP_PORT}, isolated profile)`);
const electron = spawn(
  electronBinary,
  [
    path.join(desktopRoot, "dist", "main.cjs"),
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${path.join(profile, "electron")}`,
  ],
  {
    cwd: desktopRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      LOCALAPPDATA: profile,
      ATELIER_DEV_SKIP_AUTH: "1",
      ATELIER_WEB_DIST: webDist,
      ATELIER_AGENT_ENTRY: path.join(agentRoot, "dist-electron", "utility-main.mjs"),
      ATELIER_DEV_URL: "",
    },
  },
);

let exitCode = 0;
try {
  const target = await waitForTarget(Date.now() + 60_000);
  const ws = new WebSocket(target.webSocketDebuggerUrl, {
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  log("attached");

  // 2x for a crisp landing page; the window itself stays 1600x1000.
  const size = await cdp.eval(
    `({ w: window.innerWidth, h: window.innerHeight })`,
  );
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: size.w,
    height: size.h,
    deviceScaleFactor: 2,
    mobile: false,
  });

  if (!(await waitForWorkspace(cdp))) {
    await cdp.shot("_debug-stuck.png");
    throw new Error("workspace never rendered — see docs/assets/_debug-stuck.png");
  }
  log("workspace up; waiting for the first index");
  // Long: a cold index of this repo embeds thousands of chunks on-device, and
  // the shots are much cleaner once the "Building knowledge" card is gone.
  await waitForIndex(cdp, 900_000);
  await sleep(2000);

  // Chat, dark — the hero shot. A drafted prompt beats an empty composer.
  await ensureTheme(cdp, "dark");
  await click(cdp, "Agents");
  const typed = await cdp.eval(typeInComposer("make the review stage cheaper for small diffs"));
  log(`composer draft: ${typed ? await cdp.eval(`document.querySelector('textarea').value`) : "no textarea"}`);
  await sleep(800);
  await cdp.shot("console-dark.png");

  await click(cdp, "Explorer");
  await cdp.shot("explorer.png");

  // Best effort: open the first real file in the tree so the editor shot
  // shows Monaco with code in it rather than an empty pane.
  const opened = await cdp.eval(`(() => {
    const nodes = [...document.querySelectorAll('button, [role="treeitem"]')];
    const hit = nodes.find((n) => /\\.(tsx?|md|json)$/.test((n.textContent ?? '').trim()));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
  if (opened) {
    await sleep(3500);
    await cdp.shot("editor.png");
  } else {
    log("! no file node found in the explorer tree — editor shot skipped");
  }

  await click(cdp, "Knowledge", 4000);
  await cdp.shot("knowledge.png");

  await click(cdp, "Source Control", 2500);
  await cdp.shot("git-flow.png");

  await click(cdp, "Hooks");
  await cdp.shot("hooks.png");

  await click(cdp, "Settings", 2500);
  await cdp.shot("settings.png");

  await click(cdp, "Agents");
  await click(cdp, "Toggle terminal panel", 2500);
  await cdp.shot("terminal.png");
  await click(cdp, "Toggle terminal panel");

  // Light theme last: the same console, so the two read as one pair.
  await ensureTheme(cdp, "light");
  await cdp.shot("console-light.png");

  log("done");
} catch (error) {
  console.error(`[capture] ${error.message}`);
  exitCode = 1;
} finally {
  electron.kill();
  await sleep(1000);
  process.exit(exitCode);
}
