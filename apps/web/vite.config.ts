import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  // Loaded over file:// in the packaged desktop app.
  base: "./",
  build: {
    rollupOptions: {
      output: {
        // Do not absorb shared React/runtime helpers into a lazy heavyweight:
        // that makes the app entry import the whole heavyweight eagerly.
        onlyExplicitManualChunks: true,
        // The heavyweights ship in their own chunks so the login/picker
        // entry stays small and the workspace chunk parallelizes.
        manualChunks(id: string) {
          // Keep the small React loader out of the editor-core chunk, or
          // importing the wrapper eagerly pulls the entire editor with it.
          if (id.includes("/monaco-editor/")) return "monaco";
          if (id.includes("@xterm")) return "xterm";
          if (
            id.includes("three") ||
            id.includes("react-force-graph") ||
            id.includes("force-graph")
          ) {
            return "graph";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: Number(process.env.ATELIER_WEB_PORT ?? 5173),
    strictPort: process.env.ATELIER_WEB_PORT !== undefined,
  },
});
