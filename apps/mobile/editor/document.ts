// A page in the app's web view: icon, title, properties and body in one scroll, so the caret stays above the
// keyboard without the app coordinating two scroll views. The app passes the page in `window.__dohcPage`.
import type { FieldDefinition } from "@dohc/workspace-contracts/collection";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { mountLiveBodyEditor } from "@dohc/ydoc-projection/browser-editor";
import { frontmatterEditsRefused } from "@dohc/ydoc-projection/frontmatter";
import { frontmatterMapValues } from "@dohc/ydoc-projection/frontmatter-map";
import type * as Y from "yjs";
import { post } from "./bridge";
import { opensFormat, refuseFormat } from "./format";
import { followLive } from "./live";
import { createEditorToolbar, type EditorToolbar } from "./toolbar";

const HIDDEN_PROPERTY_KEYS = new Set(["id", "title", "icon"]);

export interface PageProperty {
  readonly name: string;
  readonly value: string;
  readonly opens?: boolean;
}
export interface PageConfig {
  readonly title: string;
  readonly icon?: string;
  readonly properties: readonly PageProperty[];
  readonly propertyFields?: readonly FieldDefinition[];
  readonly propertiesEditable?: boolean;
  readonly relationLabels?: Readonly<Record<string, string>>;
  readonly emptyPropertyLabel?: string;
  readonly markdown: string;
  /** Over the 2 MiB limit: the start shows as plain text, read-only. */
  readonly large: boolean;
  readonly editable: boolean;
  /** The app opens the page live: the text shows read-only until the live document replaces it (live.ts). */
  readonly live?: boolean;
  /** Dynamic Type, as it is when the page opens. */
  readonly textScale: number;
  /** Platform minimum touch target in CSS px (44 on iOS, 48 on Android). */
  readonly touchSize?: number;
  /** Design review only: type a sentence and report keystroke-to-paint. */
  readonly autotype?: boolean;
}

