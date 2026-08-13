import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./views/shell/ErrorBoundary";
import "./index.css";

function mount(): void {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary where="Atelier">
        <App />
      </ErrorBoundary>
    </StrictMode>
  );
}

mount();
