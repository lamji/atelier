import { useId } from "react";
import { DiffEditor } from "@monaco-editor/react";

type DiffEditorProps = React.ComponentProps<typeof DiffEditor>;

/**
 * DiffEditor with per-instance model URIs.
 *
 * @monaco-editor/react defaults `originalModelPath`/`modifiedModelPath` to
 * "", and its model lookup is `monaco.editor.getModel(Uri.parse(path))` —
 * so with the default every DiffEditor on the page (and both sides of each
 * one) resolves to the SAME shared TextModel. Unmounting any one of them
 * disposes that model while the others' widgets still hold it, which Monaco
 * reports as:
 *
 *   Error: TextModel got disposed before DiffEditorWidget model got reset
 *
 * A `useId()`-scoped URI per instance gives each diff its own pair of
 * models, so mounting/unmounting one never touches another's.
 */
export function MonacoDiff(props: DiffEditorProps) {
  // Colons are the URI scheme separator; React's ids contain them.
  const id = useId().replace(/:/g, "");
  return (
    <DiffEditor
      {...props}
      originalModelPath={`atelier-diff://${id}/original`}
      modifiedModelPath={`atelier-diff://${id}/modified`}
    />
  );
}
