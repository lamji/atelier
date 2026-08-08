import { Component, type ErrorInfo, type ReactNode } from "react";
import { BareTitleBar } from "./WindowControls";
import { cn } from "@/lib/cn";

interface Props {
  /** Names the subtree, so the message says what failed. */
  where: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  stack: string | null;
}

/**
 * Without this, a throw anywhere under the workspace unmounts the entire
 * React tree and the window goes black with no clue on screen — the failure
 * mode is indistinguishable from "still loading". Catch it and show the
 * error instead; a readable stack beats a blank window.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Main forwards renderer console errors to the launching terminal, so
    // this is also how the failure reaches the logs.
    console.error(`[${this.props.where}] render failed`, error, info);
    this.setState({ stack: info.componentStack ?? null });
  }

  private reset = (): void => {
    this.setState({ error: null, stack: null });
  };

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col bg-background">
        <BareTitleBar />
        <main className="flex min-h-0 flex-1 items-start justify-center overflow-auto px-6 py-10">
          <div className="w-full max-w-2xl">
            <p
              className="font-mono text-[10px] uppercase tracking-[0.18em]
                text-destructive/80"
            >
              {this.props.where} crashed
            </p>
            <h1 className="mt-2.5 text-[22px] font-bold leading-tight tracking-tight">
              {error.message || "Something threw during render."}
            </h1>

            {(error.stack || stack) && (
              <pre
                className="mt-5 max-h-80 overflow-auto rounded-xl bg-card/60 p-3
                  text-[11px] leading-relaxed text-muted-foreground"
              >
                {error.stack ?? ""}
                {stack ?? ""}
              </pre>
            )}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={this.reset}
                className={cn(
                  "flex h-9 items-center rounded-xl px-4 text-xs font-semibold",
                  "bg-primary text-primary-foreground outline-none",
                  "transition-opacity hover:opacity-90"
                )}
              >
                Try again
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className={cn(
                  "flex h-9 items-center rounded-xl px-4 text-xs font-semibold",
                  "bg-accent text-foreground outline-none",
                  "transition-opacity hover:opacity-90"
                )}
              >
                Reload
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }
}
