import { useFocusReturn } from "./ui/focusReturn";
import { isComposingKey } from "./ui/keys";
import {
  frontmatterEditsRefused,
  markdownFrontmatterEditsRefused,
  FRONTMATTER_EDIT_REFUSED_MESSAGE,
} from "@dohc/ydoc-projection/frontmatter";
import { patchFrontmatter, setFrontmatterValue } from "@dohc/ydoc-projection/frontmatter-map";
import { modalFocusableElements, switchModalRegion, trapModalTabKey } from "./modalFocus";
import { Smile } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import type { Lexer } from "marked";
import {
  applyFrontmatter,
  displayFrontmatterValue,
  markdownEditorBody,
  orderFrontmatter,
  parseFrontmatter,
} from "./markdown/frontmatter";
import { lexesAsH1, opensWithH1 } from "./markdown/firstBlock";
import { TOPMATTER_FLAG } from "./pageTopmatter";

// The frontmatter Y.Map field name shared with PropertiesPanel. Title + icon
// are reserved keys the document system owns — this
// surface edits them directly instead of exposing them as user properties.
const FRONTMATTER_FIELD = "frontmatter";
// The body editor's fragment in a live document.
const BODY_FIELD = "body";

// One title: a page with no `title` whose body opens with an H1 shows that
// H1 as its title, and the title field folds into the row beside the icon.
// Both answers read the first block alone, never the rest of the document.

// The editor's own Markdown lexer, for a paragraph with an underline (see
// markdown/firstBlock.ts). It loads with the editor's chunk, not at launch;
// until it arrives, such a page shows its title open.
let lexer: typeof Lexer | null = null;
let lexerLoad: Promise<typeof Lexer> | null = null;
function loadLexer(): Promise<typeof Lexer> {
  lexerLoad ??= import("marked").then(
    (module) => (lexer = module.Lexer),
    (error: unknown) => {
      lexerLoad = null;
      throw error;
    },
  );
  return lexerLoad;
}

// A local page's body is the Markdown after its frontmatter. The lines to lex
// are a string, so an edit that leaves them unchanged lexes nothing.
function useLocalOpensWithH1(markdown: string | null): boolean {
  const decided = useMemo(() => (markdown === null ? false : opensWithH1(markdownEditorBody(markdown))), [markdown]);
  const block = typeof decided === "string" ? decided : null;
  const [loaded, setLoaded] = useState(() => lexer);
  useEffect(() => {
    if (block === null || loaded) return;
    let current = true;
    loadLexer().then(
      (next) => {
        if (current) setLoaded(() => next);
      },
      // Without the lexer the title stays open, as it is on a page with no H1.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [block, loaded]);
  const lexed = useMemo(() => block !== null && loaded !== null && lexesAsH1(loaded, block), [block, loaded]);
  return typeof decided === "boolean" ? decided : lexed;
}

function isH1(node: unknown): boolean {
  return node instanceof Y.XmlElement && node.nodeName === "heading" && Number(node.getAttribute("level")) === 1;
}

// In a live document, the body fragment's first child. The fragment reports
// blocks added or removed, and the first block reports its own attributes;
// typing inside a block reports to neither. The snapshot is a boolean, so a
// report that leaves the answer unchanged renders nothing.
function useLiveOpensWithH1(ydoc: Y.Doc | null): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!ydoc) return () => undefined;
      const body = ydoc.getXmlFragment(BODY_FIELD);
      let first: Y.XmlElement | null = null;
      const watchFirst = () => {
        const next = body.get(0);
        const element = next instanceof Y.XmlElement ? next : null;
        if (element === first) return;
        first?.unobserve(onChange);
        first = element;
        first?.observe(onChange);
      };
      const onBody = () => {
        watchFirst();
        onChange();
      };
      watchFirst();
      body.observe(onBody);
      return () => {
        body.unobserve(onBody);
        first?.unobserve(onChange);
      };
    },
    [ydoc],
  );
  return useSyncExternalStore(subscribe, () => (ydoc ? isH1(ydoc.getXmlFragment(BODY_FIELD).get(0)) : false));
}

