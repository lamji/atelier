import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * Reads the agent's bridge.json (port + token) and injects it so the dev UI
 * auto-connects without manual token pasting.
 */
function bridgeInfoPlugin(): Plugin {
  return {
    name: "atelier-bridge-info",
    config() {
      const base =
        process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share");
      const file = path.join(
        process.env.ATELIER_DATA_DIR ?? path.join(base, "atelier"),
        "bridge.json"
      );
      let port = "";
      let token = "";
      try {
        const info = JSON.parse(fs.readFileSync(file, "utf8"));
        port = String(info.port ?? "");
        token = String(info.token ?? "");
      } catch {
        // Agent not started yet: UI falls back to manual token entry.
      }
      return {
        define: {
          __ATELIER_BRIDGE_PORT__: JSON.stringify(port),
          __ATELIER_BRIDGE_TOKEN__: JSON.stringify(token),
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
