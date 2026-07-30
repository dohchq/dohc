import { Smile } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
// sibling React surface — NOT part of the ProseMirror doc — so it never
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
  // Enter / ArrowDown in the title moves focus into the body editor's start.
  onEnterBody?: () => void;
};

function mapToObject(map: Y.Map<unknown>): Record<string, unknown> {
  return Object.fromEntries(map.entries());
}

// Elements a keyboard user can land on inside the picker — used both to seed
// focus on open and to loop Tab/Shift+Tab within the dialog.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
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
  const icon =
    typeof meta.icon === "string" ? meta.icon : displayFrontmatterValue(meta.icon);

  // Reserved-key writes go through the SAME pathway PropertiesPanel uses so
  // there is no second save cycle: a Y.Map transaction for collab, or a
  // frontmatter rewrite handed back through onChange for local markdown.
  function writeField(key: "title" | "icon", value: string | undefined) {
    if (readOnly) return;
    if (ydoc) {
      ydoc.transact(() => {
        const map = ydoc.getMap(FRONTMATTER_FIELD);
        if (value === undefined || value === "") map.delete(key);
        else map.set(key, value);
      });
      return;
    }
    const next = { ...parseFrontmatter(body).meta };
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    props.onChange?.(applyFrontmatter(body, orderFrontmatter(next)));
  }

  // The title keeps its own draft so typing stays smooth; it re-syncs from
  // frontmatter whenever an external change lands and the field isn't focused
  // (mirrors how PropertiesPanel avoids a dirty-loop with the editor).
  const [titleDraft, setTitleDraft] = useState(title);
  const titleFocused = useRef(false);
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
    getFocusable(container ?? document.createElement("div"))[0]?.focus();

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
      if (event.key !== "Tab" || !pickerRef.current) return;
      const focusable = getFocusable(pickerRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
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
        <input
          data-testid="page-title"
          aria-label="Page title"
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
            const next = event.target.value;
            setTitleDraft(next);
            writeField("title", next.length === 0 ? undefined : next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "ArrowDown") {
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
