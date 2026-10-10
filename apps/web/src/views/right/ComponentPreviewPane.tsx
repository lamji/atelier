import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Terminal as TerminalIcon,
} from "lucide-react";
import type { TerminalSession } from "@atelier/protocol";
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
  packageManifestPaths,
  previewCommandAtPort,
  pubspecPaths,
  resolveBackendProjects,
  resolveComponentPreviews,
  type BackendProjectRuntime,
  type ComponentPreviewRuntime,
} from "@/lib/component-preview";
import { openExternal } from "@/lib/desktop";
import { bridge } from "@/services/bridge-client";
import { registerPreviewScreenRect } from "@/services/preview-context";
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

function previewTerminalName(runtime: ComponentPreviewRuntime): string {
  return `${runtime.projectName} page preview · ${runtime.projectDir || "."}`;
}

function findPreviewTerminal(
  runtime: ComponentPreviewRuntime,
  runtimes: ComponentPreviewRuntime[],
  sessions: TerminalSession[]
): TerminalSession | undefined {
  const current = sessions.find(
    (session) => session.alive && session.name === previewTerminalName(runtime)
  );
  if (current) return current;

  // Recover the pre-multi-preview terminal name only when it identifies one
  // project unambiguously; duplicate package names must never share a PTY.
  const uniqueLegacyName =
    runtimes.filter((candidate) => candidate.projectName === runtime.projectName)
      .length === 1;
  return uniqueLegacyName
    ? sessions.find(
        (session) =>
          session.alive && session.name === `${runtime.projectName} page preview`
      )
    : undefined;
}

function backendTargetKey(runtime: BackendProjectRuntime): string {
  return `backend:${runtime.projectDir || "."}:${runtime.script}`;
}

function backendTerminalName(runtime: BackendProjectRuntime): string {
  return `${runtime.projectName} backend · ${runtime.projectDir || "."}`;
}

