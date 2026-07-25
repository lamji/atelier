import { useWorkspaceStore } from "@/state/workspace.store";
import { useThemeStore } from "@/state/theme.store";

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  ps1: "powershell",
};

/** ViewModel for the center editor/diff area. */
export function useEditorViewModel() {
  const { selectedPath, fileContent, rightTab, setRightTab } =
    useWorkspaceStore();
  const theme = useThemeStore((s) => s.theme);

  const language = languageFor(selectedPath);

  return {
    selectedPath,
    fileContent,
    rightTab,
    language,
    monacoTheme: theme === "dark" ? "vs-dark" : "light",
    setRightTab,
  };
}

function languageFor(path: string | null | undefined): string {
  if (!path) return "plaintext";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}
