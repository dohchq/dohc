import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  isolateHistory,
} from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json as jsonLanguage } from "@codemirror/lang-json";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, Transaction, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { useEffect, useRef } from "react";

export type SourceCodePendingUndo = {
  token: number;
  restoredText: string;
  undoText: string;
};

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

const CODEMIRROR_THEME = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--dohc-bg)",
    color: "var(--dohc-ink)",
    fontSize: "13px",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "14px 0 80px",
    caretColor: "var(--dohc-ink)",
    cursor: "text",
  },
  ".cm-line": {
    padding: "0 16px",
    lineHeight: "1.58",
    cursor: "text",
  },
  ".cm-gutters": {
    backgroundColor: "var(--dohc-panel)",
    borderRight: "1px solid var(--dohc-line)",
    color: "var(--dohc-subtle)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--dohc-panel-2)",
    color: "var(--dohc-ink)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--dohc-line) 38%, transparent)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--dohc-ink)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--dohc-accent) 24%, transparent)",
  },
  ".cm-foldGutter span": {
    color: "var(--dohc-subtle)",
  },
  ".cm-content[contenteditable=false]": {
    color: "var(--dohc-muted)",
  },
  "&.cm-focused": {
    outline: "none",
  },
});

function codeMirrorLanguage(path: string, language: string): Extension {
  const ext = extensionOf(path) || language.toLowerCase();
  if (ext === "json") return jsonLanguage();
  if (ext === "html" || ext === "htm") return html();
  if (ext === "css" || ext === "scss" || ext === "sass" || ext === "less") {
    return css();
  }
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx"].includes(ext)) {
    return javascript({
      jsx: ext === "jsx" || ext === "tsx",
      typescript: ext === "ts" || ext === "tsx",
    });
  }
  return [];
}

function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

export function SourceCodeEditor(props: {
  testId: string;
  value: string;
  language: string;
  path: string;
  readOnly?: boolean;
  scrollLine?: number;
  pendingUndo?: SourceCodePendingUndo;
  onPendingUndoConsumed?: (token: number) => void;
  onChange: (next: string) => void;
  onSave: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment()).current;
  const languageCompartment = useRef(new Compartment()).current;
  const onChangeRef = useRef(props.onChange);
  const onSaveRef = useRef(props.onSave);
  const applyingRemoteValue = useRef(false);
  const appliedUndoToken = useRef<number | null>(null);

  useEffect(() => {
    onChangeRef.current = props.onChange;
    onSaveRef.current = props.onSave;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          lineNumbers(),
          foldGutter(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          indentOnInput(),
          bracketMatching(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorState.allowMultipleSelections.of(true),
          EditorState.tabSize.of(2),
          EditorView.lineWrapping,
          CODEMIRROR_THEME,
          readOnlyCompartment.of(readOnlyExtension(Boolean(props.readOnly))),
          languageCompartment.of(codeMirrorLanguage(props.path, props.language)),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...foldKeymap]),
          EditorView.domEventHandlers({
            keydown(event) {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                onSaveRef.current();
                return true;
              }
              return false;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || applyingRemoteValue.current) return;
            onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The editor is intentionally created once; reactive pieces are
    // reconfigured through compartments/effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === props.value) return;
    applyingRemoteValue.current = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: props.value },
      annotations: Transaction.addToHistory.of(false),
    });
    applyingRemoteValue.current = false;
  }, [props.value]);

  useEffect(() => {
    const view = viewRef.current;
    const pendingUndo = props.pendingUndo;
    if (!view || !pendingUndo || props.readOnly) return;
    if (appliedUndoToken.current === pendingUndo.token) return;
    const current = view.state.doc.toString();
    if (current !== pendingUndo.restoredText) {
      appliedUndoToken.current = pendingUndo.token;
      props.onPendingUndoConsumed?.(pendingUndo.token);
      return;
    }
    appliedUndoToken.current = pendingUndo.token;
    applyingRemoteValue.current = true;
    view.dispatch({
      changes: {
        from: 0,
        to: current.length,
        insert: pendingUndo.undoText,
      },
      annotations: Transaction.addToHistory.of(false),
    });
    view.dispatch({
      changes: {
        from: 0,
        to: pendingUndo.undoText.length,
        insert: pendingUndo.restoredText,
      },
      annotations: isolateHistory.of("full"),
    });
    applyingRemoteValue.current = false;
    view.focus();
    props.onPendingUndoConsumed?.(pendingUndo.token);
  }, [props.pendingUndo, props.readOnly, props.onPendingUndoConsumed]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(readOnlyExtension(Boolean(props.readOnly))),
    });
  }, [props.readOnly, readOnlyCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.reconfigure(
        codeMirrorLanguage(props.path, props.language),
      ),
    });
  }, [props.path, props.language, languageCompartment]);

  useEffect(() => {
    const view = viewRef.current;
    if (props.scrollLine === undefined || !view) return;
    const lineNumber = Math.max(1, Math.min(props.scrollLine, view.state.doc.lines));
    const line = view.state.doc.line(lineNumber);
    view.focus();
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
  }, [props.scrollLine]);

  return (
    <div
      ref={hostRef}
      data-testid={props.testId}
      className="dohc-code-editor min-h-0 flex-1"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) viewRef.current?.focus();
      }}
    />
  );
}
