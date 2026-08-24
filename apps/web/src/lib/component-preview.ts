import type { FileTreeNode } from "@atelier/protocol";
import { bridge } from "@/services/bridge-client";

export interface ComponentPreviewRuntime {
  projectDir: string;
  projectName: string;
  framework: string;
  packageManager: "pnpm" | "npm" | "yarn" | "bun";
  script: string | null;
  command: string | null;
  defaultUrl: string;
  defaultPort: number;
  /** How the selected free port reaches this framework's dev server. */
  portStrategy: "direct" | "script" | "environment" | "flutter";
  storageKey: string;
  storybook: boolean;
  /**
   * A command to run BEFORE the dev server, when the web target needs
   * dependencies the project does not have yet. Expo is the case that
   * matters: `expo start --web` fails on a project that has never run on
   * web, because react-dom and react-native-web are not installed. Making
   * the user read that error, find the three package names and install
   * them by hand is a chore Atelier can just do.
   */
  prepareCommand?: string;
  /** Why that command is there, for the launch message. */
  prepareReason?: string;
}

interface PreviewPackageManifest {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Dependencies that mean "this renders in a browser".
 *
 * The old rule was "has a dev script", which is true of an Express API, a
 * Discord bot and a CLI — all of which got a Page preview tab that could
 * only ever show a connection error. A dev script says something runs; it
 * does not say a browser can look at it.
 */
const WEB_DEPS = [
  "next",
  "nuxt",
  "@angular/core",
  "svelte",
  "vue",
  "react-dom",
  "vite",
  "@remix-run/react",
  "astro",
  "gatsby",
  "@sveltejs/kit",
  "solid-js",
  "preact",
  "@storybook/react",
  "@storybook/vue3",
  "react-native-web",
  "expo",
] as const;

/**
 * Cross-platform toolkits that CAN target the web but do not by default.
 *
 * React Native is the reason this exists: a bare RN project runs on a
 * simulator, and its web build is a separate opt-in. Expo can always do web
 * (`expo start --web`) once react-dom and react-native-web are present,
 * which is a thing to install rather than a reason to hide the tab.
 */
/** How a package manager is asked to run a binary from node_modules. */
type Runner = string;

/**
 * A cross-platform toolkit, and what it takes to see it in a browser.
 *
 * The point of a table rather than a special case: "does this framework do
 * web, and how" is a question about frameworks, and there are a lot of them.
 * Expo was the first one handled and immediately implied the rest — Flutter
 * runs in Chrome, Ionic and Capacitor ARE web apps wearing a native shell,
 * NativeScript and MAUI have no browser target at all. Each of those is a
 * row here, not a branch somewhere.
 *
 * `web: null` is a real answer, and the important one: it means the Page
 * preview tab stays hidden rather than opening onto a server that will
 * never exist.
 */
interface MobileToolkit {
  id: string;
  /** What the preview calls it. */
  label: string;
  /** Marks a project as this toolkit's. */
  deps: string[];
  web: {
    /** The command that serves it to a browser. */
    command: (runner: Runner, script: string | null, pm: string) => string;
    port: number;
    /**
     * What has to happen first on a project that has never built for web —
     * undefined when nothing does.
     */
    prepare?: (deps: Record<string, string>, runner: Runner) => string | undefined;
    reason?: string;
  } | null;
}

const MOBILE_TOOLKITS: MobileToolkit[] = [
  {
    id: "expo",
    label: "Expo (web)",
    deps: ["expo"],
    web: {
      // `npm start` opens Metro's dev menu and waits for a keypress —
      // "press w to open web" — which is a terminal ritual with no reason
      // to exist in an editor that has a browser pane. `--web` also means
      // "open the web app", which Expo takes literally and answers with a
      // system browser window; the launch environment sets BROWSER=none so
      // it only serves. See ComponentPreviewPane.launch.
      command: (runner) => `${runner} expo start --web`,
      port: 8081,
      prepare: (deps, runner) =>
        deps["react-dom"] && deps["react-native-web"]
          ? undefined
          : `${runner} expo install react-dom react-native-web @expo/metro-runtime`,
      reason: "Installing this project's web dependencies (react-dom, react-native-web)",
    },
  },
  {
    id: "react-native",
    label: "React Native (web)",
    deps: ["react-native"],
    // Bare RN reaches the browser only through react-native-web and a
    // bundler config the project owns, which surfaces as a "web" script. No
    // script, no target — inventing a webpack invocation for someone else's
    // project would be a guess that fails in its own terminal.
    web: {
      command: (_runner, script, pm) =>
        pm === "npm" || pm === "bun" ? `${pm} run ${script}` : `${pm} ${script}`,
      port: 3000,
    },
  },
  {
    id: "ionic",
    label: "Ionic",
    deps: ["@ionic/core", "@ionic/angular", "@ionic/react", "@ionic/vue"],
    // Already a web app; its own dev script is the web build — but that
    // script pops a system browser window. `ionic serve` opens one by
    // default, and so do the `ng serve` / `vite` / `vue-cli-service serve`
    // scripts behind the other Ionic templates. All four read `--no-open`
    // the same way, and this preview belongs in the pane, not in Chrome.
    web: {
      command: (_runner, script, pm) =>
        pm === "npm" || pm === "bun"
          ? `${pm} run ${script} -- --no-open`
          : `${pm} ${script} --no-open`,
      port: 8100,
    },
  },
  {
    id: "capacitor",
    label: "Capacitor",
    deps: ["@capacitor/core"],
    web: {
      command: (_runner, script, pm) =>
        pm === "npm" || pm === "bun" ? `${pm} run ${script}` : `${pm} ${script}`,
      port: 5173,
    },
  },
  {
    id: "cordova",
    label: "Cordova",
    deps: ["cordova"],
    web: {
      command: (_runner, script, pm) =>
        pm === "npm" || pm === "bun" ? `${pm} run ${script}` : `${pm} ${script}`,
      port: 8000,
    },
  },
  {
    id: "nativescript",
    label: "NativeScript",
    deps: ["nativescript", "@nativescript/core"],
    // Compiles to native views; there is no browser build to preview.
    web: null,
  },
];

/** The toolkit this project belongs to, if any. */
function mobileToolkitFor(
  deps: Record<string, string>
): MobileToolkit | null {
  return (
    MOBILE_TOOLKITS.find((toolkit) =>
      toolkit.deps.some((dep) => deps[dep] !== undefined)
    ) ?? null
  );
}

const SCRIPT_PRIORITY = [
  "dev",
  "develop",
  "start",
  "serve",
  "preview",
  // Last, because on a web app "web" is a rare alias — but on a React
  // Native project it is THE browser build, and without it in this list a
  // bare RN app could never be recognised as previewable at all.
  "web",
  "storybook",
  "storybook:dev",
] as const;


function workspaceProjectName(workspaceRoot: string | null): string {
  return (
    workspaceRoot
      ?.replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) || "workspace"
  );
}

