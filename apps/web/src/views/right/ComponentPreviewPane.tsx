import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Box,
  Camera,
  Check,
  ExternalLink,
  Loader2,
  MessageSquare,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  Square,
  Server,
  Smartphone,
  Tablet,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import {
  pendingTerminalPrompt,
  terminalAnswer,
  type TerminalPrompt,
} from "@atelier/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import {
  resolveComponentPreview,
  type ComponentPreviewRuntime,
} from "@/lib/component-preview";
import { openExternal } from "@/lib/desktop";
import { bridge } from "@/services/bridge-client";
import { terminalRegistry } from "@/services/terminal-registry";
import { useConnectionStore } from "@/state/connection.store";
import { useTerminalStore } from "@/state/terminal.store";
import { useWorkspaceStore } from "@/state/workspace.store";
import type { PendingImage } from "@/types";

export type ScreenshotChatDestination = "current" | "new";

interface ComponentPreviewPaneProps {
  managedTermId: string | null;
  onManagedTermChange: (termId: string | null) => void;
  currentSessionTitle: string | null;
  onAttachScreenshot: (
    image: PendingImage,
    destination: ScreenshotChatDestination
  ) => Promise<void>;
  reviewTaskId: string | null;
  onPreviewUrlChange: (url: string | null) => void;
  onCaptureForReview: (image: PendingImage, url: string) => Promise<void>;
}

type Viewport = "laptop" | "tablet" | "mobile";

interface HighlightRect {
  /** Normalized coordinates keep annotations aligned if the pane resizes. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const MOBILE_VIEWPORTS = [
  { id: "320x568", label: "iPhone SE (1st gen)", width: 320, height: 568 },
  { id: "360x640", label: "Small Android", width: 360, height: 640 },
  { id: "360x720", label: "Android 18:9", width: 360, height: 720 },
  { id: "360x740", label: "Galaxy S8 / S9", width: 360, height: 740 },
  { id: "360x760", label: "Modern Android", width: 360, height: 760 },
  { id: "360x780", label: "iPhone 12 / 13 mini", width: 360, height: 780 },
  { id: "360x800", label: "Tall Android", width: 360, height: 800 },
  { id: "375x667", label: "iPhone 6–8 / SE", width: 375, height: 667 },
  { id: "375x812", label: "iPhone X / XS / 11 Pro", width: 375, height: 812 },
  { id: "384x832", label: "Pixel / Android", width: 384, height: 832 },
  { id: "390x844", label: "iPhone 12 / 13 / 14", width: 390, height: 844 },
  { id: "393x852", label: "iPhone 14 / 15 Pro", width: 393, height: 852 },
  { id: "393x873", label: "Recent Android", width: 393, height: 873 },
  { id: "412x732", label: "Nexus 6P", width: 412, height: 732 },
  { id: "412x846", label: "Large Android", width: 412, height: 846 },
  { id: "412x869", label: "Samsung Galaxy", width: 412, height: 869 },
  { id: "412x892", label: "Google Pixel", width: 412, height: 892 },
  { id: "414x736", label: "iPhone Plus", width: 414, height: 736 },
  { id: "414x896", label: "iPhone XR / XS Max / 11", width: 414, height: 896 },
  { id: "428x926", label: "iPhone 12–14 Pro Max", width: 428, height: 926 },
  { id: "430x932", label: "iPhone 14–16 Pro Max", width: 430, height: 932 },
  { id: "432x960", label: "Large modern Android", width: 432, height: 960 },
] as const;

type MobileViewportId = (typeof MOBILE_VIEWPORTS)[number]["id"];

const DEFAULT_MOBILE_VIEWPORT: MobileViewportId = "390x844";
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;
const LOCAL_PREVIEW_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{2,5})?(?:\/[^\s]*)?/gi;

/** Pull the last local URL from dev-server output after removing terminal escapes. */
function extractLocalPreviewUrl(output: string): string | null {
  const matches = output.replace(ANSI_ESCAPE, "").match(LOCAL_PREVIEW_URL);
  const candidate = matches?.at(-1)?.replace(/[),.;]+$/, "");
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.href;
  } catch {
    return null;
  }
}

function previewRouteLabel(value: string | null): string {
  if (!value) return "/";
  try {
    const url = new URL(value);
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return value;
  }
}

const MOBILE_VIEWPORT_OPTIONS = MOBILE_VIEWPORTS.map((profile) => ({
  value: profile.id,
  label: `${profile.label} · ${profile.width} × ${profile.height}`,
  hint: `${profile.width} × ${profile.height} CSS px`,
}));

/**
 * The iframe uses the device's exact CSS viewport. The surrounding frame is
 * presentation only and is included in the fit calculation, so responsive
 * breakpoints never inherit Atelier's own window size.
 */
const VIEWPORTS = {
  laptop: {
    width: 1440,
    height: 900,
    label: "Laptop",
    device: "14-inch laptop",
    frame: { top: 14, right: 18, bottom: 32, left: 18, radius: 12, screenRadius: 3 },
    Icon: Monitor,
  },
  tablet: {
    width: 768,
    height: 1024,
    label: "Tablet",
    device: "9.7-inch tablet",
    frame: { top: 26, right: 18, bottom: 26, left: 18, radius: 28, screenRadius: 8 },
    Icon: Tablet,
  },
  mobile: {
    width: 390,
    height: 844,
    label: "Mobile",
    device: "6.1-inch phone",
    frame: { top: 12, right: 12, bottom: 12, left: 12, radius: 46, screenRadius: 35 },
    Icon: Smartphone,
  },
} as const;

