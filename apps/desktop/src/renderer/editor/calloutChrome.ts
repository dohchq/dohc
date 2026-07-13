import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

const calloutChromeKey = new PluginKey<DecorationSet>("dohc-callout-chrome");

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

// The header lives in a widget decoration placed at `calloutStart + 1` (inside
// the callout, before its first child), so `getPos()` reports that inner
// position — NOT the callout's own start. Resolve upward to the enclosing
// callout so every handler reads/writes the live node at the correct pos.
function resolveCallout(
  view: EditorView,
  getPos: () => number | undefined,
): { pos: number; attrs: Record<string, unknown> } | null {
  const widgetPos = getPos();
  if (widgetPos === undefined) return null;
  const $pos = view.state.doc.resolve(widgetPos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name === "callout") {
      return { pos: $pos.before(depth), attrs: node.attrs as Record<string, unknown> };
    }
  }
  return null;
}

function updateCalloutAttr(
  view: EditorView,
  getPos: () => number | undefined,
  patch: Record<string, unknown>,
): void {
  if (view.editable === false) return;
  const callout = resolveCallout(view, getPos);
  if (!callout) return;
  view.dispatch(
    view.state.tr.setNodeMarkup(callout.pos, undefined, { ...callout.attrs, ...patch }),
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

  // Assigned once the title input + its commit logic exist below. The fold
  // toggle calls this FIRST so an in-progress title edit is flushed before the
  // header is reminted: the chevron's `mousedown` preventDefault keeps focus on
  // the input (so it never blurs), and toggling fold changes the decoration key
  // and remints the widget — which would drop the input (and its `getPos`)
  // before the edit ever committed.
  let commitFocusedTitle: () => void = () => {};

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
    commitFocusedTitle();
    const callout = resolveCallout(view, getPos);
    if (!callout) return;
    updateCalloutAttr(view, getPos, {
      fold: callout.attrs.fold === "-" ? "" : "-",
    });
  });

  const icon = document.createElement("span");
  icon.className = "dohc-callout-icon";
  icon.appendChild(makeCalloutSvg(calloutIconPath(attrs.type), "dohc-callout-icon-svg"));

  const typePicker = document.createElement("div");
  typePicker.className = "dohc-callout-type-picker";

  const typeTrigger = document.createElement("button");
  typeTrigger.type = "button";
  typeTrigger.className = "dohc-callout-type-trigger";
  typeTrigger.setAttribute("aria-label", "change callout type");
  typeTrigger.setAttribute("aria-haspopup", "listbox");
  typeTrigger.setAttribute("aria-expanded", "false");
  typeTrigger.disabled = view.editable === false;

  const hasKnownType = CALLOUT_TYPE_OPTIONS.some(
    (option) => option.value === attrs.type,
  );
  const typeOptions = hasKnownType
    ? CALLOUT_TYPE_OPTIONS
    : [{ value: attrs.type, label: attrs.type }, ...CALLOUT_TYPE_OPTIONS];
  const currentType = typeOptions.find((option) => option.value === attrs.type);
  const typeLabel = document.createElement("span");
  typeLabel.textContent = currentType?.label ?? attrs.type;
  typeTrigger.append(
    typeLabel,
    makeCalloutSvg('<path d="m6 9 6 6 6-6"/>', "dohc-callout-type-chevron"),
  );

  const typeMenu = document.createElement("div");
  typeMenu.className = "dohc-callout-type-menu";
  typeMenu.setAttribute("role", "listbox");
  typeMenu.setAttribute("aria-label", "callout type");
  typeMenu.hidden = true;

  const setTypeMenuOpen = (open: boolean) => {
    typeMenu.hidden = !open;
    typeTrigger.setAttribute("aria-expanded", String(open));
    typePicker.classList.toggle("is-open", open);
  };

  const typeButtons: HTMLButtonElement[] = [];
  const focusTypeButton = (index: number) => {
    if (!typeButtons.length) return;
    typeButtons[(index + typeButtons.length) % typeButtons.length]?.focus();
  };

  for (const [index, option] of typeOptions.entries()) {
    const optionButton = document.createElement("button");
    optionButton.type = "button";
    optionButton.className = "dohc-callout-type-option";
    optionButton.setAttribute("role", "option");
    optionButton.setAttribute(
      "aria-selected",
      String(option.value === attrs.type),
    );
    optionButton.dataset.calloutType = option.value;
    optionButton.textContent = option.label;
    optionButton.addEventListener("mousedown", (event) => event.stopPropagation());
    optionButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setTypeMenuOpen(false);
      commitFocusedTitle();
      if (option.value !== attrs.type) {
        updateCalloutAttr(view, getPos, { calloutType: option.value });
      } else {
        typeTrigger.focus();
      }
    });
    optionButton.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setTypeMenuOpen(false);
        typeTrigger.focus();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        focusTypeButton(index + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        focusTypeButton(index - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        event.stopPropagation();
        focusTypeButton(0);
      } else if (event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        focusTypeButton(typeButtons.length - 1);
      }
    });
    typeButtons.push(optionButton);
    typeMenu.appendChild(optionButton);
  }

  typeTrigger.addEventListener("mousedown", (event) => event.stopPropagation());
  typeTrigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setTypeMenuOpen(typeMenu.hidden);
  });
  typeTrigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setTypeMenuOpen(true);
      focusTypeButton(
        Math.max(
          0,
          typeOptions.findIndex((option) => option.value === attrs.type),
        ),
      );
    } else if (event.key === "Escape" && !typeMenu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      setTypeMenuOpen(false);
    }
  });
  typePicker.addEventListener("focusout", () => {
    queueMicrotask(() => {
      const root = typePicker.getRootNode();
      const active =
        root instanceof ShadowRoot ? root.activeElement : document.activeElement;
      if (!typePicker.contains(active)) setTypeMenuOpen(false);
    });
  });
  typePicker.append(typeTrigger, typeMenu);

  // Read the callout's CURRENT title from the live doc (not this render
  // closure's `attrs`, which goes stale the moment a remote/agent edit lands).
  const liveCalloutTitle = (): string | null => {
    const callout = resolveCallout(view, getPos);
    return callout ? String(callout.attrs.title ?? "") : null;
  };

  const input = document.createElement("input");
  input.type = "text";
  input.className = "dohc-callout-title-input";
  input.placeholder = "Add a title…";
  input.value = attrs.title;
  input.disabled = view.editable === false;

  // Title captured when the input gained focus. commitTitle uses it to tell a
  // real user edit apart from a stale value sitting over a newer live title.
  let focusTitle = attrs.title;

  input.addEventListener("mousedown", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // Cancel to the CURRENT node title, not the stale closure snapshot.
      input.value = liveCalloutTitle() ?? attrs.title;
      input.blur();
    }
  });
  const commitTitle = () => {
    const liveTitle = liveCalloutTitle();
    if (liveTitle === null) return;
    // Input still shows what it did at focus => no user edit this session; do
    // not overwrite a concurrent remote/agent title change that landed while
    // the input was focused.
    if (input.value === focusTitle) return;
    if (input.value === liveTitle) return;
    updateCalloutAttr(view, getPos, { title: input.value });
  };
  commitFocusedTitle = commitTitle;

  input.addEventListener("focus", () => {
    focusTitle = liveCalloutTitle() ?? input.value;
  });
  input.addEventListener("change", commitTitle);
  input.addEventListener("blur", () => {
    commitTitle();
    // Re-sync to the live title in case a remote/agent change landed while the
    // input was focused (reconcileTitleInputs defers to focused inputs, so the
    // final catch-up happens here once the user leaves the field).
    input.value = liveCalloutTitle() ?? input.value;
  });

  header.append(chevron, icon, typePicker, input);
  return header;
}

