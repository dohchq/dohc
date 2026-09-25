import {
  frontmatterEditsRefused,
  markdownFrontmatterEditsRefused,
  setFrontmatterValue,
  patchFrontmatter,
  FRONTMATTER_EDIT_REFUSED_MESSAGE,
} from "@dohc/ydoc-projection/frontmatter";
import { modalFocusableElements, trapModalTabKey } from "./modalFocus";
import { Smile } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as Y from "yjs";
import {
  applyFrontmatter,
  displayFrontmatterValue,
  orderFrontmatter,
  parseFrontmatter,
} from "./markdown/frontmatter";

// The frontmatter Y.Map field name shared with PropertiesPanel. Title + icon
// are reserved keys the document system owns — this
// surface edits them directly instead of exposing them as user properties.
const FRONTMATTER_FIELD = "frontmatter";

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

// Page identity above the document body: a large serif title and an emoji
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
  // Enter, or ArrowDown on the title's last line, moves focus into the body
  // editor's start.
  onEnterBody?: () => void;
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
  const readOnly = props.readOnly ?? false;
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
  const titleFocused = useRef(false);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const titleCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const caret = titleCaret.current;
    if (caret === null) return;
    titleCaret.current = null;
    titleRef.current?.setSelectionRange(caret, caret);
  });
  useEffect(() => {
    if (!titleFocused.current) setTitleDraft(title);
  }, [title]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [emojiInput, setEmojiInput] = useState("");
  const pickerRef = useRef<HTMLDivElement | null>(null);
  // The icon/add-icon button is whichever one is currently rendered — they
  // never render at once, so one ref safely tracks "the trigger" across an
  // icon being set/cleared while the picker is open.
  const iconTriggerRef = useRef<HTMLButtonElement | null>(null);

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
      iconTriggerRef.current?.focus();
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
      <div className="dohc-page-identity__inner">
        {editRefused ? <span role="status" className="dohc-page-properties__flag" title={FRONTMATTER_EDIT_REFUSED_MESSAGE}>Edit in text</span> : null}
        <div className="dohc-page-identity__icon-row">
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
              className="dohc-page-identity__add-icon"
            >
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
                    if (event.key === "Enter" && emojiInput.trim()) {
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
          value={titleDraft}
          placeholder={props.filenameStem}
          spellCheck={false}
          readOnly={readOnly}
          onFocus={() => {
            titleFocused.current = true;
          }}
          onBlur={() => {
            titleFocused.current = false;
            setTitleDraft(title);
          }}
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
          }}
          onKeyDown={(event) => {
            // During IME composition, Enter and ArrowDown pick a candidate.
            // Some browsers mark that key only with keyCode 229.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
            if (
              event.key === "Enter" ||
              (event.key === "ArrowDown" && plain && caretOnLastLine(event.currentTarget))
            ) {
              event.preventDefault();
              props.onEnterBody?.();
            }
          }}
          className="dohc-page-identity__title"
        />
      </div>
    </div>
  );
}
