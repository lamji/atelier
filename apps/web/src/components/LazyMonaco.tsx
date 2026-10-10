import { lazy, Suspense } from "react";
import type { EditorProps, DiffEditorProps } from "@monaco-editor/react";

// Configure the bundled, offline editor before mounting the React wrapper;
// otherwise its loader can start a CDN request before local setup finishes.
async function loadEditor() {
  await import("@/lib/monaco-setup");
  return import("@monaco-editor/react");
}

const Editor = lazy(async () => ({ default: (await loadEditor()).default }));
const DiffEditor = lazy(async () => ({ default: (await loadEditor()).DiffEditor }));
const loading = <div role="status" className="p-3 text-xs text-muted-foreground">Loading editor…</div>;

export default function MonacoEditor(props: EditorProps) {
  return <Suspense fallback={loading}><Editor {...props} /></Suspense>;
}

export function MonacoDiffEditor(props: DiffEditorProps) {
  return <Suspense fallback={loading}><DiffEditor {...props} /></Suspense>;
}