function previewStorageKey(workspaceRoot: string | null, projectDir: string): string {
  return `atelier.component-preview::${encodeURIComponent(
    `${workspaceRoot ?? "browser"}::${projectDir}`
  )}`;
}

/** Apply an allocated port using the invocation style the runtime accepts. */
export function previewCommandAtPort(
  runtime: ComponentPreviewRuntime,
  command: string,
  port: number
): string {
  if (runtime.portStrategy === "environment") return command;
  if (runtime.portStrategy === "flutter") {
    return command.replace(/--web-port\s+\d{2,5}/, `--web-port ${port}`);
  }
  if (runtime.portStrategy === "direct") return `${command} --port ${port}`;

  // Package scripts need their own argument separator. Ionic's detected
  // command already has one for --no-open, so append beside that argument.
  if (command.includes(" -- ")) return `${command} --port ${port}`;
  if (
    runtime.packageManager === "npm" ||
    runtime.packageManager === "pnpm"
  ) {
    return `${command} -- --port ${port}`;
  }
  return `${command} --port ${port}`;
}

/**
 * The set of manifests a preview could come from. Callers use this as the
 * identity of the tree for preview purposes: the file watcher hands out a new
 * tree object on every file change, but the preview only needs to re-resolve
 * when the manifest layout itself moves.
 */
