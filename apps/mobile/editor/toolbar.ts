import { documentWords } from "@dohc/interface-words/documents";

export type ToolbarMark = "bold" | "italic" | "strike" | "code";

export interface ToolbarState {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  readonly code: boolean;
  readonly heading: 0 | 1 | 2 | 3;
  readonly bulletList: boolean;
  readonly orderedList: boolean;
  readonly taskList: boolean;
  readonly blockquote: boolean;
  readonly codeBlock: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface ToolbarEditor {
  subscribeToolbar(listener: (state: ToolbarState) => void): () => void;
  toggleMark(mark: ToolbarMark): boolean;
  setHeading(level: 0 | 1 | 2 | 3): boolean;
  toggleBulletList(): boolean;
  toggleOrderedList(): boolean;
  toggleTaskList(): boolean;
  toggleBlockquote(): boolean;
  toggleCodeBlock(): boolean;
  undo(): boolean;
  redo(): boolean;
}

export interface EditorToolbar {
  attach(editor: ToolbarEditor, canEdit: () => boolean): void;
  detach(): void;
  refresh(): void;
  setKeyboard(covered: number, inset: number): void;
  height(): number;
}

type ButtonKey = Exclude<keyof typeof documentWords.toolbar, "label">;
interface ButtonSpec {
  readonly key: ButtonKey;
  readonly active?: (state: ToolbarState) => boolean;
  readonly disabled?: (state: ToolbarState) => boolean;
  readonly run: (editor: ToolbarEditor) => boolean;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_ATTRS = {
  class: "toolbar-icon",
  "aria-hidden": "true",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.9",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
} as const;

const ICONS: Readonly<Record<ButtonKey, string>> = {
  bold: "M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8",
  italic: "M19 4h-9M14 20H5M15 4 9 20",
  strike: "M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16",
  code: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  heading1: "M4 12h8M4 18V6M12 18V6M17 12l3-2v8",
  heading2: "M4 12h8M4 18V6M12 18V6M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1",
  heading3:
    "M4 12h8M4 18V6M12 18V6M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2",
  bulletList: "M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13",
  orderedList: "M10 12h11M10 18h11M10 6h11M4 10h2M4 6h1v4M6 18H4c0-1 2-2 2-3s-1-1.5-2-1",
  taskList:
    "M4 5h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM3 17l2 2 4-4M13 6h8M13 12h8M13 18h8",
  blockquote:
    "M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2zM5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z",
  codeBlock:
    "M10 9.5 8 12l2 2.5M14 9.5l2 2.5-2 2.5M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11",
  redo: "M15 14l5-5-5-5M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13",
};

const FORMAT_GROUPS: readonly (readonly ButtonSpec[])[] = [
  [
    { key: "bold", active: (s) => s.bold, run: (e) => e.toggleMark("bold") },
    { key: "italic", active: (s) => s.italic, run: (e) => e.toggleMark("italic") },
    { key: "strike", active: (s) => s.strike, run: (e) => e.toggleMark("strike") },
    { key: "code", active: (s) => s.code, run: (e) => e.toggleMark("code") },
  ],
  [
    { key: "heading1", active: (s) => s.heading === 1, run: (e) => e.setHeading(1) },
    { key: "heading2", active: (s) => s.heading === 2, run: (e) => e.setHeading(2) },
    { key: "heading3", active: (s) => s.heading === 3, run: (e) => e.setHeading(3) },
  ],
  [
    { key: "bulletList", active: (s) => s.bulletList, run: (e) => e.toggleBulletList() },
    { key: "orderedList", active: (s) => s.orderedList, run: (e) => e.toggleOrderedList() },
    { key: "taskList", active: (s) => s.taskList, run: (e) => e.toggleTaskList() },
    { key: "blockquote", active: (s) => s.blockquote, run: (e) => e.toggleBlockquote() },
    { key: "codeBlock", active: (s) => s.codeBlock, run: (e) => e.toggleCodeBlock() },
  ],
];

const HISTORY_BUTTONS: readonly ButtonSpec[] = [
  { key: "undo", disabled: (s) => !s.canUndo, run: (e) => e.undo() },
  { key: "redo", disabled: (s) => !s.canRedo, run: (e) => e.redo() },
];

function createIcon(pathData: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [name, value] of Object.entries(SVG_ATTRS)) svg.setAttribute(name, value);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  return svg;
}

export function createEditorToolbar(options: {
  readonly root: HTMLElement;
  readonly onLayout?: () => void;
  readonly onCommand?: () => void;
}): EditorToolbar {
  const bar = document.createElement("div");
  bar.className = "toolbar";
  bar.hidden = true;
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", documentWords.toolbar.label);

  // Prevent WebKit and Android WebView from blurring the editor or dropping selection on button press.
  const keepFocus = (event: Event) => event.preventDefault();
  bar.addEventListener("pointerdown", keepFocus);
  bar.addEventListener("mousedown", keepFocus);

  let editor: ToolbarEditor | null = null;
  let canEdit: () => boolean = () => false;
  let unsubscribe: (() => void) | null = null;
  let toolbarState: ToolbarState | null = null;
  let covered = 0;
  let inset = 0;

  const controls: { readonly spec: ButtonSpec; readonly button: HTMLButtonElement }[] = [];
  const makeButton = (spec: ButtonSpec) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toolbar-button";
    button.setAttribute("aria-label", documentWords.toolbar[spec.key]);
    if (spec.active) button.setAttribute("aria-pressed", "false");
    if (spec.disabled) button.disabled = true;
    button.append(createIcon(ICONS[spec.key]));
    button.addEventListener("click", () => {
      if (!editor || !canEdit() || (toolbarState && spec.disabled?.(toolbarState))) return;
      spec.run(editor);
      options.onCommand?.();
    });
    controls.push({ spec, button });
    return button;
  };

