import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Read a {port, token} discovery file (bridge.json / hub.json), if present. */
function readInfo(fileName: string): { port: string; token: string } {
  const base =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
  const file = path.join(
    process.env.ATELIER_DATA_DIR ?? path.join(base, "atelier"),
    fileName
  );
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    return { port: String(info.port ?? ""), token: String(info.token ?? "") };
  } catch {
    return { port: "", token: "" };
  }
}

/**
 * Hub coordinates for this dev server. The launcher (scripts/dev.mjs) passes
 * its own instance's port + token by env, which is what makes several
 * projects runnable at once — reading the shared hub.json would hand every
 * UI whichever supervisor started last. Falls back to the per-port file,
 * then the canonical one, for a bare `pnpm --filter @atelier/web dev`.
 */
function hubInfo(): { port: string; token: string } {
  const port = process.env.ATELIER_HUB_PORT ?? "";
  const token = process.env.ATELIER_HUB_TOKEN ?? "";
  if (port && token) return { port, token };
  if (port) {
    const perPort = readInfo(`hub-${port}.json`);
    if (perPort.token) return perPort;
  }
  return readInfo("hub.json");
}

/**
 * Injects the supervisor's hub info (port + token) so the dev UI auto-
 * connects to the projects control API without manual token pasting. The
 * legacy single-agent bridge.json is still injected for back-compat.
 */
function bridgeInfoPlugin(): Plugin {
  return {
    name: "atelier-bridge-info",
    config() {
      // Packaged builds get tokens at runtime (window.__ATELIER_HUB__), so
      // never bake a per-run token into a distributable bundle.
      if (process.env.ATELIER_PACKAGE === "1") {
        return {
          define: {
            __ATELIER_BRIDGE_PORT__: JSON.stringify(""),
            __ATELIER_BRIDGE_TOKEN__: JSON.stringify(""),
            __ATELIER_HUB_PORT__: JSON.stringify(""),
            __ATELIER_HUB_TOKEN__: JSON.stringify(""),
          },
        };
      }
      const bridge = readInfo("bridge.json");
      const hub = hubInfo();
      return {
        define: {
          __ATELIER_BRIDGE_PORT__: JSON.stringify(bridge.port),
          __ATELIER_BRIDGE_TOKEN__: JSON.stringify(bridge.token),
          __ATELIER_HUB_PORT__: JSON.stringify(hub.port),
          __ATELIER_HUB_TOKEN__: JSON.stringify(hub.token),
        },
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), bridgeInfoPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    // The launcher pairs each hub with its own web port (43100 -> 5173,
    // 43101 -> 5174, …) and pins it: drifting to another port would leave
    // the UI baked with one project's hub token on another's URL.
    port: Number(process.env.ATELIER_WEB_PORT ?? 5173),
    strictPort: process.env.ATELIER_WEB_PORT !== undefined,
  },
});
