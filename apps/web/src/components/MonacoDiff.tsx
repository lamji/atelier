import { useCallback, useEffect, useId, useRef } from "react";
import { DiffEditor, type Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";

type DiffEditorProps = React.ComponentProps<typeof DiffEditor>;
type DiffEditorInstance = MonacoEditor.IStandaloneDiffEditor;

/**
 * DiffEditor with per-instance model URIs and a teardown that does not
 * crash.
 *
 * Two separate problems, both of which surface as the same Monaco error:
 *
 *   Error: TextModel got disposed before DiffEditorWidget model got reset
 *
 * 1. SHARED MODELS. @monaco-editor/react defaults `originalModelPath` /
 *    `modifiedModelPath` to "", and its model lookup is
 *    `monaco.editor.getModel(Uri.parse(path))` — so with the default every
 *    DiffEditor on the page (and both sides of each one) resolves to the
 *    SAME TextModel. Unmounting any one of them disposes a model the
 *    others' widgets still hold. A `useId()`-scoped URI per instance gives
 *    each diff its own pair.
 *
 * 2. TEARDOWN ORDER. The library's own unmount does, in this order:
 *        models.original.dispose(); models.modified.dispose();
 *        diffEditor.dispose();
 *    Monaco's DiffEditorWidget registers `onWillDispose` on the models it
 *    holds and throws from that listener, so disposing a model while it is
 *    still attached is exactly the reported error — every close of a diff
 *    pane raised it. `keepCurrent*Model` stops the library from disposing
 *    them, and the cleanup below detaches the models first and then
 *    disposes them itself, so nothing leaks and the order is always safe
 *    (it holds whichever of the two cleanups React runs first).
 */
export function MonacoDiff(props: DiffEditorProps) {
  // React ids carry punctuation (":" is the URI scheme separator, and
  // React 19 wraps them in guillemets); keep only what a URI authority
  // takes. The remaining characters are still unique per instance.
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const editorRef = useRef<DiffEditorInstance | null>(null);
  const { onMount } = props;

  const handleMount = useCallback(
    (editor: DiffEditorInstance, monaco: Monaco) => {
      editorRef.current = editor;
      onMount?.(editor, monaco);
    },
    [onMount]
  );

  useEffect(() => {
    return () => {
      const editor = editorRef.current;
      editorRef.current = null;
      if (!editor) return; // never became ready — nothing was created
      let models: MonacoEditor.IDiffEditorModel | null = null;
      try {
        models = editor.getModel();
        // Detaching first is what removes the widget's onWillDispose
        // listeners; disposing an attached model is the crash.
        editor.setModel(null);
      } catch {
        // The widget was disposed before us — its listeners went with it.
      }
      for (const model of [models?.original, models?.modified]) {
        if (model && !model.isDisposed()) model.dispose();
      }
    };
  }, []);

  return (
    <DiffEditor
      {...props}
      onMount={handleMount}
      originalModelPath={`atelier-diff://${id}/original`}
      modifiedModelPath={`atelier-diff://${id}/modified`}
      // The cleanup above owns model disposal; without these the library
      // disposes them while its own widget is still attached.
      keepCurrentOriginalModel
      keepCurrentModifiedModel
    />
  );
}
