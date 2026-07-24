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
 * Injects the supervisor's hub.json (port + token) so the dev UI auto-
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
      const hub = readInfo("hub.json");
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
    port: 5173,
  },
});