function formatProperty(
  value: unknown,
  field: FieldDefinition | undefined,
  labels: Readonly<Record<string, string>>,
  emptyLabel: string,
): string {
  if (value === null || value === undefined || value === "") return emptyLabel;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (!value.length) return emptyLabel;
    return value
      .map((item) =>
        field?.type === "relation" && typeof item === "string"
          ? (labels[item] ?? item)
          : String(item),
      )
      .join(", ");
  }
  if (field?.type === "relation" && typeof value === "string") return labels[value] ?? value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isEditablePropertyValue(value: unknown, field: FieldDefinition | undefined): boolean {
  if (field?.type === "button") return false;
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every(
      (x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean",
    );
  return false;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function mountDocument(page: PageConfig) {
  const root = document.getElementById("editor");
  if (!root) throw new Error("Editor element missing");
  root.className = "page";
  // Text sizes are in rem, so Dynamic Type scales the whole page from here.
  document.documentElement.style.setProperty("--text-scale", String(page.textScale));
  if (page.touchSize !== undefined)
    document.documentElement.style.setProperty("--touch", `${page.touchSize}px`);
  // A status-bar tap, from the app's page host: the page scrolls in this element, not the document.
  (window as Window & { __dohcScrollToTop?: () => void }).__dohcScrollToTop = () =>
    root.scrollTo({ top: 0, behavior: "instant" });
  // A large file shows only its start as text, as the desktop's truncated view does: no title or properties.
  if (page.icon && !page.large) root.append(element("div", "icon", page.icon));
  if (!page.large) root.append(element("h1", "title", page.title));
  let propertyList: HTMLDListElement | null = null;
  if (page.properties.length > 0 && !page.large) {
    const list = element("dl", "properties");
    for (const property of page.properties) {
      const row = element("div", property.opens ? "property opens" : "property");
      row.append(element("dt", "", property.name), element("dd", "", property.value));
      list.append(row);
    }
    root.append(list);
  } else if (!page.large) {
    propertyList = element("dl", "properties");
    propertyList.hidden = true;
    root.append(propertyList);
  }
  const body = element("div", "body");
  root.append(body);
  let editable = page.editable;
  let propertiesEditable = page.propertiesEditable === true;
  let propertyFields: readonly FieldDefinition[] = page.propertyFields ?? [];
  let relationLabels: Readonly<Record<string, string>> = page.relationLabels ?? {};
  const emptyLabel = page.emptyPropertyLabel ?? "—";
  let activeDoc: Y.Doc | null = null;
  let activeLive = false;
  let typed: readonly number[] = [];
  const endEditing = () => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection()?.removeAllRanges();
  };
  const renderProperties = (doc: Y.Doc | null) => {
    if (!propertyList) return;
    if (!doc) {
      propertyList.replaceChildren();
      propertyList.hidden = true;
      return;
    }
    const values = frontmatterMapValues(doc.getMap("frontmatter"));
    const locked = frontmatterEditsRefused(doc);
    const seen = new Set<string>();
    const entries: Array<{ key: string; value: unknown; field: FieldDefinition | undefined }> = [];
    for (const field of propertyFields) {
      if (
        field.type === "button" ||
        HIDDEN_PROPERTY_KEYS.has(field.name.toLowerCase()) ||
        seen.has(field.name)
      )
        continue;
      seen.add(field.name);
      entries.push({
        key: field.name,
        value: Object.hasOwn(values, field.name) ? values[field.name] : null,
        field,
      });
    }
    for (const [key, value] of Object.entries(values)) {
      if (HIDDEN_PROPERTY_KEYS.has(key.toLowerCase()) || seen.has(key)) continue;
      seen.add(key);
      entries.push({ key, value, field: undefined });
    }
    propertyList.replaceChildren();
    propertyList.hidden = entries.length === 0;
    for (const entry of entries) {
      const canTap =
        propertiesEditable && !locked && isEditablePropertyValue(entry.value, entry.field);
      const shown = formatProperty(entry.value, entry.field, relationLabels, emptyLabel);
      const row = element("div", canTap ? "property opens" : "property");
      row.append(element("dt", "", entry.key), element("dd", "", shown));
      if (canTap) {
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        row.setAttribute("aria-label", `${entry.key}: ${shown}`);
        const tap = () => {
          endEditing();
          post("propertyTap", { key: entry.key, value: entry.value ?? null, live: activeLive });
        };
        row.addEventListener("click", tap);
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            tap();
          }
        });
      }
      propertyList.append(row);
    }
  };
  (
    window as Window & { __dohcSetPropertiesEditable?: (v: boolean) => void }
  ).__dohcSetPropertiesEditable = (value) => {
    propertiesEditable = value;
    renderProperties(activeDoc);
  };
  (
    window as Window & {
      __dohcSetPropertyContext?: (ctx: {
        fields?: readonly FieldDefinition[];
        relationLabels?: Readonly<Record<string, string>>;
      }) => void;
    }
  ).__dohcSetPropertyContext = (ctx) => {
    if (ctx.fields !== undefined) propertyFields = ctx.fields;
    if (ctx.relationLabels !== undefined) relationLabels = ctx.relationLabels;
    renderProperties(activeDoc);
  };
  // Keystroke to paint: from the browser's `beforeinput` to the frame that shows it.
  const samples: number[] = [];
  let pending: number | null = null;
  body.addEventListener(
    "beforeinput",
    () => {
      pending ??= performance.now();
    },
    { capture: true },
  );
  let revealCaret = () => {};
  let syncKeyboardLayout = () => {};
  const toolbar = createEditorToolbar({
    root,
    onLayout: () => syncKeyboardLayout(),
    onCommand: () => requestAnimationFrame(revealCaret),
  });
  let readOnly: ReturnType<typeof mountLiveBodyEditor> | null = null;
  const showRead = (markdown: string) => {
    const app = window as Window & { __dohcCopyMarkdown?: unknown; __dohcSetEditable?: unknown };
    delete app.__dohcCopyMarkdown;
    delete app.__dohcSetEditable;
    toolbar.detach();
    readOnly?.destroy();
    readOnly = null;
    body.replaceChildren();
    const doc = page.large ? null : markdownToYDoc(markdown);
    if (doc === null) {
      activeDoc = null;
      activeLive = false;
      renderProperties(null);
      body.append(element("pre", "source", markdown));
      return;
    }
    if (!opensFormat(doc)) return refuseFormat();
    activeDoc = doc;
    activeLive = false;
    renderProperties(doc);
    // Copy as Markdown copies the page as it is now, with the person's edits.
    (window as Window & { __dohcCopyMarkdown?: () => void }).__dohcCopyMarkdown = () =>
      post("markdown", { markdown: yDocToMarkdown(doc) });
    const editor = mountLiveBodyEditor(body, {
      doc,
      label: page.title,
      canEdit: () => editable,
      edit(change) {
        change();
        const started = pending;
        pending = null;
        if (started !== null)
          requestAnimationFrame(() =>
            setTimeout(() => samples.push(performance.now() - started), 0),
          );
        return true;
      },
    });
    readOnly = editor;
    if (!page.live) toolbar.attach(editor, () => editable);
    // The app turns editing off when the page goes read-only (offline, deleted, access ended).
    (window as Window & { __dohcSetEditable?: (value: boolean) => void }).__dohcSetEditable = (
      value,
    ) => {
      editable = value;
      editor.refresh();
      toolbar.refresh();
    };
  };
  showRead(page.markdown);
  (window as Window & { __dohcReplaceRead?: (markdown: string) => void }).__dohcReplaceRead =
    showRead;
  if (readOnly) {
    if (page.live)
      followLive({
        body,
        readOnly: { destroy: () => readOnly?.destroy() },
        label: page.title,
        endEditing,
        toolbar,
        onPropertiesDoc(doc) {
          activeDoc = doc;
          activeLive = doc !== null;
          renderProperties(doc);
        },
        getPropertyField: (key) => propertyFields.find((f) => f.name === key),
      });
    // Design review only: type a sentence at the end of the page, then report keystroke-to-paint.
    if (page.autotype) autotype(body, samples);
    typed = samples;
  }
  // "Done" in the app's header ends editing: the caret goes, and with it the keyboard.
  (window as Window & { __dohcEndEditing?: () => void }).__dohcEndEditing = () => {
    endEditing();
    // Typing done through the keyboard reports its keystroke-to-paint times when editing ends.
    if (typed.length > 0) post("typing", typingSummary(typed));
  };
  const keyboard = followCaretAboveKeyboard(toolbar);
  revealCaret = keyboard.reveal;
  syncKeyboardLayout = keyboard.syncLayout;
  // First text on screen: after the frame that paints it.
  requestAnimationFrame(() => setTimeout(() => post("painted", { at: Date.now() }), 0));
}