export function packageManifestPaths(tree: FileTreeNode): string[] {
  const paths: string[] = [];

  const visit = (node: FileTreeNode) => {
    if (node.type === "dir" && node.name === "node_modules") return;
    if (node.type === "file" && node.name === "package.json") {
      paths.push(node.path.replace(/\\/g, "/"));
      return;
    }
    node.children?.forEach(visit);
  };

  visit(tree);
  return paths;
}

/**
 * Flutter projects, which carry no package.json at all.
 *
 * The whole resolver was written around npm manifests, so a Flutter app was
 * invisible to it — no candidate, no preview, no tab, even though a Flutter
 * web build is one of the better previews there is.
 */
export function pubspecPaths(tree: FileTreeNode): string[] {
  const paths: string[] = [];

  const visit = (node: FileTreeNode) => {
    if (node.type === "dir" && (node.name === "node_modules" || node.name === "build")) {
      return;
    }
    if (node.type === "file" && node.name === "pubspec.yaml") {
      paths.push(node.path.replace(/\\/g, "/"));
      return;
    }
    node.children?.forEach(visit);
  };

  visit(tree);
  return paths;
}

/** Directories directly inside a project, for the "has a web/ folder" test. */
function childDirNames(tree: FileTreeNode, projectDir: string): string[] {
  const parts = projectDir.split("/").filter(Boolean);
  let node: FileTreeNode | undefined = tree;
  for (const part of parts) {
    node = node?.children?.find(
      (child) => child.type === "dir" && child.name === part
    );
    if (!node) return [];
  }
  return (node?.children ?? [])
    .filter((child) => child.type === "dir")
    .map((child) => child.name);
}

/**
 * A Flutter app as a preview candidate.
 *
 * The web target is first-class in Flutter, so the browser build needs no
 * extra packages — only that the project has web scaffolding at all. A repo
 * created with `--platforms android,ios` has no web/ directory, and
 * `flutter create . --platforms web` adds one without touching the rest,
 * which is why it can be a prepare step rather than a reason to hide.
 */
async function flutterCandidate(
  pubspecPath: string,
  tree: FileTreeNode,
  workspaceRoot: string | null
): Promise<{ score: number; runtime: ComponentPreviewRuntime } | null> {
  let content: string;
  try {
    content = (await bridge.rpc("fs.readFile", { path: pubspecPath })).content;
  } catch {
    return null;
  }
  // A pubspec that never mentions the Flutter SDK is a plain Dart package —
  // a CLI or a library, with nothing to show in a browser.
  if (!/^\s*(flutter:|sdk:\s*flutter)/m.test(content)) return null;

  const projectDir = pubspecPath.includes("/")
    ? pubspecPath.slice(0, pubspecPath.lastIndexOf("/"))
    : "";
  const projectName =
    content.match(/^name:\s*(\S+)/m)?.[1] ??
    projectDir.split("/").filter(Boolean).at(-1) ??
    workspaceProjectName(workspaceRoot);
  const hasWebDir = childDirNames(tree, projectDir).includes("web");
  // A fixed port, because Flutter picks a random one otherwise and the
  // preview would have nothing to point at.
  const port = 5799;
  // `-d chrome` is the documented Flutter web command and the wrong one
  // here: it launches a real Chrome window and drives the app from there,
  // leaving Atelier's pane pointed at a server that only exists inside
  // Flutter's own browser session. `-d web-server` serves the identical
  // build over http and opens nothing, so the iframe is the app. The cost
  // is hot reload — web-server keeps hot restart on save, not stateful
  // hot reload — which is the right trade for a preview that stays put.

  return {
    // Below a browser-first app, above nothing: same rule as the JS
    // toolkits, so a repo with a Flutter app and a Next.js site previews
    // the site.
    score: 140,
    runtime: {
      projectDir,
      projectName,
      framework: "Flutter (web)",
      packageManager: "npm",
      script: null,
      command: `flutter run -d web-server --web-hostname localhost --web-port ${port}`,
      defaultUrl: `http://localhost:${port}`,
      defaultPort: port,
      portStrategy: "flutter",
      storageKey: previewStorageKey(workspaceRoot, projectDir),
      storybook: false,
      ...(hasWebDir
        ? {}
        : {
            prepareCommand: "flutter create . --platforms web",
            prepareReason: "Adding this project's web target",
          }),
    },
  };
}

