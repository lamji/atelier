import type { ProjectEntry, WorkspaceProfile } from "./types.js";

/**
 * Renders the profile as a static system-prompt block. Kept byte-stable
 * for the lifetime of the process so it never invalidates the provider
 * prompt cache, and kept short — this rides on every single turn.
 *
 * Styled like a file explorer: a root node with the workspace's own
 * branches drawn as a directory tree, so the model can "see" the shape of
 * what it is standing in at a glance instead of reading a flat list.
 */
export function renderWorkspaceProfile(profile: WorkspaceProfile): string {
  const tree = renderTree(profile);
  const lines = [`WORKSPACE LAYOUT — ${headline(profile)}`, ""];

  lines.push(tree);

  const rootDirs = profile.rootProject?.topDirs ?? [];
  if (rootDirs.length > 0) {
    lines.push(
      `Root directories: ${rootDirs.map((d) => `${d}/`).join("  ")}`
    );
  }

  if (profile.truncated) {
    lines.push("- (more projects exist — list_dir the root to see them)");
  }

  if (profile.kind === "multi-project" || profile.kind === "monorepo") {
    lines.push(
      "Every tool path is relative to the workspace ROOT, so a file inside " +
        `${profile.projects[0]?.name ?? "a project"} is ` +
        `"${profile.projects[0]?.path ?? "<project>"}/src/...", never ` +
        '"src/...". Getting the prefix wrong is the most common path error ' +
        "here."
    );
  }
  lines.push(
    "The directory names above are the only ones confirmed to exist. Never " +
      "assume a conventional folder (src/components/layout, src/utils, " +
      "app/services) is present — confirm with search_workspace, " +
      "retrieve_knowledge, or list_dir before using a path."
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Builds the file-explorer tree: a top row with the root glyph, then one
 * indented branch per project, each with a folder glyph and its flags, and
 * the project's confirmed top-level folders nested beneath it.
 */
function renderTree(profile: WorkspaceProfile): string {
  const rows: string[] = [`📦 ${profile.rootName}/`];
  const entries = profile.projects;

  entries.forEach((project, i) => {
    const isLast = i === entries.length - 1;
    const branch = isLast ? "└─" : "├─";
    const flag = project.isGitRepo ? "  (git)" : "";
    rows.push(`${branch} 📁 ${describe(project)}${flag}`);

    // Fold the project's confirmed top-level folders in as children, so the
    // explorer shows real structure rather than a bare folder list.
    const dirs = project.topDirs;
    dirs.forEach((dir, j) => {
      const childLast = j === dirs.length - 1;
      const child = childLast ? "└─" : "├─";
      rows.push(`   ${child} 📂 ${dir}/`);
    });
  });

  return rows.join("\n");
}

function headline(profile: WorkspaceProfile): string {
  const root = `"${profile.rootName}"`;
  const count = profile.projects.length;
  switch (profile.kind) {
    case "monorepo":
      return (
        `${root} is a ${profile.monorepoTool ?? "monorepo"} monorepo ` +
        `containing ${count} package${count === 1 ? "" : "s"}.`
      );
    case "multi-project":
      return (
        `${root} is NOT a project — it is a folder holding ${count} ` +
        `separate project${count === 1 ? "" : "s"} side by side.`
      );
    case "single-project": {
      const stack = profile.rootProject?.stack;
      const kind = stack && stack !== "unknown" ? `${stack} ` : "";
      return (
        `${root} is a single ${kind}project` +
        `${profile.rootProject?.isGitRepo ? " (git repo)" : ""}` +
        (count > 0 ? `, with ${count} nested sub-project(s).` : ".")
      );
    }
    default:
      return `${root} contains no recognized project manifest.`;
  }
}

function describe(project: ProjectEntry): string {
  const facts = [project.stack];
  const dirs =
    project.topDirs.length > 0 ? ` — ${project.topDirs.length} top dirs` : "";
  return `${project.path || project.name}/${dirs}`;
}