function typingSummary(samples: readonly number[]) {
  const sorted = [...samples].sort((x, y) => x - y);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { count: sorted.length, median: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
}

function autotype(body: HTMLElement, samples: number[]) {
  const paragraphs = body.querySelectorAll("p");
  const paragraph = paragraphs[paragraphs.length - 1];
  if (!paragraph) return;
  setTimeout(() => {
    (body.querySelector(".markdown") as HTMLElement | null)?.focus();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    paragraph.scrollIntoView({ block: "center" });
    const text = " Typed on the phone to time each keystroke.";
    let index = 0;
    const timer = setInterval(() => {
      if (index < text.length) {
        document.execCommand("insertText", false, text[index++]);
        return;
      }
      clearInterval(timer);
      requestAnimationFrame(() => setTimeout(() => post("typing", typingSummary(samples)), 0));
    }, 80);
  }, 600);
}

// The page scrolls inside #editor, so the focus scroll in WebKit can't move it, and the app tells the page how
// much of it the keyboard covers. The page scrolls only when the caret would be hidden: when the keyboard comes up
// and while typing. A caret already in view leaves the page where it is.
function followCaretAboveKeyboard(toolbar: EditorToolbar) {
  let covered = 0;
  const keyboardTop = () => {
    // WebKit may already shrink the visual viewport for the keyboard; take whichever edge is higher, so the
    // keyboard is never counted twice.
    const viewport = window.visualViewport;
    return Math.min(
      document.documentElement.clientHeight - covered,
      viewport ? viewport.offsetTop + viewport.height : Number.POSITIVE_INFINITY,
    );
  };
  const keyboardInset = () => {
    if (covered === 0) return 0;
    const clientHeight = document.documentElement.clientHeight;
    return clientHeight > 0 ? Math.max(covered, clientHeight - keyboardTop()) : covered;
  };
  const reveal = () => {
    if (covered === 0) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !document.activeElement?.closest(".markdown"))
      return;
    // WebKit gives a caret on an empty line a zero rect, so the line break after the caret is measured instead, or
    // an empty line's own element.
    let caret = selection.getRangeAt(0).getBoundingClientRect();
    const node = selection.focusNode;
    if (caret.height === 0 && node instanceof Element) {
      const after = node.childNodes[selection.focusOffset];
      if (after instanceof HTMLBRElement) caret = after.getBoundingClientRect();
      if (caret.height === 0 && node !== document.activeElement)
        caret = node.getBoundingClientRect();
    }
    const bottom = keyboardTop() - toolbar.height() - 12;
    if (caret.bottom > bottom)
      document.getElementById("editor")?.scrollBy(0, caret.bottom - bottom);
  };
  const syncLayout = () => {
    const editor = document.getElementById("editor");
    const barHeight = toolbar.height();
    if (editor)
      editor.style.paddingBottom =
        covered > 0 ? `max(40vh, ${keyboardInset() + barHeight + 48}px)` : "";
    reveal();
  };
  const syncViewport = () => {
    if (covered === 0) return;
    toolbar.setKeyboard(covered, keyboardInset());
    syncLayout();
  };
  (window as Window & { __dohcKeyboard?: (height: number) => void }).__dohcKeyboard = (height) => {
    covered = Number.isFinite(height) && height > 0 ? height : 0;
    toolbar.setKeyboard(covered, keyboardInset());
    syncLayout();
  };
  document.addEventListener("selectionchange", () => requestAnimationFrame(reveal));
  window.visualViewport?.addEventListener("resize", syncViewport);
  window.visualViewport?.addEventListener("scroll", syncViewport);
  return { reveal, syncLayout };
}