/**
 * Runtime-backed full-page preview. It discovers a runnable application from
 * the workspace itself, preserving routes, providers, CSS, assets, state,
 * HMR, and the framework compiler without depending on the open editor file.
 */
export function ComponentPreviewPane({
  managedTermId,
  onManagedTermChange,
  currentSessionTitle,
  onAttachScreenshot,
  reviewTaskId,
  onPreviewUrlChange,
  onCaptureForReview,
}: ComponentPreviewPaneProps) {
  const workspaceRoot = useConnectionStore((state) => state.workspaceRoot);
  const workspaceTree = useWorkspaceStore((state) => state.tree);
  const [runtime, setRuntime] = useState<ComponentPreviewRuntime | null>(null);
  const [address, setAddress] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>("laptop");
  const [mobileViewportId, setMobileViewportId] =
    useState<MobileViewportId>(DEFAULT_MOBILE_VIEWPORT);
  const [frameKey, setFrameKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  /**
   * The question the preview command is blocked on, if any. A dev server
   * that asks "port 3000 is in use, use 3001?" prints no URL and never
   * will, so the launch used to spin for its full 30s and then blame the
   * server for being unreachable — with the answer one keystroke away in a
   * terminal tab the user had no reason to open.
   */
  const [terminalPrompt, setTerminalPrompt] = useState<TerminalPrompt | null>(
    null
  );
  const [message, setMessage] = useState<string | null>(null);
  const previewCanvasRef = useRef<HTMLDivElement>(null);
  const previewScreenRef = useRef<HTMLDivElement>(null);
  const [screenshotDraft, setScreenshotDraft] = useState<string | null>(null);
  const [screenshotSourceUrl, setScreenshotSourceUrl] = useState<string | null>(null);
  const [screenshotDestinationOpen, setScreenshotDestinationOpen] = useState(false);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const [savingScreenshot, setSavingScreenshot] = useState(false);
  const [highlights, setHighlights] = useState<HighlightRect[]>([]);
  const [selection, setSelection] = useState<HighlightRect | null>(null);
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  const handledReviewTaskId = useRef<string | null>(null);
  const previousManagedTermId = useRef<string | null>(managedTermId);
  const launchTimerRef = useRef<number | null>(null);
  const [previewCanvasSize, setPreviewCanvasSize] = useState({
    width: 0,
    height: 0,
  });

  useEffect(() => {
    onPreviewUrlChange(previewUrl);
  }, [onPreviewUrlChange, previewUrl]);

  const openPreviewAt = useCallback(
    (nextUrl: string) => {
      const parsed = new URL(nextUrl);
      const normalizedAddress = parsed.href.replace(/\/$/, "");
      if (launchTimerRef.current !== null) {
        window.clearTimeout(launchTimerRef.current);
        launchTimerRef.current = null;
      }
      setAddress(normalizedAddress);
      if (previewUrlRef.current !== parsed.href) {
        previewUrlRef.current = parsed.href;
        setPreviewUrl(parsed.href);
        setFrameKey((key) => key + 1);
        setLoading(true);
      }
      setLaunching(false);
      setMessage(`Preview server ready at ${parsed.host}.`);
      if (runtime) {
        try {
          localStorage.setItem(runtime.storageKey, normalizedAddress);
        } catch {
          // Preview remains usable when localStorage is blocked or full.
        }
      }
    },
    [runtime]
  );

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return;

    const updateSize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      setPreviewCanvasSize({ width, height });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [runtime, previewUrl]);

  useEffect(
    () => () => {
      if (launchTimerRef.current !== null) {
        window.clearTimeout(launchTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!managedTermId) return;
    let output = "";
    let parseTimer: number | null = null;
    const stop = terminalRegistry.onOutput(managedTermId, (data) => {
      output = `${output}${data}`.slice(-8_192);
      if (parseTimer !== null) window.clearTimeout(parseTimer);
      // Terminal output may split a URL across chunks. Let the current burst
      // settle before parsing so a partial port is never treated as ready.
      parseTimer = window.setTimeout(() => {
        parseTimer = null;
        const detectedUrl = extractLocalPreviewUrl(output);
        if (detectedUrl) openPreviewAt(detectedUrl);
      }, 60);
    });
    return () => {
      stop();
      if (parseTimer !== null) window.clearTimeout(parseTimer);
    };
  }, [managedTermId, openPreviewAt]);

  useEffect(() => {
    if (!launching || !managedTermId || !address) return;
    let requested: URL;
    try {
      requested = new URL(address);
    } catch {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    // Set while the countdown is suspended for a question, so an answer
    // typed straight into the terminal tab resumes it too.
    let pausedForPrompt = false;
    void (async () => {
      while (!cancelled) {
        let candidate = requested;
        try {
          const { data } = await bridge.rpc("terminal.getHistory", {
            termId: managedTermId,
          });
          const detectedUrl = extractLocalPreviewUrl(data);
          if (detectedUrl) candidate = new URL(detectedUrl);
          // A blocked command answers nothing on its own. Surface the
          // question here and stop the countdown: the launch has not failed,
          // it is waiting on the user.
          const asked = pendingTerminalPrompt(data);
          setTerminalPrompt(asked);
          if (asked && launchTimerRef.current !== null) {
            window.clearTimeout(launchTimerRef.current);
            launchTimerRef.current = null;
            pausedForPrompt = true;
          }
          if (!asked && pausedForPrompt) {
            pausedForPrompt = false;
            launchTimerRef.current = window.setTimeout(() => {
              launchTimerRef.current = null;
              setLaunching(false);
              setMessage(
                "The preview server did not become reachable. Check its integrated terminal output, then try again."
              );
            }, 30_000);
          }
        } catch {
          // Live output observation still handles terminals without history.
        }

        // During Atelier development, an app can share Atelier's default
        // renderer port. Never accept that already-live origin as proof that
        // the newly launched server is ready; wait for its actual URL.
        if (candidate.origin !== window.location.origin) {
          try {
            await fetch(candidate.href, {
              cache: "no-store",
              mode: "no-cors",
              signal: controller.signal,
            });
            if (!cancelled) openPreviewAt(candidate.href);
            return;
          } catch {
            if (controller.signal.aborted) return;
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [address, launching, managedTermId, openPreviewAt]);

  useEffect(() => {
    if (previousManagedTermId.current && !managedTermId) {
      if (launchTimerRef.current !== null) {
        window.clearTimeout(launchTimerRef.current);
        launchTimerRef.current = null;
      }
      previewUrlRef.current = null;
      setPreviewUrl(null);
      setLoading(false);
      setLaunching(false);
      setTerminalPrompt(null);
      setMessage("Page preview stopped. Start it again when you need it.");
    }
    previousManagedTermId.current = managedTermId;
  }, [managedTermId]);

  useEffect(() => {
    let cancelled = false;
    setRuntime(null);
    previewUrlRef.current = null;
    setPreviewUrl(null);
    setMessage(null);
    setLoading(true);

    if (!workspaceTree) return;

    void resolveComponentPreview(workspaceTree, workspaceRoot)
      .then(async (next) => {
        if (cancelled) return;
        setRuntime(next);
        // A workspace with no web target has nothing for this pane to set
        // up. The tab that opens it is hidden in that case, so this is the
        // race where the tree arrives after the pane mounted.
        if (!next) return;
        let savedAddress = "";
        let savedCommand = "";
        try {
          savedAddress = localStorage.getItem(next.storageKey) ?? "";
          savedCommand =
            localStorage.getItem(`${next.storageKey}::command`) ?? "";
        } catch {
          // A blocked localStorage only means preview settings are not remembered.
        }
        const nextAddress = savedAddress || next.defaultUrl;
        setAddress(nextAddress);
        setCustomCommand(savedCommand);

        const terminalName = `${next.projectName} page preview`;
        const existing = useTerminalStore
          .getState()
          .sessions.find(
            (session) => session.alive && session.name === terminalName
          );
        if (!existing) {
          setLoading(false);
          return;
        }

        onManagedTermChange(existing.id);
        let historyUrl: string | null = null;
        try {
          const { data } = await bridge.rpc("terminal.getHistory", {
            termId: existing.id,
          });
          historyUrl = extractLocalPreviewUrl(data);
        } catch {
          // A terminal can still be restarted when its history is unavailable.
        }
        if (cancelled) return;
        const historyMatchesRenderer =
          historyUrl && new URL(historyUrl).origin === window.location.origin;
        if (!historyUrl || historyMatchesRenderer) {
          setMessage("Preview terminal found, but no running server was detected. Start it again.");
          setLoading(false);
          return;
        }

        const normalizedAddress = historyUrl.replace(/\/$/, "");
        setAddress(normalizedAddress);
        setMessage("Checking the existing preview server…");
        setLoading(false);
        setLaunching(true);
        launchTimerRef.current = window.setTimeout(() => {
          launchTimerRef.current = null;
          setLaunching(false);
          setMessage("The previous preview server is no longer reachable. Start it again.");
        }, 10_000);
        try {
          localStorage.setItem(next.storageKey, normalizedAddress);
        } catch {
          // Preview remains usable when localStorage is blocked or full.
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMessage(
          error instanceof Error
            ? error.message
            : "Atelier could not discover a preview runtime."
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [onManagedTermChange, workspaceRoot, workspaceTree]);

  const useAddress = () => {
    const raw = address.trim();
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
      const parsed = new URL(withProtocol);
      const local =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]";
      if (!local || !["http:", "https:"].includes(parsed.protocol)) {
        setMessage("Page previews must use a local http(s) development server.");
        return;
      }
      setMessage(null);
      setAddress(parsed.href.replace(/\/$/, ""));
      previewUrlRef.current = parsed.href;
      setPreviewUrl(parsed.href);
      setFrameKey((key) => key + 1);
      setLoading(true);
      if (runtime) {
        try {
          localStorage.setItem(runtime.storageKey, parsed.href.replace(/\/$/, ""));
        } catch {
          // Preview remains usable when localStorage is blocked or full.
        }
      }
    } catch {
      setMessage("Enter a valid local URL, for example http://localhost:5173.");
    }
  };

  const launch = async () => {
    if (!runtime || launching) return;
    const command = runtime.command ?? customCommand.trim();
    if (!command) {
      setMessage("Enter the command that starts your local development server.");
      return;
    }

    /*
     * Some targets need their web dependencies before they can serve one.
     *
     * An Expo app that has only ever run on a device has no react-dom or
     * react-native-web, and `expo start --web` fails on exactly that. The
     * install runs first, chained so the server only starts if it succeeded,
     * and both are visible in the same terminal — this is a step of the
     * launch, not something happening quietly elsewhere.
     */
    const windows = workspaceRoot?.includes("\\") ?? false;
    const chained = runtime.prepareCommand
      ? `${runtime.prepareCommand} && ${command}`
      : command;

    // The desktop dev process exposes its own renderer port through this
    // environment variable. It belongs to Atelier, not to apps launched from
    // the preview terminal; leaking it makes Vite reuse Atelier's occupied
    // port with strictPort enabled and the preview command exits immediately.
    const isolatedCommand = windows
      ? `Remove-Item Env:ATELIER_WEB_PORT -ErrorAction SilentlyContinue; ${chained}`
      : `env -u ATELIER_WEB_PORT ${chained}`;

    previewUrlRef.current = null;
    setPreviewUrl(null);
    setLoading(false);
    setLaunching(true);
    setMessage(null);
    setTerminalPrompt(null);
    try {
      if (!runtime.command) {
        try {
          localStorage.setItem(`${runtime.storageKey}::command`, command);
        } catch {
          // The command still runs when localStorage is unavailable.
        }
      }
      const terminalName = `${runtime.projectName} page preview`;
      const existing = useTerminalStore
        .getState()
        .sessions.find((session) => session.alive && session.name === terminalName);

      let termId: string;
      if (existing) {
        termId = existing.id;
        useTerminalStore.getState().setActive(termId);
        onManagedTermChange(termId);
      } else {
        const separator = workspaceRoot?.includes("\\") ? "\\" : "/";
        const root = workspaceRoot?.replace(/[\\/]+$/, "") ?? "";
        const child = runtime.projectDir.replace(/\//g, separator);
        const cwd = root && child ? `${root}${separator}${child}` : root || undefined;
        const { session } = await bridge.rpc("terminal.create", {
          ...(cwd ? { cwd } : {}),
          name: terminalName,
        });
        termId = session.id;
        useTerminalStore.getState().addSession(session);
        // Publish the managed id before the command starts so readiness
        // checks can follow this terminal from its first server output.
        onManagedTermChange(termId);
      }

      await bridge.rpc("terminal.write", {
        termId,
        data: `${isolatedCommand}\r`,
      });
      setMessage(
        runtime.prepareCommand
          ? `${runtime.prepareReason ?? "Preparing the web build"}, then starting it…`
          : existing
            ? "Restarting the preview server in its integrated terminal…"
            : runtime.command
              ? `Starting ${runtime.storybook ? "Storybook" : runtime.framework} in the integrated terminal…`
              : "Starting the custom preview command in the integrated terminal…"
      );
      if (launchTimerRef.current !== null) {
        window.clearTimeout(launchTimerRef.current);
      }
      launchTimerRef.current = window.setTimeout(
        () => {
          launchTimerRef.current = null;
          setLaunching(false);
          setMessage(
            "The preview server did not become reachable. Check its integrated terminal output, then try again."
          );
        },
        // Installing web dependencies is a package-manager download, which
        // is minutes on a cold cache. Calling that a failed launch after 30
        // seconds would be wrong about a launch that is going fine.
        runtime.prepareCommand ? 180_000 : 30_000
      );
    } catch (error) {
      setLaunching(false);
      setMessage(
        error instanceof Error ? error.message : "The app preview server could not be started."
      );
    }
  };

  /**
   * Answers the terminal's question from the preview card.
   *
   * The countdown restarts from the answer rather than from the launch: the
   * time the command spent waiting on a person is not evidence that the
   * server is slow to come up.
   */
  const answerTerminalPrompt = async (
    answer: "yes" | "no" | "default"
  ): Promise<void> => {
    if (!managedTermId) return;
    setTerminalPrompt(null);
    try {
      await bridge.rpc("terminal.write", {
        termId: managedTermId,
        data: terminalAnswer(answer),
      });
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The answer could not be sent to the preview terminal."
      );
      return;
    }
    if (launchTimerRef.current !== null) {
      window.clearTimeout(launchTimerRef.current);
    }
    launchTimerRef.current = window.setTimeout(() => {
      launchTimerRef.current = null;
      setLaunching(false);
      setMessage(
        "The preview server did not become reachable. Check its integrated terminal output, then try again."
      );
    }, 30_000);
  };

  const resetScreenshotDraft = useCallback(() => {
    setScreenshotDraft(null);
    setScreenshotSourceUrl(null);
    setScreenshotDestinationOpen(false);
    setHighlights([]);
    setSelection(null);
    selectionStart.current = null;
  }, []);

  useEffect(() => {
    if (!screenshotDraft) return;

    const handleDraftShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (screenshotDestinationOpen) {
          setScreenshotDestinationOpen(false);
          return;
        }
        resetScreenshotDraft();
        setMessage(null);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        setHighlights((current) => current.slice(0, -1));
      }
    };

    window.addEventListener("keydown", handleDraftShortcut);
    return () => window.removeEventListener("keydown", handleDraftShortcut);
  }, [resetScreenshotDraft, screenshotDraft, screenshotDestinationOpen]);

  const capturePagePreview = useCallback(async () => {
    const screen = previewScreenRef.current;
    const captureRegion = window.atelierDesktop?.captureRegion;
    if (!screen || !previewUrl || !captureRegion) {
      throw new Error("The live Page preview is not ready to capture.");
    }
    const rect = screen.getBoundingClientRect();
    const capture = await captureRegion({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      previewUrl,
    });
    if (!capture?.dataUrl) {
      throw new Error("Atelier could not capture the page preview.");
    }
    return {
      dataUrl: capture.dataUrl,
      sourceUrl: capture.frameUrl ?? previewUrl,
    };
  }, [previewUrl]);

  /** Capture first, then let the user annotate or discard before anything is saved. */
  const startScreenshotDraft = async () => {
    if (capturingScreenshot) return;
    setCapturingScreenshot(true);
    setMessage(null);
    try {
      const capture = await capturePagePreview();
      setScreenshotDraft(capture.dataUrl);
      setScreenshotSourceUrl(capture.sourceUrl);
      setHighlights([]);
      setSelection(null);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The page preview could not be captured."
      );
    } finally {
      setCapturingScreenshot(false);
    }
  };

  useEffect(() => {
    if (
      !reviewTaskId ||
      !previewUrl ||
      loading ||
      handledReviewTaskId.current === reviewTaskId
    ) {
      return;
    }
    handledReviewTaskId.current = reviewTaskId;
    let cancelled = false;
    void (async () => {
      try {
        const capture = await capturePagePreview();
        if (cancelled) return;
        const data = capture.dataUrl.slice(capture.dataUrl.indexOf(",") + 1);
        const capturedAt = Date.now();
        const path = `.atelier/images/frontend-review-${capturedAt}.png`;
        await bridge.rpc("fs.writeImage", {
          path,
          data,
          mediaType: "image/png",
        });
        if (cancelled) return;
        await onCaptureForReview(
          {
            id: `frontend-review-${capturedAt}`,
            mediaType: "image/png",
            data,
            dataUrl: capture.dataUrl,
            path,
            sourceUrl: capture.sourceUrl,
          },
          capture.sourceUrl
        );
      } catch (error) {
        handledReviewTaskId.current = null;
        setMessage(
          error instanceof Error
            ? error.message
            : "The Page preview could not be prepared for review."
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    capturePagePreview,
    loading,
    onCaptureForReview,
    previewUrl,
    reviewTaskId,
  ]);

  const saveScreenshot = async (destination: ScreenshotChatDestination) => {
    if (!screenshotDraft || savingScreenshot) return;
    setScreenshotDestinationOpen(false);
    setSavingScreenshot(true);
    setMessage(null);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("The screenshot draft could not be opened."));
        image.src = screenshotDraft;
      });

      const output = document.createElement("canvas");
      output.width = image.naturalWidth;
      output.height = image.naturalHeight;
      const context = output.getContext("2d");
      if (!context) throw new Error("The screenshot editor is unavailable.");

      context.drawImage(image, 0, 0);
      context.strokeStyle = "#0284c7";
      context.fillStyle = "rgba(14, 165, 233, 0.12)";
      context.lineWidth = Math.max(4, Math.round(image.naturalWidth / 360));
      context.lineJoin = "round";
      for (const highlight of highlights) {
        const x = highlight.x * image.naturalWidth;
        const y = highlight.y * image.naturalHeight;
        const width = highlight.width * image.naturalWidth;
        const height = highlight.height * image.naturalHeight;
        context.fillRect(x, y, width, height);
        context.strokeRect(x, y, width, height);
      }

      const outputUrl = output.toDataURL("image/png");
      const data = outputUrl.slice(outputUrl.indexOf(",") + 1);
      const capturedAt = Date.now();
      const path = `.atelier/images/page-preview-${capturedAt}.png`;
      await bridge.rpc("fs.writeImage", { path, data, mediaType: "image/png" });
      await onAttachScreenshot(
        {
          id: `screenshot-${capturedAt}`,
          mediaType: "image/png",
          data,
          dataUrl: outputUrl,
          path,
          sourceUrl: screenshotSourceUrl ?? previewUrl ?? undefined,
        },
        destination
      );
      resetScreenshotDraft();
      setMessage("Screenshot saved and added to chat context.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "The screenshot could not be saved."
      );
    } finally {
      setSavingScreenshot(false);
    }
  };

  const mobileViewport =
    MOBILE_VIEWPORTS.find((profile) => profile.id === mobileViewportId) ??
    MOBILE_VIEWPORTS.find((profile) => profile.id === DEFAULT_MOBILE_VIEWPORT)!;

  if (!runtime) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          {loading ? (
            <>
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary/70" />
              <p className="mt-3 text-xs text-muted-foreground">
                Discovering the app runtime…
              </p>
            </>
          ) : (
            <>
              <TriangleAlert className="mx-auto h-6 w-6 text-amber-500/80" />
              <p className="mt-3 text-sm font-medium">Preview unavailable</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {message ?? "Atelier could not inspect this workspace."}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  const viewportConfig =
    viewport === "mobile"
      ? {
          ...VIEWPORTS.mobile,
          width: mobileViewport.width,
          height: mobileViewport.height,
          device: mobileViewport.label,
        }
      : VIEWPORTS[viewport];
  const deviceWidth =
    viewportConfig.frame.left + viewportConfig.width + viewportConfig.frame.right;
  const deviceHeight =
    viewportConfig.frame.top + viewportConfig.height + viewportConfig.frame.bottom;
  // Fit the complete physical frame against the preview canvas. The iframe
  // itself remains unscaled at the exact CSS viewport until its parent frame
  // is transformed, which preserves real responsive layout behavior.
  const viewportScale =
    previewCanvasSize.width > 0 && previewCanvasSize.height > 0
      ? Math.min(
          1,
          previewCanvasSize.width / deviceWidth,
          previewCanvasSize.height / deviceHeight
        )
      : 1;
  const displayedDevice = {
    width: Math.floor(deviceWidth * viewportScale),
    height: Math.floor(deviceHeight * viewportScale),
  };

  return (
    <div className="flex h-full flex-col bg-muted/15">
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border/60 bg-background px-2 py-1.5">
        <form
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            useAddress();
          }}
        >
          <Server className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            aria-label="Page preview URL"
            placeholder={runtime.defaultUrl}
            className="h-7 min-w-0 flex-1 bg-muted/50 font-mono text-[11px]"
            spellCheck={false}
          />
          <Button type="submit" size="sm" variant="secondary">
            Go
          </Button>
        </form>
        <div
          className="ml-1 flex shrink-0 items-center rounded-md bg-muted/60 p-0.5"
          role="group"
          aria-label="Preview viewport"
        >
          {(Object.entries(VIEWPORTS) as Array<
            [Viewport, (typeof VIEWPORTS)[Viewport]]
          >).map(([value, config]) => {
            const Icon = config.Icon;
            const selectedConfig =
              value === "mobile"
                ? {
                    ...config,
                    width: mobileViewport.width,
                    height: mobileViewport.height,
                    device: mobileViewport.label,
                  }
                : config;
            const viewportLabel = `${selectedConfig.label} (${selectedConfig.device}) — ${selectedConfig.width} × ${selectedConfig.height} CSS px`;
            return (
              <button
                key={value}
                type="button"
                title={viewportLabel}
                aria-label={viewportLabel}
                aria-pressed={viewport === value}
                onClick={() => setViewport(value)}
                className={cn(
                  "rounded p-1.5 transition-colors",
                  viewport === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>
        {viewport === "mobile" && (
          <Select
            value={mobileViewportId}
            onChange={(value) => setMobileViewportId(value as MobileViewportId)}
            options={MOBILE_VIEWPORT_OPTIONS}
            className="h-7 w-[min(13rem,24vw)] bg-muted/60"
            menuClassName="w-[min(19rem,80vw)]"
          />
        )}
        <span
          className="hidden shrink-0 font-mono text-[10px] text-muted-foreground xl:inline"
          aria-live="polite"
        >
          {viewportConfig.width} × {viewportConfig.height}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title="Reload preview"
          aria-label="Reload preview"
          disabled={!previewUrl}
          onClick={() => {
            setLoading(true);
            setFrameKey((key) => key + 1);
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant={screenshotDraft ? "secondary" : "ghost"}
          className="h-7 w-7"
          title="Capture and annotate screenshot"
          aria-label="Capture and annotate screenshot"
          disabled={
            !previewUrl ||
            !window.atelierDesktop?.captureRegion ||
            loading ||
            capturingScreenshot ||
            Boolean(screenshotDraft)
          }
          onClick={() => void startScreenshotDraft()}
        >
          {capturingScreenshot ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Camera className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title="Open in browser"
          aria-label="Open preview in browser"
          disabled={!previewUrl}
          onClick={() => previewUrl && openExternal(previewUrl)}
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>

      {message && (
        <div
          className="border-b border-border/50 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
          role="status"
        >
          {message}
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden p-3">
        <div
          ref={previewCanvasRef}
          className="relative flex h-full w-full items-center justify-center overflow-hidden"
        >
          {screenshotDraft && (
            <div
              className="fixed inset-0 z-[70] flex items-center justify-center bg-background p-4 sm:p-6"
              role="dialog"
              aria-modal="true"
              aria-labelledby="screenshot-editor-title"
            >
              <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
                <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-4 py-3 sm:px-5">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
                      <Camera className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <h2 id="screenshot-editor-title" className="text-sm font-semibold">
                        Review screenshot
                      </h2>
                      <p
                        className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
                        title={screenshotSourceUrl ?? previewUrl ?? undefined}
                      >
                        {previewRouteLabel(screenshotSourceUrl ?? previewUrl)}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0"
                    title="Close screenshot editor"
                    aria-label="Close screenshot editor"
                    disabled={savingScreenshot}
                    onClick={() => {
                      resetScreenshotDraft();
                      setMessage(null);
                    }}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-zinc-100 p-4 dark:bg-zinc-950 sm:p-6">
                  <div className="relative shrink-0 overflow-hidden rounded-lg border border-zinc-300 bg-white shadow-sm dark:border-zinc-700">
                    <img
                      src={screenshotDraft}
                      alt="Captured page preview"
                      className="block h-auto w-auto select-none object-contain"
                      style={{
                        maxWidth: "min(calc(100vw - 5rem), 68rem)",
                        maxHeight: "calc(100vh - 13rem)",
                      }}
                      draggable={false}
                    />
                    <div
                      className="absolute inset-0 z-40 cursor-crosshair touch-none"
                      aria-label="Screenshot editor. Drag to draw a rectangular highlight."
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        const rect = event.currentTarget.getBoundingClientRect();
                        selectionStart.current = {
                          x: Math.max(
                            0,
                            Math.min(1, (event.clientX - rect.left) / rect.width)
                          ),
                          y: Math.max(
                            0,
                            Math.min(1, (event.clientY - rect.top) / rect.height)
                          ),
                        };
                        setSelection(null);
                      }}
                      onPointerMove={(event) => {
                        const start = selectionStart.current;
                        if (!start) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        const x = Math.max(
                          0,
                          Math.min(1, (event.clientX - rect.left) / rect.width)
                        );
                        const y = Math.max(
                          0,
                          Math.min(1, (event.clientY - rect.top) / rect.height)
                        );
                        setSelection({
                          x: Math.min(start.x, x),
                          y: Math.min(start.y, y),
                          width: Math.abs(x - start.x),
                          height: Math.abs(y - start.y),
                        });
                      }}
                      onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          event.currentTarget.releasePointerCapture(event.pointerId);
                        }
                        const start = selectionStart.current;
                        selectionStart.current = null;
                        if (start) {
                          const rect = event.currentTarget.getBoundingClientRect();
                          const x = Math.max(
                            0,
                            Math.min(1, (event.clientX - rect.left) / rect.width)
                          );
                          const y = Math.max(
                            0,
                            Math.min(1, (event.clientY - rect.top) / rect.height)
                          );
                          const highlight = {
                            x: Math.min(start.x, x),
                            y: Math.min(start.y, y),
                            width: Math.abs(x - start.x),
                            height: Math.abs(y - start.y),
                          };
                          if (highlight.width >= 0.005 && highlight.height >= 0.005) {
                            setHighlights((current) => [...current, highlight]);
                          }
                        }
                        setSelection(null);
                      }}
                      onPointerCancel={() => {
                        selectionStart.current = null;
                        setSelection(null);
                      }}
                    />
                    {[...highlights, ...(selection ? [selection] : [])].map(
                      (highlight, index) => (
                        <div
                          key={index}
                          className="pointer-events-none absolute z-50 rounded-sm border-2 border-sky-500 bg-sky-500/10 shadow-[0_0_0_1px_rgba(255,255,255,0.85),0_0_0_3px_rgba(14,165,233,0.18)]"
                          style={{
                            left: `${highlight.x * 100}%`,
                            top: `${highlight.y * 100}%`,
                            width: `${highlight.width * 100}%`,
                            height: `${highlight.height * 100}%`,
                          }}
                        >
                          <span className="absolute left-1 top-1 flex h-5 min-w-5 items-center justify-center rounded bg-sky-600 px-1 text-[10px] font-semibold text-white shadow-sm">
                            {index + 1}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>

                <div
                  className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-background px-4 py-3 sm:px-5"
                  role="toolbar"
                  aria-label="Screenshot actions"
                >
                  <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-500/10 text-sky-600 dark:text-sky-400">
                      <Square className="h-3.5 w-3.5" />
                    </span>
                    <span>
                      Drag to mark an issue
                      <span className="hidden sm:inline"> · Ctrl/Cmd+Z to undo</span>
                    </span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-foreground">
                      {highlights.length === 0
                        ? "No highlights"
                        : `${highlights.length} highlight${highlights.length === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={highlights.length === 0 || savingScreenshot}
                      onClick={() => setHighlights((current) => current.slice(0, -1))}
                    >
                      <Undo2 className="h-3.5 w-3.5" />
                      Undo
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={savingScreenshot}
                      onClick={() => {
                        resetScreenshotDraft();
                        setMessage(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={savingScreenshot}
                      onClick={() => setScreenshotDestinationOpen(true)}
                    >
                      {savingScreenshot ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      {savingScreenshot ? "Saving…" : "Continue"}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
          {previewUrl ? (
            <div
              className="relative shrink-0 transition-[width,height] duration-200"
              style={{
                width: displayedDevice.width,
                height: displayedDevice.height,
              }}
            >
              <div
                className={cn(
                  "absolute left-0 top-0 border border-black/70 bg-zinc-900 shadow-2xl",
                  viewport === "laptop" && "bg-gradient-to-b from-zinc-700 to-zinc-950",
                  viewport === "tablet" && "bg-gradient-to-br from-zinc-700 to-zinc-950",
                  viewport === "mobile" && "bg-black"
                )}
                style={{
                  width: deviceWidth,
                  height: deviceHeight,
                  borderRadius: viewportConfig.frame.radius,
                  transform: `scale(${viewportScale})`,
                  transformOrigin: "top left",
                }}
              >
                <div
                  ref={previewScreenRef}
                  className="absolute overflow-hidden bg-white"
                  style={{
                    left: viewportConfig.frame.left,
                    top: viewportConfig.frame.top,
                    width: viewportConfig.width,
                    height: viewportConfig.height,
                    borderRadius: viewportConfig.frame.screenRadius,
                  }}
                >
                  {loading && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/85">
                      <Loader2 className="h-5 w-5 animate-spin text-primary/70" />
                      <span className="ml-2 text-xs text-muted-foreground">
                        Loading preview…
                      </span>
                    </div>
                  )}
                  <iframe
                    key={frameKey}
                    title={`${runtime.projectName} page preview`}
                    src={previewUrl}
                    className="h-full w-full border-0 bg-white"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
                    allow="clipboard-read; clipboard-write"
                    onLoad={() => setLoading(false)}
                  />
                </div>

                {viewport === "laptop" && (
                  <>
                    <span className="absolute left-1/2 top-1 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-black/80 ring-1 ring-white/10" />
                    <span className="absolute bottom-0 left-0 h-[18px] w-full rounded-b-[11px] bg-gradient-to-b from-zinc-700 to-zinc-900" />
                    <span className="absolute bottom-0 left-1/2 h-1.5 w-[18%] -translate-x-1/2 rounded-t-md bg-zinc-500/70" />
                  </>
                )}
                {viewport === "tablet" && (
                  <>
                    <span className="absolute left-1/2 top-2 h-2 w-2 -translate-x-1/2 rounded-full bg-black ring-1 ring-white/10" />
                    <span className="absolute bottom-2 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-zinc-500" />
                  </>
                )}
                {viewport === "mobile" && (
                  <>
                    <span className="absolute left-1/2 top-[20px] z-20 h-7 w-24 -translate-x-1/2 rounded-full bg-black shadow-sm" />
                    <span className="absolute bottom-[18px] left-1/2 z-20 h-1 w-28 -translate-x-1/2 rounded-full bg-white/80 shadow" />
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="m-auto w-full max-w-lg rounded-xl border border-border/70 bg-card p-6 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 p-2 text-primary">
                  <Box className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">Preview the full page</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {runtime.command ? (
                      <>
                        Atelier detected{" "}
                        <span className="font-medium text-foreground">
                          {runtime.framework}
                        </span>{" "}
                        in{" "}
                        <span className="font-mono text-foreground">
                          {runtime.projectName}
                        </span>
                        . Start its server, then enter any local route above. The entire page
                        renders with real navigation, state, styles, and hot reload.
                      </>
                    ) : (
                      <>
                        Atelier could not find a common preview script in this workspace.
                        Enter the command that starts your web app, then open its local URL.
                      </>
                    )}
                  </p>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-2 rounded-lg bg-muted/45 p-3 text-[11px]">
                <div>
                  <p className="text-muted-foreground">Runtime</p>
                  <p className="mt-0.5 font-medium">
                    {runtime.storybook ? "Storybook" : runtime.framework}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Command</p>
                  <p className="mt-0.5 truncate font-mono font-medium">
                    {runtime.command ?? (customCommand.trim() || "Not detected")}
                  </p>
                </div>
              </div>

              {!runtime.command && (
                <div className="mt-4">
                  <label
                    htmlFor="page-preview-command"
                    className="mb-1.5 block text-[11px] font-medium text-foreground"
                  >
                    Development server command
                  </label>
                  <Input
                    id="page-preview-command"
                    value={customCommand}
                    onChange={(event) => setCustomCommand(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void launch();
                    }}
                    aria-label="Development server command"
                    placeholder="npm run dev"
                    className="h-8 bg-muted/50 font-mono text-xs"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
              )}

              {terminalPrompt && (
                <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                  <div className="flex items-start gap-2">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium text-foreground">
                        The preview command is waiting for an answer
                      </p>
                      <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                        {terminalPrompt.question}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void answerTerminalPrompt("yes")}
                    >
                      <Check className="h-3.5 w-3.5" />
                      Yes
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void answerTerminalPrompt("no")}
                    >
                      <X className="h-3.5 w-3.5" />
                      No
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void answerTerminalPrompt("default")}
                    >
                      Enter (default)
                    </Button>
                  </div>
                  <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                    The answer is typed into this preview&apos;s integrated
                    terminal, where the full output is available.
                  </p>
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void launch()}
                  disabled={(!runtime.command && !customCommand.trim()) || launching}
                >
                  {launching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  {launching ? "Starting…" : "Start app preview"}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={useAddress}>
                  Open running app
                </Button>
              </div>

              {!runtime.command && (
                <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                  The command runs from the workspace root and is remembered for this
                  workspace. You can also enter the URL of an already running local app above.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {screenshotDestinationOpen && screenshotDraft && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-6"
            onClick={() => !savingScreenshot && setScreenshotDestinationOpen(false)}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="screenshot-destination-title"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ type: "spring", stiffness: 300, damping: 28 }}
              onClick={(event) => event.stopPropagation()}
              className="modal-surface island flex w-full max-w-[560px] flex-col overflow-hidden"
            >
              <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
                <Camera className="h-4 w-4 text-primary" />
                <span id="screenshot-destination-title" className="text-sm font-medium">
                  Send screenshot to chat
                </span>
              </div>
              <div className="flex flex-col gap-3 p-4">
                <div className="rounded-lg border border-border/60 bg-muted/35 px-3 py-2">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Captured page route
                  </p>
                  <p
                    className="mt-1 truncate font-mono text-xs text-foreground"
                    title={screenshotSourceUrl ?? previewUrl ?? undefined}
                  >
                    {previewRouteLabel(screenshotSourceUrl ?? previewUrl)}
                  </p>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  The screenshot and this route will be added to the destination you choose.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-20 min-w-0 w-full items-start justify-start gap-3 whitespace-normal px-3 py-3 text-left"
                    disabled={!currentSessionTitle || savingScreenshot}
                    onClick={() => void saveScreenshot("current")}
                  >
                    <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="flex min-w-0 flex-col items-start">
                      <span className="text-xs font-medium">Current chat</span>
                      <span className="mt-0.5 max-w-full truncate text-[11px] font-normal text-muted-foreground">
                        {currentSessionTitle ?? "No chat selected"}
                      </span>
                    </span>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-auto min-h-20 min-w-0 w-full items-start justify-start gap-3 whitespace-normal px-3 py-3 text-left"
                    disabled={savingScreenshot}
                    onClick={() => void saveScreenshot("new")}
                  >
                    <Plus className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <span className="flex min-w-0 flex-col items-start">
                      <span className="text-xs font-medium">New chat</span>
                      <span className="mt-0.5 text-[11px] font-normal leading-snug text-muted-foreground">
                        Start a focused screenshot thread
                      </span>
                    </span>
                  </Button>
                </div>
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={savingScreenshot}
                    onClick={() => setScreenshotDestinationOpen(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