async function detectPackageManager(
  manifest: PreviewPackageManifest,
  projectDir: string
): Promise<ComponentPreviewRuntime["packageManager"]> {
  const declared = manifest.packageManager?.split("@")[0];
  if (
    declared === "pnpm" ||
    declared === "npm" ||
    declared === "yarn" ||
    declared === "bun"
  ) {
    return declared;
  }

  const ancestors: string[] = [];
  const projectParts = projectDir.split("/").filter(Boolean);
  for (let depth = projectParts.length; depth >= 0; depth -= 1) {
    ancestors.push(projectParts.slice(0, depth).join("/"));
  }

  const lockfiles = [
    { file: "pnpm-lock.yaml", manager: "pnpm" as const },
    { file: "yarn.lock", manager: "yarn" as const },
    { file: "bun.lockb", manager: "bun" as const },
    { file: "bun.lock", manager: "bun" as const },
    { file: "package-lock.json", manager: "npm" as const },
  ];

  for (const ancestor of ancestors) {
    for (const lock of lockfiles) {
      const lockPath = ancestor ? `${ancestor}/${lock.file}` : lock.file;
      try {
        await bridge.rpc("fs.stat", { path: lockPath });
        return lock.manager;
      } catch {
        // Monorepos commonly keep the package-manager lockfile above the app.
      }
    }
  }

  return "npm";
}

/**
 * Discovers a runnable application from the workspace itself. The open editor
 * file is intentionally irrelevant: Page preview belongs to the workspace,
 * so it scans every visible package manifest and prefers web-framework apps.
 */
