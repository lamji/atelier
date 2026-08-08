// Bundle Monaco locally instead of @monaco-editor/react's default CDN
// (jsdelivr) load. Required for the packaged desktop app and offline use;
// also removes the CDN dependency for the browser build.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

/*
 * Atelier editor themes. Stock `vs-dark` paints #1e1e1e and `light` paints
 * #fffffe, neither of which is the surface the editor region sits on — the
 * seam between the shell and Monaco was visible on every open file. These are
 * the stock themes with the chrome colours repointed at the shell's own
 * tokens; token/syntax colours are inherited untouched, so highlighting is
 * unchanged. Values are literals because Monaco needs real colours, not
 * CSS variables; they mirror the --atelier-* tokens in index.css.
 */
monaco.editor.defineTheme("atelier-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#111a1c",
    "editor.foreground": "#e7eeee",
    "editorGutter.background": "#111a1c",
    "editorLineNumber.foreground": "#5a7176",
    "editorLineNumber.activeForeground": "#aebfc1",
    "editor.lineHighlightBackground": "#172427",
    "editor.selectionBackground": "#2a4347",
    "editor.inactiveSelectionBackground": "#1d2d30",
    "editorIndentGuide.background1": "#1e2f32",
    "editorIndentGuide.activeBackground1": "#2d4144",
    "editorWidget.background": "#1d2d30",
    "editorWidget.border": "#2d4144",
    "editorCursor.foreground": "#68aeb8",
    "diffEditor.insertedTextBackground": "#4fa87926",
    "diffEditor.removedTextBackground": "#d66b6b26",
    "scrollbarSlider.background": "#93a9ac2e",
    "scrollbarSlider.hoverBackground": "#93a9ac4d",
    "scrollbarSlider.activeBackground": "#68aeb899",
  },
});

monaco.editor.defineTheme("atelier-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#fbfcfc",
    "editor.foreground": "#152527",
    "editorGutter.background": "#fbfcfc",
    "editorLineNumber.foreground": "#8fa3a5",
    "editorLineNumber.activeForeground": "#475f62",
    "editor.lineHighlightBackground": "#f2f6f5",
    "editor.selectionBackground": "#d4e2df",
    "editor.inactiveSelectionBackground": "#e7efed",
    "editorIndentGuide.background1": "#e2eae8",
    "editorIndentGuide.activeBackground1": "#c7d4d1",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#c7d4d1",
    "editorCursor.foreground": "#224248",
    "diffEditor.insertedTextBackground": "#28734d26",
    "diffEditor.removedTextBackground": "#a9444426",
    "scrollbarSlider.background": "#5f747733",
    "scrollbarSlider.hoverBackground": "#5f747759",
    "scrollbarSlider.activeBackground": "#22424899",
  },
});

loader.config({ monaco });
