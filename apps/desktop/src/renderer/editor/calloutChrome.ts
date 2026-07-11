import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

type DocDescendantNode = {
  type: { name: string };
  attrs: Record<string, unknown>;
  textContent: string;
  nodeSize: number;
};

type DocLike = {
  descendants: (
    cb: (node: DocDescendantNode, pos: number) => boolean | void,
  ) => void;
  nodeAt: (pos: number) => DocDescendantNode | null;
};

const calloutChromeKey = new PluginKey("dohc-callout-chrome");

function stopEditorMouseEvent(event: Event) {
  event.preventDefault();
  event.stopPropagation();
}

const CALLOUT_TYPE_OPTIONS = [
  { value: "note", label: "Note" },
  { value: "tip", label: "Tip" },
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "danger", label: "Danger" },
  { value: "quote", label: "Quote" },
] as const;

// Inline lucide icon geometry (StickyNote / Lightbulb / Info / AlertTriangle /
// OctagonAlert / Quote). Rendered as SVG in a vanilla decoration widget so the
// callout node stays DOM-free and shareable with the headless server schema.
const CALLOUT_ICON_PATHS: Record<string, string> = {
  note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v5.5a1 1 0 0 0 1 1H21"/>',
  tip: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  warning:
    '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  danger:
    '<path d="M2.6 16.7A2 2 0 0 1 2 15.3V8.7a2 2 0 0 1 .6-1.4l4.7-4.7A2 2 0 0 1 8.7 2h6.6a2 2 0 0 1 1.4.6l4.7 4.7a2 2 0 0 1 .6 1.4v6.6a2 2 0 0 1-.6 1.4l-4.7 4.7a2 2 0 0 1-1.4.6H8.7a2 2 0 0 1-1.4-.6z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  quote:
    '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
};

const SVG_NS = "http://www.w3.org/2000/svg";

function makeCalloutSvg(pathMarkup: string, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  svg.innerHTML = pathMarkup;
  return svg;
}

function calloutIconPath(type: string): string {
  return CALLOUT_ICON_PATHS[type] ?? CALLOUT_ICON_PATHS.note;
}

function normalizeCalloutFoldAttr(value: unknown): "" | "-" | "+" {
  return value === "-" || value === "+" ? value : "";
}

function updateCalloutAttr(
  view: EditorView,
  getPos: () => number | undefined,
  patch: Record<string, unknown>,
): void {
  if (view.editable === false) return;
  const pos = getPos();
  if (pos === undefined) return;
  const current = view.state.doc.nodeAt(pos);
  if (!current || current.type.name !== "callout") return;
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...patch }),
  );
}

function buildCalloutHeader(
  view: EditorView,
  getPos: () => number | undefined,
  attrs: { type: string; fold: "" | "-" | "+"; title: string },
): HTMLElement {
  const header = document.createElement("div");
  header.className = "dohc-callout-header";
  header.setAttribute("contenteditable", "false");

  const folded = attrs.fold === "-";
  const chevron = document.createElement("button");
  chevron.type = "button";
  chevron.className = "dohc-callout-fold";
  chevron.setAttribute("aria-label", folded ? "expand callout" : "collapse callout");
  chevron.setAttribute("aria-expanded", folded ? "false" : "true");
  chevron.disabled = view.editable === false;
  chevron.appendChild(makeCalloutSvg('<path d="m9 18 6-6-6-6"/>', "dohc-callout-chevron"));
  chevron.addEventListener("mousedown", stopEditorMouseEvent);
  chevron.addEventListener("click", (event) => {
    stopEditorMouseEvent(event);
    const pos = getPos();
    if (pos === undefined) return;
    const current = view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "callout") return;
    updateCalloutAttr(view, getPos, {
      fold: current.attrs.fold === "-" ? "" : "-",
    });
  });

  const icon = document.createElement("span");
  icon.className = "dohc-callout-icon";
  icon.appendChild(makeCalloutSvg(calloutIconPath(attrs.type), "dohc-callout-icon-svg"));

  const select = document.createElement("select");
  select.className = "dohc-callout-type-select";
  select.setAttribute("aria-label", "callout type");
  select.disabled = view.editable === false;
  const hasKnownType = CALLOUT_TYPE_OPTIONS.some((option) => option.value === attrs.type);
  const typeOptions = hasKnownType
    ? CALLOUT_TYPE_OPTIONS
    : [{ value: attrs.type, label: attrs.type }, ...CALLOUT_TYPE_OPTIONS];
  for (const option of typeOptions) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    select.appendChild(el);
  }
  select.value = attrs.type;
  select.addEventListener("mousedown", (event) => event.stopPropagation());
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", () => {
    updateCalloutAttr(view, getPos, { calloutType: select.value });
  });

  const input = document.createElement("input");
  input.type = "text";
  input.className = "dohc-callout-title-input";
  input.placeholder = "Add a title…";
  input.value = attrs.title;
  input.disabled = view.editable === false;
  input.addEventListener("mousedown", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      input.value = attrs.title;
      input.blur();
    }
  });
  const commitTitle = () => {
    const pos = getPos();
    if (pos === undefined) return;
    const current = view.state.doc.nodeAt(pos);
    if (!current || current.type.name !== "callout") return;
    if (input.value === String(current.attrs.title ?? "")) return;
    updateCalloutAttr(view, getPos, { title: input.value });
  };
  input.addEventListener("change", commitTitle);
  input.addEventListener("blur", commitTitle);

  header.append(chevron, icon, select, input);
  return header;
}

function buildCalloutChromeDecorations(doc: unknown): DecorationSet {
  const decorations: Decoration[] = [];

  (doc as DocLike).descendants((node, pos) => {
    if (node.type.name !== "callout") return;
    const type = String(node.attrs.calloutType ?? "note");
    const fold = normalizeCalloutFoldAttr(node.attrs.fold);
    const title = String(node.attrs.title ?? "");
    decorations.push(
      Decoration.widget(
        pos + 1,
        (view, getPos) => buildCalloutHeader(view, getPos, { type, fold, title }),
        {
          side: -1,
          key: `callout-${pos}-${type}-${fold}`,
          ignoreSelection: true,
          stopEvent: () => true,
        },
      ),
    );
  });

  return DecorationSet.create(doc as never, decorations);
}

export function makeCalloutChromePlugin() {
  return new Plugin({
    key: calloutChromeKey,
    state: {
      init(_, instance) {
        return buildCalloutChromeDecorations(instance.doc);
      },
      apply(tr, old) {
        if (!tr.docChanged) return old.map(tr.mapping, tr.doc);
        return buildCalloutChromeDecorations(tr.doc);
      },
    },
    props: {
      decorations(state) {
        return calloutChromeKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}