export async function resolveComponentPreviews(
  tree: FileTreeNode,
  workspaceRoot: string | null
): Promise<ComponentPreviewRuntime[]> {
  const manifests = await Promise.all(
    packageManifestPaths(tree).map(async (manifestPath) => {
      try {
        const result = await bridge.rpc("fs.readFile", { path: manifestPath });
        return {
          manifest: JSON.parse(result.content) as PreviewPackageManifest,
          manifestPath,
        };
      } catch {
        return null;
      }
    })
  );

  const candidates = await Promise.all(
    manifests.filter((entry) => entry !== null).map(async (entry) => {
      const { manifest, manifestPath } = entry;
      const scripts = manifest.scripts ?? {};
      const script = SCRIPT_PRIORITY.find(
        (name) => typeof scripts[name] === "string"
      );
      if (!script) return null;

      const projectDir = manifestPath.includes("/")
        ? manifestPath.slice(0, manifestPath.lastIndexOf("/"))
        : "";
      const packageManager = await detectPackageManager(manifest, projectDir);
      const deps = { ...manifest.dependencies, ...manifest.devDependencies };
      const framework =
        (deps["@angular/core"] && "Angular") ||
        (deps["next"] && "Next.js") ||
        (deps["nuxt"] && "Nuxt") ||
        (deps["svelte"] && "Svelte") ||
        (deps["vue"] && "Vue") ||
        (deps["react"] && (deps["vite"] ? "React + Vite" : "React")) ||
        (deps["vite"] && "Vite") ||
        "Web";
      const storybook = script === "storybook" || script === "storybook:dev";
      const scriptBody = scripts[script] ?? "";
      const explicitPort =
        scriptBody.match(/(?:--port(?:=|\s+)|\s-p\s+)(\d{2,5})/i)?.[1] ?? null;
      const defaultPort = explicitPort
        ? Number(explicitPort)
        : storybook
          ? 6006
          : framework === "Angular"
            ? 4200
            : framework.includes("Vite")
              ? 5173
              : 3000;
      /*
       * One path for every cross-platform toolkit; see MOBILE_TOOLKITS.
       *
       * A toolkit decides three things a plain web app does not have to:
       * whether a browser build exists at all, what command produces it,
       * and what has to be installed first on a project that has only ever
       * built for a device.
       */
      const runner =
        packageManager === "npm"
          ? "npx"
          : packageManager === "yarn"
            ? "yarn"
            : packageManager === "bun"
              ? "bunx"
              : "pnpm exec";
      const toolkit = mobileToolkitFor(deps);
      /*
       * React Native lists `start` (Metro, for devices) alongside `web`, and
       * `start` wins the priority order — correctly, for every other
       * project. Here it is the wrong one: the browser build is `web`, and
       * running Metro instead would leave the preview waiting on a server
       * that serves a bundle to phones.
       */
      const webScript =
        toolkit?.id === "react-native" && typeof scripts["web"] === "string"
          ? "web"
          : script;
      const webCommand = toolkit?.web?.command(
        runner,
        webScript,
        packageManager
      );
      const command =
        webCommand ??
        (packageManager === "npm" || packageManager === "bun"
          ? `${packageManager} run ${script}`
          : `${packageManager} ${script}`);
      const prepareCommand = toolkit?.web?.prepare?.(deps, runner);
      const prepareReason = prepareCommand ? toolkit?.web?.reason : undefined;
      const projectName =
        manifest.name?.trim() ||
        projectDir.split("/").filter(Boolean).at(-1) ||
        workspaceProjectName(workspaceRoot);

      /*
       * Does a browser have anything to show here?
       *
       * For a toolkit project the table answers it: `web: null` (NativeScript)
       * is a no, and a bare React Native app is a no unless it carries
       * react-native-web AND a script that builds it — inventing a bundler
       * invocation for someone else's project is a guess that fails in their
       * terminal. Everything else is judged on whether it has a browser
       * dependency at all, which is what keeps the tab off an Express API.
       *
       * Electron is deliberately not disqualifying: its renderer is a web
       * app, and one with a Vite dev server (Atelier's own, for instance) is
       * previewable. It just loses the ranking to a real web app beside it.
       */
      if (toolkit) {
        if (!toolkit.web) return null;
        if (
          toolkit.id === "react-native" &&
          !(deps["react-native-web"] && webScript === "web")
        ) {
          return null;
        }
      } else if (!WEB_DEPS.some((dep) => deps[dep] !== undefined)) {
        return null;
      }

      let score = 100 - SCRIPT_PRIORITY.indexOf(script) * 10;
      if (framework !== "Web") score += 200;
      if (/(^|\/)(web|frontend|client|app)(\/|$)/i.test(projectDir)) score += 40;
      if (deps["electron"]) score -= 150;
      // A toolkit project that CAN do web is still the web target when it is
      // the only one; it just never outranks a browser-first app beside it.
      if (toolkit) score -= 60;

      return {
        score,
        runtime: {
          projectDir,
          projectName,
          framework: toolkit?.label ?? framework,
          packageManager,
          script: webScript,
          command,
          defaultUrl: `http://localhost:${toolkit?.web?.port ?? defaultPort}`,
          defaultPort: toolkit?.web?.port ?? defaultPort,
          portStrategy:
            toolkit?.id === "expo"
              ? "direct"
              : deps["react-scripts"] && !deps["vite"]
                ? "environment"
                : "script",
          storageKey: previewStorageKey(workspaceRoot, projectDir),
          storybook,
          ...(prepareCommand ? { prepareCommand, prepareReason } : {}),
        } satisfies ComponentPreviewRuntime,
      };
    })
  );

  const flutter = await Promise.all(
    pubspecPaths(tree).map((pubspec) =>
      flutterCandidate(pubspec, tree, workspaceRoot)
    )
  );

  return [...candidates, ...flutter]
    .filter((candidate) => candidate !== null)
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.runtime);
}

/** The highest-ranked target, kept for callers that only need availability. */
export async function resolveComponentPreview(
  tree: FileTreeNode,
  workspaceRoot: string | null
): Promise<ComponentPreviewRuntime | null> {
  return (await resolveComponentPreviews(tree, workspaceRoot))[0] ?? null;
}
