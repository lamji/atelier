/**
 * How a tool invocation reads in the process rail and the activity pane.
 *
 * Shared so the two never disagree about what the agent just did: the rail
 * renders these live, and the timeline pane rebuilds them from persisted
 * events, which used to print a bare tool name instead.
 */

/** Human-readable label for a tool invocation. */
export function actionLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const path = typeof i.path === "string" ? i.path : "";
  switch (name) {
    case "read_file":
      return `Reading ${path}`;
    case "read_many_files": {
      const files = Array.isArray(i.files) ? i.files : [];
      return `Reading ${files.length} files`;
    }
    case "write_file":
      return `Writing ${path}`;
    case "replace_code":
      return `Editing ${path}`;
    case "replace_many": {
      const edits = Array.isArray(i.edits) ? i.edits : [];
      return `Editing ${edits.length} replacements`;
    }
    case "search_workspace":
      return `Searching "${String(i.query ?? "")}"`;
    case "search_text":
      return `Searching text "${String(i.query ?? "")}"`;
    case "list_dir":
      return `Listing ${path || "workspace"}`;
    case "run_terminal":
      return terminalActionLabel(String(i.command ?? ""));
    case "git":
      return `git ${String(i.action ?? "")}`.trim();
    case "retrieve_knowledge":
      return `Retrieving knowledge: "${String(i.query ?? "")}"`;
    case "query_knowledge_graph":
      return `Querying code graph (${String(i.scope ?? "")})`;
    case "search_symbols":
      return `Searching symbols "${String(i.query ?? "")}"`;
    case "analyze_impact": {
      const files = Array.isArray(i.files) ? (i.files as string[]) : [];
      const symbols = Array.isArray(i.symbols) ? (i.symbols as string[]) : [];
      return `Analyzing impact of ${[...files, ...symbols].slice(0, 3).join(", ")}`;
    }
    case "impact_of_edit": {
      const at = i.symbol ? String(i.symbol) : `${path}:${String(i.line ?? "?")}`;
      return `Checking who uses ${at}`;
    }
    case "save_lesson":
      return `Saving lesson: ${String(i.title ?? "")}`;
    case "set_plan":
      return "Writing the plan";
    case "update_plan_step":
      return `Plan step ${String(i.status ?? "updated")}`;
    // The SDK's own tools. They report through the stream loop rather than
    // Atelier's registry, and they are most of what a turn does — without
    // these three cases every search showed up as a bare "Grep".
    case "Grep":
      return `Searching for "${clip(String(i.pattern ?? ""), 40)}"`;
    case "Glob":
      return `Finding files ${clip(String(i.pattern ?? ""), 40)}`;
    case "Task":
      return `Subagent: ${clip(String(i.description ?? i.subagent_type ?? "working"), 50)}`;
    default:
      // Never a bare tool name. Whatever this is, the model passed it
      // something, and that something is the only reason the row is useful.
      return humanizeToolName(name);
  }
}

/**
 * The identifying input of a tool call, on one short line.
 *
 * Deliberately separate from the label: the label is allowed to be prose
 * ("Reading git diff"), and the specifics it drops to stay readable are
 * exactly what someone watching a run needs when it goes somewhere odd.
 */
export function actionDetail(name: string, input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = i[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  if (name === "run_terminal") {
    const command = unwrapShellCommand(String(i.command ?? "")).trim();
    return command ? clip(command.replace(/\s+/g, " "), 120) : undefined;
  }
  if (name === "read_many_files" && Array.isArray(i.files)) {
    const files = (i.files as unknown[])
      .map((file) => {
        if (typeof file === "string") return file;
        if (file && typeof file === "object") {
          const path = (file as Record<string, unknown>).path;
          return typeof path === "string" ? path : "";
        }
        return "";
      })
      .filter(Boolean);
    return files.length ? clip(files.join(", "), 120) : undefined;
  }
  if (name === "set_plan" && Array.isArray(i.steps)) {
    return `${(i.steps as unknown[]).length} step(s)`;
  }
  const value = first(
    "path",
    "pattern",
    "query",
    "file_path",
    "symbol",
    "title",
    "description",
    "action"
  );
  return value ? clip(value.replace(/\s+/g, " "), 120) : undefined;
}

/** `replace_many` -> "Replace many". Last resort, but never a raw ident. */
function humanizeToolName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}


function terminalActionLabel(command: string): string {
  const inner = unwrapShellCommand(command).trim();
  const normalized = inner.replace(/\s+/g, " ");

  if (/^git\s+status\b/i.test(normalized)) return "Checking git status";
  if (/^git\s+diff\b/i.test(normalized)) return "Reading git diff";
  if (/^git\s+log\b/i.test(normalized)) return "Reading git history";
  if (/^git\s+branch(?:es)?\b/i.test(normalized)) return "Listing branches";
  if (/^git\s+checkout\b/i.test(normalized)) return "Switching branch";
  if (/^git\s+(?:add|stage)\b/i.test(normalized)) return "Staging changes";
  if (/^git\s+commit\b/i.test(normalized)) return "Committing changes";
  if (/^git\s+(?:rebase|merge)\b/i.test(normalized)) {
    return "Updating branch";
  }
  if (/^(?:rg|grep|Select-String)\b/i.test(normalized)) {
    return "Searching workspace";
  }
  if (/^(?:Get-Content|cat|type|sed)\b/i.test(normalized)) {
    return "Reading file";
  }
  if (/^(?:Get-ChildItem|ls|dir|find)\b/i.test(normalized)) {
    return "Listing workspace";
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+test)\b/i.test(normalized)) {
    return "Running tests";
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|lint)\b/i.test(normalized)) {
    return "Running verification";
  }

  // The ladder above is a summariser, not a fallback. Everything it does
  // not recognise IS the interesting case — a real command the agent chose
  // to run — and answering it with a generic sentence while discarding the
  // command was the single worst line in the console.
  return normalized ? `$ ${clip(normalized, 60)}` : "Running a command";
}

function unwrapShellCommand(command: string): string {
  const match = /(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)["'\s]*(?:-[^\s]+\s+)*-Command\s+(.+)$/i.exec(command);
  return match?.[1] ?? command;
}
