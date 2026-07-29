/**
 * What kind of folder the user actually opened. The agent behaves very
 * differently in each case: in a container folder every tool path needs a
 * project prefix, in a monorepo the packages share tooling, in a single
 * project the root IS the project.
 */
export type WorkspaceKind =
  | "single-project"
  | "monorepo"
  | "multi-project"
  | "plain-folder";

/** One buildable/checkout-able unit found inside the workspace root. */
export interface ProjectEntry {
  /** Workspace-relative POSIX path; "" when the project is the root. */
  path: string;
  name: string;
  /** e.g. "node/react", "go", "python", "unknown". */
  stack: string;
  /**
   * Carries a build manifest. A bare .git with no manifest is a checkout
   * container, not a project — the distinction decides the workspace kind.
   */
  hasManifest: boolean;
  /** Has its own .git — matters for a container of independent checkouts. */
  isGitRepo: boolean;
  /** A few real top-level directories, so the model never invents one. */
  topDirs: string[];
}

export interface WorkspaceProfile {
  /** Basename only — the absolute host path never enters the prompt. */
  rootName: string;
  kind: WorkspaceKind;
  /** The root itself when it is a project, otherwise undefined. */
  rootProject?: ProjectEntry;
  /** Projects found below the root, nearest first. */
  projects: ProjectEntry[];
  /** "pnpm workspaces", "nx", "go workspace", ... when detected. */
  monorepoTool?: string;
  /** True when more projects exist than the scan reports. */
  truncated: boolean;
}