function findBackendTerminal(
  runtime: BackendProjectRuntime,
  sessions: TerminalSession[]
): TerminalSession | undefined {
  return sessions.find(
    (session) => session.alive && session.name === backendTerminalName(runtime)
  );
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
  const previewLayoutSignature = useMemo(
    () =>
      workspaceTree
        ? [
            ...packageManifestPaths(workspaceTree),
            ...pubspecPaths(workspaceTree),
          ].join("|")
        : "",
    [workspaceTree]
  );
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const [runtimes, setRuntimes] = useState<ComponentPreviewRuntime[]>([]);
  const [backends, setBackends] = useState<BackendProjectRuntime[]>([]);
  const [backendKey, setBackendKey] = useState<string | null>(null);
  const [runtimeKey, setRuntimeKey] = useState<string | null>(null);
  const runtime =
    runtimes.find((candidate) => candidate.storageKey === runtimeKey) ??
    runtimes[0] ??
    null;
  const backendRuntime =
    backends.find((candidate) => backendTargetKey(candidate) === backendKey) ??
    null;
  const selectedTargetKey = backendRuntime
    ? backendTargetKey(backendRuntime)
    : runtime
      ? `frontend:${runtime.storageKey}`
      : "";
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
  const backendRunning = Boolean(
    backendRuntime &&
      !launching &&
      managedTermId &&
      findBackendTerminal(backendRuntime, terminalSessions)?.id === managedTermId
  );
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
  // Captures output from the managed preview terminal for inline logs.
  const [terminalLog, setTerminalLog] = useState<string>("");
  const [logModalOpen, setLogModalOpen] = useState<boolean>(false);

  const previewCanvasRef = useRef<HTMLDivElement>(null);
  const previewScreenRef = useRef<HTMLDivElement>(null);

  // Expose the live preview surface's on-screen rect so the frontend test
  // runner can grab end-of-step evidence through the same capture path the
  // screenshot button uses — no reaching into this component's internals.
  useEffect(() => {
    registerPreviewScreenRect(() => {
      const screen = previewScreenRef.current;
      if (!screen) return null;
      const rect = screen.getBoundingClientRect();
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
    });
    return () => registerPreviewScreenRect(null);
  }, []);
  const [screenshotDraft, setScreenshotDraft] = useState<string | null>(null);
  const [screenshotSourceUrl, setScreenshotSourceUrl] = useState<string | null>(null);
  // Iframe CSS px behind the draft; the viewport may change before it is saved.
  const [screenshotCaptureSize, setScreenshotCaptureSize] =
    useState<PendingImage["captureSize"]>(undefined);
  const [screenshotDestinationOpen, setScreenshotDestinationOpen] = useState(false);
  const [capturingScreenshot, setCapturingScreenshot] = useState(false);
  const [savingScreenshot, setSavingScreenshot] = useState(false);
  const [highlights, setHighlights] = useState<HighlightRect[]>([]);
  const [selection, setSelection] = useState<HighlightRect | null>(null);
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  const handledReviewTaskId = useRef<string | null>(null);
  const previousManagedTermId = useRef<string | null>(managedTermId);
  const launchTimerRef = useRef<number | null>(null);
  const reservedPortsRef = useRef(new Set<number>());
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
      const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
      // Once the server is bound the allocator's bind probe protects it; the
      // reservation only closes the gap between allocation and readiness.
      if (Number.isInteger(port)) reservedPortsRef.current.delete(port);
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
      setMessage(null);
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
      setTerminalLog((previous) => `${previous}${data}`.slice(-16_384));
      if (backendRuntime) return;
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
  }, [backendRuntime, managedTermId, openPreviewAt]);

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
      setMessage(null);
    }
    previousManagedTermId.current = managedTermId;
  }, [managedTermId]);

  useEffect(() => {
    if (
      managedTermId &&
      !terminalSessions.some(
        (session) => session.id === managedTermId && session.alive
      )
    ) {
      onManagedTermChange(null);
    }
  }, [managedTermId, onManagedTermChange, terminalSessions]);

  useEffect(() => {
    let cancelled = false;
    setRuntimes([]);
    setBackends([]);
    setBackendKey(null);
    setRuntimeKey(null);
    previewUrlRef.current = null;
    setPreviewUrl(null);
    setMessage(null);
    setLoading(true);

    if (!workspaceTree) return;

    void Promise.all([
      resolveComponentPreviews(workspaceTree, workspaceRoot),
      resolveBackendProjects(workspaceTree, workspaceRoot),
    ])
      .then(([next, backends]) => {
        if (cancelled) return;
        setRuntimes(next);
        setBackends(backends);
        setRuntimeKey(next[0]?.storageKey ?? null);
        if (next.length === 0) {
          setMessage("Atelier could not find a browser-capable project in this workspace.");
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMessage(
          error instanceof Error
            ? error.message
            : "Atelier could not discover preview runtimes."
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // The tree object changes on every save; only project layout changes
    // should rediscover targets and reset the selected preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewLayoutSignature, workspaceRoot]);

  useEffect(() => {
    if (backendRuntime) return;

    let cancelled = false;
    previewUrlRef.current = null;
    setPreviewUrl(null);
    setMessage(null);
    setTerminalPrompt(null);
    setLaunching(false);

    if (!runtime) return;

    let savedAddress = "";
    let savedCommand = "";
    try {
      savedAddress = localStorage.getItem(runtime.storageKey) ?? "";
      savedCommand =
        localStorage.getItem(`${runtime.storageKey}::command`) ?? "";
    } catch {
      // A blocked localStorage only means preview settings are not remembered.
    }
    const nextAddress = savedAddress || runtime.defaultUrl;
    setAddress(nextAddress);
    setCustomCommand(savedCommand);

    const existing = findPreviewTerminal(
      runtime,
      runtimes,
      useTerminalStore.getState().sessions
    );
    if (!existing) {
      previousManagedTermId.current = null;
      onManagedTermChange(null);
      setLoading(false);
      return;
    }

    onManagedTermChange(existing.id);
    setLoading(false);
    void bridge
      .rpc("terminal.getHistory", { termId: existing.id })
      .then(({ data }) => {
        if (cancelled) return;
        const historyUrl = extractLocalPreviewUrl(data);
        let recoveredUrl: URL;
        try {
          recoveredUrl = new URL(historyUrl ?? nextAddress);
          if (recoveredUrl.origin === window.location.origin) {
            recoveredUrl = new URL(runtime.defaultUrl);
          }
        } catch {
          recoveredUrl = new URL(runtime.defaultUrl);
        }

        // Terminal history is bounded, so probe the remembered address when
        // the startup URL has already scrolled out of the terminal buffer.
        const normalizedAddress = recoveredUrl.href.replace(/\/$/, "");
        setAddress(normalizedAddress);
        setMessage("Checking the existing preview server…");
        setLaunching(true);
        launchTimerRef.current = window.setTimeout(() => {
          launchTimerRef.current = null;
          setLaunching(false);
          setMessage("The previous preview server is no longer reachable. Start it again.");
        }, 10_000);
        try {
          localStorage.setItem(runtime.storageKey, normalizedAddress);
        } catch {
          // Preview remains usable when localStorage is blocked or full.
        }
      })
      .catch(() => {
        if (cancelled) return;
        setMessage("The preview terminal is running, but its address could not be recovered.");
      });

    return () => {
      cancelled = true;
      if (launchTimerRef.current !== null) {
        window.clearTimeout(launchTimerRef.current);
        launchTimerRef.current = null;
      }
    };
  }, [backendRuntime, onManagedTermChange, runtime, runtimes]);

  useEffect(() => {
    if (!backendRuntime) return;

    previewUrlRef.current = null;
    setPreviewUrl(null);
    setAddress("");
    setMessage(null);
    setTerminalPrompt(null);
    setLaunching(false);
    setLoading(false);

    let savedCommand = "";
    try {
      savedCommand =
        localStorage.getItem(`${backendTargetKey(backendRuntime)}::command`) ?? "";
    } catch {
      // A blocked localStorage only means preview settings are not remembered.
    }
    setCustomCommand(savedCommand);

    const existing = findBackendTerminal(
      backendRuntime,
      useTerminalStore.getState().sessions
    );
    if (!existing) {
      previousManagedTermId.current = null;
      onManagedTermChange(null);
      setTerminalLog("");
      return;
    }

    onManagedTermChange(existing.id);
    void bridge
      .rpc("terminal.getHistory", { termId: existing.id })
      .then(({ data }) => setTerminalLog(data.slice(-16_384)))
      .catch(() => setTerminalLog(""));
  }, [backendRuntime, onManagedTermChange]);

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

  const stopProject = async (
    termId: string,
    projectName: string,
    projectType: "frontend" | "backend"
  ) => {
    const selected = termId === managedTermId;
    try {
      await bridge.rpc("terminal.kill", { termId });
      useTerminalStore.getState().removeSession(termId);
      if (selected) {
        if (launchTimerRef.current !== null) {
          window.clearTimeout(launchTimerRef.current);
          launchTimerRef.current = null;
        }
        previousManagedTermId.current = null;
        onManagedTermChange(null);
        previewUrlRef.current = null;
        setPreviewUrl(null);
        setLoading(false);
        setLaunching(false);
        setTerminalPrompt(null);
        setTerminalLog("");
      }
      setMessage(
        `Stopped ${projectName} ${projectType === "backend" ? "backend" : "preview"}.`
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : `The ${projectType} project could not be stopped.`
      );
    }
  };

  const stopBackend = async () => {
    if (!backendRuntime) return;
    const terminal = findBackendTerminal(backendRuntime, terminalSessions);
    if (!terminal) return;
    await stopProject(terminal.id, backendRuntime.projectName, "backend");
  };

  const launch = async () => {
    if (!runtime || launching) return;

    if (backendRuntime) {
      const command =
        (backendRuntime.missingBinary ? customCommand.trim() : "") ||
        backendRuntime.command;
      if (!command) {
        setMessage("Enter the command that starts your backend server.");
        return;
      }

      previewUrlRef.current = null;
      setPreviewUrl(null);
      setAddress("");
      setLoading(false);
      setLaunching(true);
      setMessage(`Starting ${backendRuntime.framework}…`);
      setTerminalPrompt(null);
      setTerminalLog("");
      setLogModalOpen(true);

      try {
        if (backendRuntime.missingBinary) {
          try {
            localStorage.setItem(
              `${backendTargetKey(backendRuntime)}::command`,
              command
            );
          } catch {
            // The backend remains runnable when localStorage is unavailable.
          }
        }

        const sessions = useTerminalStore.getState().sessions;
        const existing = findBackendTerminal(backendRuntime, sessions);
        let termId: string;
        if (existing) {
          termId = existing.id;
          useTerminalStore.getState().setActive(termId);
          onManagedTermChange(termId);
          await bridge.rpc("terminal.interrupt", { termId });
        } else {
          const separator = workspaceRoot?.includes("\\") ? "\\" : "/";
          const root = workspaceRoot?.replace(/[\\/]+$/, "") ?? "";
          const child = backendRuntime.projectDir.replace(/\//g, separator);
          const cwd = root && child ? `${root}${separator}${child}` : root || undefined;
          const { session } = await bridge.rpc("terminal.create", {
            ...(cwd ? { cwd } : {}),
            name: backendTerminalName(backendRuntime),
          });
          termId = session.id;
          useTerminalStore.getState().addSession(session);
          onManagedTermChange(termId);
        }

        await bridge.rpc("terminal.write", {
          termId,
          data: `${command}\r`,
        });
        setLaunching(false);
        setMessage(
          existing
            ? `Restarted ${backendRuntime.projectName} backend.`
            : `Started ${backendRuntime.projectName} backend.`
        );
      } catch (error) {
        setLaunching(false);
        setMessage(
          error instanceof Error
            ? error.message
            : "The backend server could not be started."
        );
      }
      return;
    }

    // A detected command whose binary is missing here is not runnable, so a
    // command the user typed instead of installing it wins over it.
    const baseCommand =
      (runtime.missingBinary ? customCommand.trim() : "") ||
      runtime.command ||
      customCommand.trim();
    if (!baseCommand) {
      setMessage("Enter the command that starts your local development server.");
      return;
    }

    previewUrlRef.current = null;
    setPreviewUrl(null);
    // Prevent the readiness effect from probing the previously selected
    // project's address while the allocator is choosing this launch's port.
    setAddress("");
    setLoading(false);
    setLaunching(true);
    setMessage("Finding a free local port…");
    setTerminalPrompt(null);
    setTerminalLog("");
    setLogModalOpen(true);

    let allocatedPort: number | null = null;
    let commandStarted = false;
    try {
      const reservations = new Set(reservedPortsRef.current);
      for (const candidate of runtimes) {
        if (
          !findPreviewTerminal(
            candidate,
            runtimes,
            useTerminalStore.getState().sessions
          )
        ) {
          continue;
        }
        try {
          const saved = localStorage.getItem(candidate.storageKey);
          if (!saved) continue;
          const parsed = new URL(saved);
          const port = Number(
            parsed.port || (parsed.protocol === "https:" ? 443 : 80)
          );
          if (Number.isInteger(port)) reservations.add(port);
        } catch {
          // The bind probe still catches a running server without saved state.
        }
      }

      const allocation = await bridge.rpc("terminal.freePort", {
        start: runtime.defaultPort,
        exclude: [...reservations],
      });
      allocatedPort = allocation.port;
      reservedPortsRef.current.add(allocatedPort);

      const launchUrl = new URL(runtime.defaultUrl);
      launchUrl.port = String(allocatedPort);
      const normalizedAddress = launchUrl.href.replace(/\/$/, "");
      setAddress(normalizedAddress);
      try {
        localStorage.setItem(runtime.storageKey, normalizedAddress);
        if (!runtime.command || runtime.missingBinary) {
          localStorage.setItem(
            `${runtime.storageKey}::command`,
            baseCommand
          );
        }
      } catch {
        // The launch remains usable when localStorage is blocked or full.
      }

      const command = previewCommandAtPort(
        runtime,
        baseCommand,
        allocatedPort
      );
      const chained = runtime.prepareCommand
        ? `${runtime.prepareCommand} && ${command}`
        : command;
      const windows = workspaceRoot?.includes("\\") ?? false;
      const isolatedCommand = windows
        ? `Remove-Item Env:ATELIER_WEB_PORT -ErrorAction SilentlyContinue; $env:BROWSER='none'; $env:PORT='${allocatedPort}'; ${chained}`
        : `unset ATELIER_WEB_PORT; export BROWSER=none; export PORT=${allocatedPort}; ${chained}`;

      const sessions = useTerminalStore.getState().sessions;
      const existing = findPreviewTerminal(runtime, runtimes, sessions);
      let termId: string;
      if (existing) {
        termId = existing.id;
        useTerminalStore.getState().setActive(termId);
        onManagedTermChange(termId);
        // Starting an existing preview is an explicit restart. Stop only this
        // project's process tree; every other preview terminal stays alive.
        await bridge.rpc("terminal.interrupt", { termId });
      } else {
        const separator = workspaceRoot?.includes("\\") ? "\\" : "/";
        const root = workspaceRoot?.replace(/[\\/]+$/, "") ?? "";
        const child = runtime.projectDir.replace(/\//g, separator);
        const cwd = root && child ? `${root}${separator}${child}` : root || undefined;
        const { session } = await bridge.rpc("terminal.create", {
          ...(cwd ? { cwd } : {}),
          name: previewTerminalName(runtime),
        });
        termId = session.id;
        useTerminalStore.getState().addSession(session);
        // Publish the id before writing so URL detection sees the first output.
        onManagedTermChange(termId);
      }

      await bridge.rpc("terminal.write", {
        termId,
        data: `${isolatedCommand}\r`,
      });
      commandStarted = true;
      setMessage(
        runtime.prepareCommand
          ? `${runtime.prepareReason ?? "Preparing the web build"}, then starting it…`
          : existing
            ? `Restarting ${runtime.projectName} on port ${allocatedPort}…`
            : `Starting ${runtime.storybook ? "Storybook" : runtime.framework} on port ${allocatedPort}…`
      );
      if (launchTimerRef.current !== null) {
        window.clearTimeout(launchTimerRef.current);
      }
      launchTimerRef.current = window.setTimeout(
        () => {
          launchTimerRef.current = null;
          reservedPortsRef.current.delete(allocation.port);
          setLaunching(false);
          setMessage(
            "The preview server did not become reachable. Check its integrated terminal output, then try again."
          );
        },
        runtime.prepareCommand ? 180_000 : 30_000
      );
    } catch (error) {
      if (allocatedPort !== null && !commandStarted) {
        reservedPortsRef.current.delete(allocatedPort);
      }
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
    setScreenshotCaptureSize(undefined);
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
    // The iframe is drawn scaled (screenScale / viewportScale) but lays out
    // at its real CSS viewport, so a screenshot pixel is not an iframe
    // pixel. Measuring the iframe's drawn vs. laid-out width gives the
    // scale exactly, whichever branch rendered it.
    const iframe = screen.querySelector("iframe");
    const drawnWidth = iframe?.getBoundingClientRect().width ?? 0;
    const scale =
      iframe && drawnWidth > 0 && iframe.offsetWidth > 0
        ? drawnWidth / iframe.offsetWidth
        : 1;
    return {
      dataUrl: capture.dataUrl,
      sourceUrl: capture.frameUrl ?? previewUrl,
      captureSize: {
        width: Math.round(rect.width / scale),
        height: Math.round(rect.height / scale),
      },
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
      setScreenshotCaptureSize(capture.captureSize);
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
          // The rects ride along un-burned so the send can name the DOM
          // text under them; the pixels alone only show the model a box.
          highlights: highlights.length > 0 ? highlights.map((h) => ({ ...h })) : undefined,
          captureSize: screenshotCaptureSize,
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

  const displayedBackend = backendRuntime ?? backends[0] ?? null;
  const selectedCommand = backendRuntime?.command ?? runtime.command;
  const selectedMissingBinary =
    backendRuntime?.missingBinary ?? runtime.missingBinary;

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
  /**
   * A laptop is the screen Atelier is already running on, so a small bezelled
   * laptop drawn inside the pane spends the page's space on a picture of a
   * lid. Laptop therefore drops the frame and takes the whole canvas: the
   * iframe keeps the exact 1440 CSS px width a real laptop reports, so
   * breakpoints still behave, and its height is whatever the pane can show at
   * that scale — full bleed, no letterboxing. Tablet and mobile keep their
   * frames, where the device shape is the thing being previewed.
   */
  const frameless = viewport === "laptop";
  const framelessScale =
    frameless && previewCanvasSize.width > 0
      ? previewCanvasSize.width / VIEWPORTS.laptop.width
      : 1;
  const screenScale = frameless ? framelessScale : 1;
  const screenSize = frameless
    ? {
        width: VIEWPORTS.laptop.width,
        height:
          previewCanvasSize.height > 0
            ? Math.round(previewCanvasSize.height / framelessScale)
            : VIEWPORTS.laptop.height,
      }
    : { width: viewportConfig.width, height: viewportConfig.height };

  /** One screen for both branches: only the chrome around it differs. */
  const previewScreen = previewUrl ? (
    <>
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/85">
          <Loader2 className="h-5 w-5 animate-spin text-primary/70" />
          <span className="ml-2 text-xs text-muted-foreground">Loading preview…</span>
        </div>
      )}
      <iframe
        key={frameKey}
        title={`${runtime.projectName} page preview`}
        src={previewUrl}
        className="border-0 bg-white"
        style={{
          width: screenSize.width,
          height: screenSize.height,
          transform: `scale(${screenScale})`,
          transformOrigin: "top left",
        }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
        allow="clipboard-read; clipboard-write"
        onLoad={() => setLoading(false)}
      />
    </>
  ) : null;

  return (
    <div className="flex h-full flex-col bg-muted/15">
      {/*
       * Toolbar controls carry the card surface plus a hairline rather than a
       * `bg-muted` fill. Muted is one step off the canvas, which is a visible
       * lift on dark (#212f32 on #0d1314) but not in light (#eff3f3 on
       * #eef1f2) — there the fills vanished and the strip read as bare text.
       */}
      <div className="flex min-w-0 items-center gap-1.5 border-b border-border bg-background px-2 py-1.5">
        <form
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (backendRuntime) {
              void launch();
              return;
            }
            useAddress();
          }}
        >
          {runtimes.length + backends.length > 1 && (
            <Select
              value={selectedTargetKey}
              onChange={(value) => {
                if (value === selectedTargetKey) return;
                setLoading(true);
                if (value.startsWith("backend:")) {
                  setBackendKey(value);
                  return;
                }
                setBackendKey(null);
                setRuntimeKey(value.slice("frontend:".length));
              }}
              options={[
                ...runtimes.map((candidate) => {
                  const terminal = findPreviewTerminal(
                    candidate,
                    runtimes,
                    terminalSessions
                  );
                  return {
                    value: `frontend:${candidate.storageKey}`,
                    label: `Frontend · ${candidate.projectName}`,
                    hint: `${terminal ? "Running" : "Ready"} · ${candidate.framework} · ${candidate.projectDir || "workspace root"}`,
                    action: terminal
                      ? {
                          label: "Stop",
                          onClick: () =>
                            stopProject(
                              terminal.id,
                              candidate.projectName,
                              "frontend"
                            ),
                        }
                      : undefined,
                  };
                }),
                ...backends.map((candidate) => {
                  const terminal = findBackendTerminal(
                    candidate,
                    terminalSessions
                  );
                  return {
                    value: backendTargetKey(candidate),
                    label: `Backend · ${candidate.projectName}`,
                    hint: `${terminal ? "Running" : "Ready"} · ${candidate.framework} · ${candidate.command}`,
                    action: terminal
                      ? {
                          label: "Stop",
                          onClick: () =>
                            stopProject(
                              terminal.id,
                              candidate.projectName,
                              "backend"
                            ),
                        }
                      : undefined,
                  };
                }),
              ]}
              className="h-7 w-[min(14rem,28vw)] shrink-0 border border-border bg-card"
              menuClassName="w-[min(24rem,80vw)]"
            />
          )}
          {backendRuntime ? (
            <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-card px-2 text-[11px]">
              <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono">{backendRuntime.command}</span>
            </div>
          ) : (
            <>
              <Server className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <Input
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                aria-label="Page preview URL"
                placeholder={runtime.defaultUrl}
                className="h-7 min-w-0 flex-1 border border-border bg-card font-mono text-[11px] focus-visible:border-ring focus-visible:bg-card"
                spellCheck={false}
              />
              <Button
                type="submit"
                size="sm"
                variant="secondary"
                className="h-7 shrink-0 border border-border"
              >
                Go
              </Button>
            </>
          )}
        </form>
        <div
          className="ml-1 flex shrink-0 items-center rounded-md border border-border bg-card p-0.5"
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
            className="h-7 w-[min(13rem,24vw)] border border-border bg-card"
            menuClassName="w-[min(19rem,80vw)]"
          />
        )}
        <span
          className="hidden shrink-0 font-mono text-[10px] text-muted-foreground xl:inline"
          aria-live="polite"
        >
          {screenSize.width} × {screenSize.height}
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

      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden",
          frameless && previewUrl ? "p-0" : "p-3"
        )}
      >
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
            frameless ? (
              <div
                ref={previewScreenRef}
                className="relative h-full w-full overflow-hidden bg-white"
              >
                {previewScreen}
              </div>
            ) : (
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
                    {previewScreen}
                  </div>

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
            )
          ) : (
            <div className="m-auto w-full max-w-lg rounded-xl border border-border/70 bg-card p-6 shadow-sm">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-primary/10 p-2 text-primary">
                  {backendRuntime ? (
                    <Server className="h-5 w-5" />
                  ) : (
                    <Box className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {backendRuntime ? "Start the backend server" : "Preview the full page"}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {backendRuntime ? (
                      <>
                        Atelier detected{" "}
                        <span className="font-medium text-foreground">
                          {backendRuntime.framework}
                        </span>{" "}
                        in{" "}
                        <span className="font-mono text-foreground">
                          {backendRuntime.projectName}
                        </span>
                        . Start its existing package script and inspect the live output in
                        the integrated terminal below.
                      </>
                    ) : runtime.command ? (
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

              <div className="mt-5 flex flex-wrap gap-4 rounded-lg bg-muted/45 p-3 text-[11px]">
                <div className="min-w-0 flex-1">
                  <p className="text-muted-foreground">Frontend</p>
                  <p className="mt-0.5 font-medium">
                    {runtime.storybook ? "Storybook" : runtime.framework}
                    {" · "}
                    <span className="font-mono">
                      {runtime.command ?? (customCommand.trim() || "Not detected")}
                    </span>
                  </p>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-muted-foreground">Backend</p>
                  {displayedBackend ? (
                    <p className="mt-0.5 truncate font-medium">
                      {displayedBackend.framework}
                      {" · "}
                      <span className="font-mono">{displayedBackend.command}</span>
                    </p>
                  ) : (
                    <p className="mt-0.5 text-muted-foreground">Not detected</p>
                  )}
                </div>
              </div>

              {selectedMissingBinary && (
                <div className="mt-3 flex items-start justify-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-[11px] leading-relaxed text-destructive">
                  <span>
                    <span className="font-mono font-medium">
                      {selectedMissingBinary}
                    </span>{" "}
                    is not installed on this machine, so this command cannot
                    start. Install it, or enter a command below that uses a
                    package manager you have.
                  </span>
                </div>
              )}

              {(!selectedCommand || selectedMissingBinary) && (
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
                  onClick={() =>
                    void (backendRunning ? stopBackend() : launch())
                  }
                  disabled={
                    !backendRunning &&
                    ((!selectedCommand && !customCommand.trim()) || launching)
                  }
                >
                  {backendRunning ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : launching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  {backendRunning
                    ? "Stop backend"
                    : launching
                      ? "Starting…"
                      : backendRuntime
                        ? "Start backend"
                        : "Start app preview"}
                </Button>
                {!backendRuntime && (
                  <Button type="button" size="sm" variant="outline" onClick={useAddress}>
                    Open running app
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!managedTermId && !launching}
                  onClick={() => setLogModalOpen((open) => !open)}
                >
                  <TerminalIcon className="h-3.5 w-3.5" />
                  {logModalOpen ? "Hide terminal" : "View terminal"}
                </Button>
              </div>

              {logModalOpen && (
                <div className="mt-3 overflow-hidden rounded-lg border border-border/70 bg-zinc-950">
                  <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                      <span className="truncate text-[11px] font-medium text-zinc-200">
                        {launching
                          ? "Starting server — output updates live"
                          : backendRuntime
                            ? "Backend terminal"
                            : "Preview terminal"}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
                      aria-label="Hide preview terminal"
                      title="Hide preview terminal"
                      onClick={() => setLogModalOpen(false)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <pre
                    className="h-36 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-zinc-100"
                    aria-live="polite"
                  >
                    {terminalLog || "Waiting for preview command output…"}
                  </pre>
                </div>
              )}

              {!selectedCommand && (
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
