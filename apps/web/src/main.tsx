import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./views/shell/ErrorBoundary";
import { initAuth } from "./state/auth.store";
import "./index.css";

/** Longest we wait on the session before painting anyway. */
const AUTH_BOOT_TIMEOUT_MS = 1500;

function mount(): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary where="Atelier">
        <App />
      </ErrorBoundary>
    </StrictMode>
  );
}

/**
 * Resolve the persisted session before the first paint so the app opens
 * directly on the right screen with no gate flash — but never let that
 * block the window. A rejected or slow session call paints anyway (the
 * store's defaults land on the login screen, which is recoverable);
 * gating the render on IPC is how you get a permanently empty window.
 */
void Promise.race([
  initAuth().catch((error) => {
    console.error("auth init failed", error);
  }),
  new Promise((resolve) => setTimeout(resolve, AUTH_BOOT_TIMEOUT_MS)),
]).then(mount);