const TITLE_FIELD = "block resize-none overflow-hidden border-0 bg-transparent field-sizing-content read-only:cursor-default";
// Its own line under the icon, as large as the drawing's title.
const TITLE_OPEN = `${TITLE_FIELD} w-full basis-full p-0 font-sans text-[2em] font-bold leading-[1.15] tracking-[-0.02em] text-ink placeholder:text-subtle`;
// Folded beside "Add icon", and shown with it while the pointer is over the
// page's identity or the field has focus. A read-only page has nothing to
// add, so it stays hidden. Square corners keep its focus underline straight,
// like the pills' fields.
const TITLE_FOLDED = `${TITLE_FIELD} px-1.5 py-[3px] text-[12.5px] leading-normal text-subtle placeholder:text-subtle hover:placeholder:text-muted focus:placeholder:text-muted`;
// "Add icon" shows while the pointer is over the page's identity or focus is
// anywhere in it, so a focused "Add title" never sits beside an empty gap.
const ADD_ICON =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-[3px] text-[12.5px] text-subtle opacity-0 transition-[opacity,color] duration-100 ease-out hover:text-muted focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100";

// A small curated palette — enough for the common cases (docs, projects,
// status, life) without shipping a multi-thousand-emoji database. Anything
// outside the grid can be pasted into the free-text field below it.
const EMOJI_CHOICES = [
  "📄", "📝", "📓", "📔", "📚", "📖", "🗒️", "🗂️", "📁", "📌",
  "✅", "☑️", "🔖", "🏷️", "📋", "🧾", "📊", "📈", "📉", "🗓️",
  "💡", "🔥", "⭐", "🌟", "✨", "🎯", "🚀", "🧠", "❤️", "⚡",
  "🎨", "🎬", "🎵", "📷", "🕹️", "🧩", "🛠️", "⚙️", "🔧", "🔨",
  "💰", "💳", "🏦", "📦", "🛒", "🧮", "📐", "📎", "✏️", "🖊️",
  "🌱", "🌿", "🍀", "🌍", "☀️", "🌙", "⛅", "❄️", "🔒", "🔑",
  "🏠", "🏢", "🏝️", "🧳", "✈️", "🚗", "🍽️", "☕", "🏃", "💪",
  "🐛", "🎓", "👤", "👥", "💬", "📣", "🔔", "❓", "❗", "⏰",
] as const;

// Page identity above the document body: a large title and an emoji
// icon, both stored as reserved `title` / `icon` frontmatter keys. This is a
// sibling React surface — not part of the ProseMirror doc — so it never
// touches the editor schema. It reuses the same read/write plumbing as
// PropertiesPanel: a plain markdown body with YAML frontmatter (local mode,
// via applyFrontmatter through onChange) OR the frontmatter Y.Map (collab /
// engine mode, via a direct transaction).
export type PageIdentityProps = (
  | { body: string; onChange: (nextBody: string) => void; ydoc?: never }
  | { ydoc: Y.Doc; body?: never; onChange?: never }
) & {
  // Placeholder when the page has no title — the filename stem, Notion-style.
  filenameStem: string;
  // Read-only surfaces (truncated / shared views) show the identity but never
  // edit it.
  readOnly?: boolean;
  // An editable page whose document is still opening refuses edits, and
  // holds the box of every control it will show, so nothing moves when it
  // becomes editable.
  opening?: boolean;
  // Enter, or ArrowDown on the title's last line, moves focus into the body
  // editor's start.
  onEnterBody?: () => void;
  // A new page opens with the cursor in its title.
  autoFocus?: boolean;
};

// A title is one line, so pasted or dropped line breaks become spaces.
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

const MIRRORED_STYLES = [
  "boxSizing", "width", "paddingLeft", "paddingRight", "borderLeftWidth", "borderRightWidth",
  "fontFamily", "fontSize", "fontStyle", "fontWeight", "fontStretch", "fontFeatureSettings",
  "fontVariationSettings", "letterSpacing", "wordSpacing", "lineHeight", "textTransform", "textIndent",
] as const;