function buildCalloutChromeDecorations(doc: Node): DecorationSet {
  const decorations: Decoration[] = [];

  // Ordinal (document order among callouts), NOT absolute pos, keys the widget.
  // A collaborator/agent edit BEFORE a callout shifts its pos but not its
  // ordinal, so keying on pos would remint the widget on every such edit —
  // dropping a focused, uncommitted title input without a blur (the commit never
  // fires). Ordinal stays stable through position mapping; only a change to the
  // set/order of callouts remints, which is rare mid-title-edit.
  let ordinal = 0;

  doc.descendants((node, pos) => {
    if (node.type.name !== "callout") return;
    const index = ordinal++;
    const type = String(node.attrs.calloutType ?? "note");
    const fold = normalizeCalloutFoldAttr(node.attrs.fold);
    const title = String(node.attrs.title ?? "");
    // The key intentionally omits title: a title-only change reuses this widget
    // DOM (no caret-dropping remint) and reconcileTitleInputs re-seeds the input
    // value instead. type/fold DO alter the header chrome, so they stay in the key.
    decorations.push(
      Decoration.widget(
        pos + 1,
        (view, getPos) => buildCalloutHeader(view, getPos, { type, fold, title }),
        {
          side: -1,
          key: `callout-${index}-${type}-${fold}`,
          ignoreSelection: true,
          stopEvent: () => true,
        },
      ),
    );
  });

  return DecorationSet.create(doc, decorations);
}

// After every view update, re-seed each callout title input from its live node
// title so a remote/agent rename shows immediately (the decoration key omits
// title, so the widget itself is reused rather than reminted). The input the
// user is actively editing is skipped — deferring the sync until blur keeps the
// caret from being yanked mid-edit.
function reconcileTitleInputs(view: EditorView): void {
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== "callout") return;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return;
    const input = dom.querySelector<HTMLInputElement>(".dohc-callout-title-input");
    if (!input || document.activeElement === input) return;
    const title = String(node.attrs.title ?? "");
    if (input.value !== title) input.value = title;
  });
}

export function makeCalloutChromePlugin() {
  return new Plugin<DecorationSet>({
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
    view() {
      return {
        update: (view) => reconcileTitleInputs(view),
      };
    },
    props: {
      decorations(state) {
        return calloutChromeKey.getState(state);
      },
    },
  });
}