  const scroll = document.createElement("div");
  scroll.className = "toolbar-scroll";
  FORMAT_GROUPS.forEach((group, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "toolbar-sep";
      sep.setAttribute("aria-hidden", "true");
      scroll.append(sep);
    }
    for (const spec of group) scroll.append(makeButton(spec));
  });

  const history = document.createElement("div");
  history.className = "toolbar-history";
  for (const spec of HISTORY_BUTTONS) history.append(makeButton(spec));
  bar.append(scroll, history);
  options.root.after(bar);

  const syncVisibility = (notifyLayout: boolean) => {
    const visible = editor !== null && toolbarState !== null && covered > 0 && canEdit();
    const changed = bar.hidden === visible;
    bar.hidden = !visible;
    bar.style.setProperty("--keyboard", `${visible ? inset : 0}px`);
    if (notifyLayout && changed) options.onLayout?.();
  };

  const clear = () => {
    unsubscribe?.();
    unsubscribe = null;
    editor = null;
    canEdit = () => false;
    toolbarState = null;
  };
  const detach = () => {
    clear();
    syncVisibility(true);
  };

  return {
    attach(nextEditor, nextCanEdit) {
      clear();
      editor = nextEditor;
      canEdit = nextCanEdit;
      unsubscribe = nextEditor.subscribeToolbar((state) => {
        toolbarState = state;
        for (const { spec, button } of controls) {
          if (spec.active) button.setAttribute("aria-pressed", String(spec.active(state)));
          if (spec.disabled) button.disabled = spec.disabled(state);
        }
        syncVisibility(true);
      });
      syncVisibility(true);
    },
    detach,
    refresh: () => syncVisibility(true),
    setKeyboard(nextCovered, nextInset) {
      covered = nextCovered > 0 ? nextCovered : 0;
      inset = covered > 0 && nextInset > 0 ? nextInset : 0;
      syncVisibility(false);
    },
    height: () => (bar.hidden ? 0 : bar.offsetHeight || bar.getBoundingClientRect?.().height || 0),
  };
}