// Whether the caret is on the title's last visual line, where ArrowDown
// moves on to the body. A textarea gives no geometry for its text, so a
// hidden copy with the same width and font lays it out again: the text after
// the caret stays on one line only when the caret is on the last one.
// Mixed-direction text splits one line into several boxes, so this compares
// where the boxes sit, not how many there are.
function caretOnLastLine(field: HTMLTextAreaElement): boolean {
  const rest = field.value.slice(field.selectionEnd);
  if (rest === "") return true;
  const style = getComputedStyle(field);
  const mirror = document.createElement("div");
  for (const name of MIRRORED_STYLES) mirror.style[name] = style[name];
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "0",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  });
  mirror.textContent = field.value.slice(0, field.selectionEnd);
  const after = document.createElement("span");
  after.textContent = rest;
  mirror.append(after);
  document.body.append(mirror);
  try {
    // A DOM without layout reports no boxes; that counts as one line.
    const boxes = [...after.getClientRects()];
    const top = Math.min(...boxes.map((box) => box.top));
    return boxes.every((box) => box.top < top + box.height / 2);
  } finally {
    mirror.remove();
  }
}

function mapToObject(map: Y.Map<unknown>): Record<string, unknown> {
  return Object.fromEntries(map.entries());
}

export function PageIdentity(props: PageIdentityProps) {
  const ydoc = props.ydoc ?? null;
  const body = props.body ?? "";
  const opening = (props.opening ?? false) && !props.readOnly;
  const readOnly = (props.readOnly ?? false) || opening;
  const [ydocRevision, setYdocRevision] = useState(0);

  useEffect(() => {
    if (!ydoc) return;
    const map = ydoc.getMap(FRONTMATTER_FIELD);
    const update = () => setYdocRevision((revision) => revision + 1);
    map.observe(update);
    return () => map.unobserve(update);
  }, [ydoc]);

  const meta = useMemo(() => {
    if (ydoc) return mapToObject(ydoc.getMap(FRONTMATTER_FIELD));
    return parseFrontmatter(body).meta;
    // ydocRevision re-reads the observed map after a shared write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, ydoc, ydocRevision]);

  const title = displayFrontmatterValue(meta.title);
  const liveOpensWithH1 = useLiveOpensWithH1(ydoc);
  const localOpensWithH1 = useLocalOpensWithH1(ydoc ? null : body);
  const [editRefused, setEditRefused] = useState(false);
  useEffect(() => setEditRefused(false), [ydoc, body]);
  const icon =
    typeof meta.icon === "string" ? meta.icon : displayFrontmatterValue(meta.icon);

  // Reserved-key writes go through the same pathway PropertiesPanel uses so
  // there is no second save cycle: a Y.Map transaction for collab, or a
  // frontmatter rewrite handed back through onChange for local markdown.
  function writeField(key: "title" | "icon", value: string | undefined) {
    // An unsplittable block cannot change one property without
    // rewriting the others, so the write is refused before it starts.
    if (readOnly || (ydoc ? frontmatterEditsRefused(ydoc) : markdownFrontmatterEditsRefused(body))) return;
    try {
      if (ydoc) {
        if (value === undefined || value === "") patchFrontmatter(ydoc, new Map(), [key]);
        else setFrontmatterValue(ydoc, key, value);
      } else {
        const next = { ...parseFrontmatter(body).meta };
        if (value === undefined || value === "") delete next[key];
        else next[key] = value;
        props.onChange?.(applyFrontmatter(body, orderFrontmatter(next)));
      }
      setEditRefused(false);
    } catch {
      setEditRefused(true);
    }
  }

  // The title keeps its own draft so typing stays smooth; it re-syncs from
  // frontmatter whenever an external change lands and the field isn't focused
  // (mirrors how PropertiesPanel avoids a dirty-loop with the editor).
  const [titleDraft, setTitleDraft] = useState(title);
  const [titleFocused, setTitleFocused] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const titleCaret = useRef<number | null>(null);
  // A blur while an input method composes can come before the composed text
  // reaches onChange. The field keeps its text until the composition ends.
  const titleComposing = useRef(false);
  const [blurHeld, setBlurHeld] = useState(false);
  // An open title stays open until its composition ends, so interim text
  // that empties the field does not fold it mid-composition.
  const [openWhileComposing, setOpenWhileComposing] = useState(false);
  // Ends a composition, and the blur it held back if the field has lost
  // focus. The draft re-syncs from the title once the composed text, if any,
  // has been written.
  function endComposition() {
    titleComposing.current = false;
    setBlurHeld(false);
    setOpenWhileComposing(false);
    if (document.activeElement !== titleRef.current) setTitleFocused(false);
  }
  // Some input methods never send compositionend after a blur. The person's
  // next click or key elsewhere, or the window's next focus, ends the
  // composition instead, so the field cannot ignore later blurs, or outside
  // changes to the title, for good. Not focusin: the focus move that held the blur can still
  // be arriving at its new element.
  useEffect(() => {
    if (!blurHeld) return;
    const elsewhere = (event: Event) => {
      if (event.target === titleRef.current) return;
      // A key the input method still owns is part of the composition.
      if (event instanceof KeyboardEvent && isComposingKey(event)) return;
      endComposition();
    };
    const events = ["pointerdown", "keydown"] as const;
    for (const name of events) document.addEventListener(name, elsewhere, true);
    window.addEventListener("focus", elsewhere);
    return () => {
      for (const name of events) document.removeEventListener(name, elsewhere, true);
      window.removeEventListener("focus", elsewhere);
    };
    // endComposition reads only refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blurHeld]);
  useLayoutEffect(() => {
    const caret = titleCaret.current;
    if (caret === null) return;
    titleCaret.current = null;
    titleRef.current?.setSelectionRange(caret, caret);
  });
  useEffect(() => {
    if (!titleFocused) setTitleDraft(title);
  }, [title, titleFocused]);
  // The same field folds and unfolds, so focus, caret and Tab order stay.
  // It folds while it holds no text, whether or not it has focus, so focus
  // and blur never move what is below it: the first character typed opens
  // it, and clearing it folds it again. While it has focus, the text on
  // screen decides, so a title written elsewhere opens it only on blur.
  const empty = titleFocused ? titleDraft === "" : title === "";
  const folded = (liveOpensWithH1 || localOpensWithH1) && empty && !openWhileComposing;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [emojiInput, setEmojiInput] = useState("");
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // The icon/add-icon button is whichever one is currently rendered — they
  // never render at once, so one ref safely tracks "the trigger" across an
  // icon being set/cleared while the picker is open.
  const iconTriggerRef = useRef<HTMLButtonElement | null>(null);
  useFocusReturn(pickerOpen, pickerRef, () => iconTriggerRef.current);

  // role="dialog" implies focus moves inside on open and is constrained
  // (trapped) to the picker while it's open, then returns to the trigger on
  // close — otherwise a screen reader announces a dialog the user isn't
  // actually inside, and a keyboard user who selects an emoji loses their
  // place when the picker unmounts.
  useEffect(() => {
    if (!pickerOpen) return;
    const container = pickerRef.current;
    if (container) modalFocusableElements(container)[0]?.focus();

    function onPointerDown(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      // F6 reaches a toast above the picker and comes back; Escape in a
      // toast comes back too instead of closing the picker.
      if (switchModalRegion(event, pickerRef.current)) return;
      if (event.key === "Escape") {
        setPickerOpen(false);
        return;
      }
      trapModalTabKey(event, pickerRef.current);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  function chooseIcon(next: string) {
    const trimmed = next.trim();
    if (trimmed) writeField("icon", trimmed);
    setPickerOpen(false);
    setEmojiInput("");
  }

  function removeIcon() {
    writeField("icon", undefined);
    setPickerOpen(false);
    setEmojiInput("");
  }

  return (
    <div className="dohc-page-identity group" data-testid="page-identity">
      {/* The icon's line, then the title on its own line. Folded, the title
          joins the icon's line. */}
      <div className="dohc-page-identity__inner flex flex-wrap items-center gap-x-1 gap-y-3">
        {editRefused ? <span role="status" className={`${TOPMATTER_FLAG} basis-full px-1.5`} title={FRONTMATTER_EDIT_REFUSED_MESSAGE}>Edit in Source</span> : null}
        <div className="relative min-h-5">
          {icon ? (
            <button
              ref={iconTriggerRef}
              type="button"
              data-testid="page-icon"
              aria-label="Change icon"
              title="Change icon"
              disabled={readOnly}
              onClick={() => setPickerOpen((open) => !open)}
              className="dohc-page-identity__icon"
            >
              <span aria-hidden>{icon}</span>
            </button>
          ) : !readOnly ? (
            <button
              ref={iconTriggerRef}
              type="button"
              data-testid="page-icon-add"
              aria-label="Add icon"
              onClick={() => setPickerOpen((open) => !open)}
              className={ADD_ICON}
            >
              <Smile size={15} aria-hidden />
              Add icon
            </button>
          ) : opening ? (
            <button type="button" disabled tabIndex={-1} aria-hidden className={`${ADD_ICON} invisible`}>
              <Smile size={15} aria-hidden />
              Add icon
            </button>
          ) : null}
          {pickerOpen ? (
            <div
              ref={pickerRef}
              data-testid="page-icon-picker"
              className="dohc-page-identity__picker"
              role="dialog"
              aria-modal="true"
              aria-label="Choose an icon"
            >
              <div className="dohc-page-identity__picker-grid">
                {EMOJI_CHOICES.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    aria-label={`Use ${choice}`}
                    onClick={() => chooseIcon(choice)}
                    className="dohc-page-identity__picker-emoji"
                  >
                    <span aria-hidden>{choice}</span>
                  </button>
                ))}
              </div>
              <div className="dohc-page-identity__picker-actions">
                <input
                  data-testid="page-icon-input"
                  aria-label="Paste an emoji"
                  placeholder="Paste emoji"
                  value={emojiInput}
                  spellCheck={false}
                  onChange={(event) => setEmojiInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !isComposingKey(event) && emojiInput.trim()) {
                      event.preventDefault();
                      chooseIcon(emojiInput);
                    }
                  }}
                  className="dohc-page-identity__picker-field"
                />
                <button
                  type="button"
                  data-testid="page-icon-remove"
                  onClick={removeIcon}
                  className="dohc-page-identity__picker-remove"
                >
                  Remove
                </button>
              </div>
            </div>
          ) : null}
        </div>
        {/* A textarea so a long title wraps instead of clipping in a narrow
            pane. The title stays one line: Enter, and ArrowDown on its last
            visual line, move to the body, and pasted line breaks become
            spaces. */}
        <textarea
          ref={titleRef}
          data-testid="page-title"
          aria-label="Page title"
          rows={1}
          autoFocus={props.autoFocus}
          value={titleDraft}
          placeholder={folded ? "Add title" : props.filenameStem}
          spellCheck={false}
          readOnly={readOnly}
          onFocus={() => {
            // Focus back in the field ends a composition it never ended.
            titleComposing.current = false;
            setBlurHeld(false);
            setOpenWhileComposing(false);
            setTitleFocused(true);
          }}
          onBlur={() => {
            if (titleComposing.current) {
              setBlurHeld(true);
              return;
            }
            setTitleFocused(false);
            setTitleDraft(title);
          }}
          onCompositionStart={() => {
            titleComposing.current = true;
            if (!folded) setOpenWhileComposing(true);
          }}
          onCompositionEnd={endComposition}
          onChange={(event) => {
            const field = event.target;
            const next = oneLine(field.value);
            // Replacing a line break moves the caret to the end; keep it
            // after the text that was typed or pasted.
            if (next !== field.value) {
              titleCaret.current = oneLine(field.value.slice(0, field.selectionEnd)).length;
            }
            setTitleDraft(next);
            writeField("title", next.length === 0 ? undefined : next);
            if (titleComposing.current && next !== "") setOpenWhileComposing(true);
            // Committed text arriving after the blur is the composition's
            // last word; interim text is not.
            const input = event.nativeEvent;
            const interim =
              input instanceof InputEvent && (input.isComposing || input.inputType === "insertCompositionText");
            if (blurHeld && !interim) endComposition();
          }}
          onKeyDown={(event) => {
            // During IME composition, Enter and ArrowDown pick a candidate.
            if (isComposingKey(event)) return;
            const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
            if (
              event.key === "Enter" ||
              (event.key === "ArrowDown" && plain && caretOnLastLine(event.currentTarget))
            ) {
              event.preventDefault();
              props.onEnterBody?.();
            }
          }}
          className={
            !folded
              ? TITLE_OPEN
              : readOnly
                ? `${TITLE_FOLDED} invisible`
                : `${TITLE_FOLDED} opacity-0 transition-opacity duration-100 ease-out group-hover:opacity-100 focus:opacity-100`
          }
        />
      </div>
    </div>
  );
}
