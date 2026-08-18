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
  storageKey: string;
  storybook: boolean;
}

interface PreviewPackageManifest {
  name?: string;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const SCRIPT_PRIORITY = [
  "dev",
  "develop",
  "start",
  "serve",
  "preview",
  "storybook",
  "storybook:dev",
] as const;

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

function fallbackRuntime(workspaceRoot: string | null): ComponentPreviewRuntime {
  return {
    projectDir: "",
    projectName: workspaceProjectName(workspaceRoot),
    framework: "Web",
    packageManager: "npm",
    script: null,
    command: null,
    defaultUrl: "http://localhost:3000",
    storageKey: previewStorageKey(workspaceRoot, ""),
    storybook: false,
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
export async function resolveComponentPreview(
  tree: FileTreeNode,
  workspaceRoot: string | null
): Promise<ComponentPreviewRuntime> {
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
      const command =
        packageManager === "npm" || packageManager === "bun"
          ? `${packageManager} run ${script}`
          : `${packageManager} ${script}`;
      const projectName =
        manifest.name?.trim() ||
        projectDir.split("/").filter(Boolean).at(-1) ||
        workspaceProjectName(workspaceRoot);

      let score = 100 - SCRIPT_PRIORITY.indexOf(script) * 10;
      if (framework !== "Web") score += 200;
      if (/(^|\/)(web|frontend|client|app)(\/|$)/i.test(projectDir)) score += 40;
      if (deps["electron"]) score -= 150;

      return {
        score,
        runtime: {
          projectDir,
          projectName,
          framework,
          packageManager,
          script,
          command,
          defaultUrl: `http://localhost:${defaultPort}`,
          storageKey: previewStorageKey(workspaceRoot, projectDir),
          storybook,
        } satisfies ComponentPreviewRuntime,
      };
    })
  );

  const best = candidates
    .filter((candidate) => candidate !== null)
    .sort((a, b) => b.score - a.score)[0];

  return best?.runtime ?? fallbackRuntime(workspaceRoot);
}
