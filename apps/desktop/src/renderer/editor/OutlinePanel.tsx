// Notion-style outline rail: a slim column of dash marks pinned to the
// editor's right margin once the doc has ≥ 2 headings. Hovering (or
// keyboard-focusing, via :focus-within) expands it into a floating panel
// listing every heading; clicking one scrolls the editor there. The active
// section — the topmost heading currently in view — is emphasized in both.
//
// Positioning is CSS-only (position: sticky inside the shared grid cell
// set up in styles.css — see the "outline rail" comment there), so this
// component never measures or tracks its own placement; the only DOM
// measurement it does is figuring out which heading is "active" as the
// user scrolls, which is inherently scroll-driven and can't be CSS-only.

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import {
  extractOutline,
  resolveActiveHeadingIndex,
  type OutlineHeading,
} from "./outline";
import { useDebouncedWordCount } from "./wordCount";

// How far below the viewport's top edge a heading must scroll before it's
// considered "reached" — keeps the very top heading active for a beat
// after the user starts scrolling, instead of flipping the instant a new
// heading's pixel crosses y=0.
const ACTIVE_HEADING_READING_OFFSET = 72;

// Same convention theme.ts uses to install the CSS reduced-motion
// resets: the OS-level media query OR the app's own reduce-motion setting
// (mirrored onto <html data-reduce-motion>). scrollIntoView's `behavior`
// is JS, not CSS, so it isn't covered by the `scroll-behavior: auto
// !important` reset those install — an explicit "smooth" here must be
// downgraded by hand.
function prefersReducedMotion(): boolean {
  const appSetting =
    typeof document !== "undefined" &&
    document.documentElement.dataset.reduceMotion === "true";
  if (appSetting) return true;
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (/(auto|scroll)/.test(overflowY) && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/** Scroll the editor to a heading, briefly flashing it, and (when the
 *  editor is editable) moving the cursor there. Read-only mode still gets
 *  the scroll + flash, just no cursor move. */
function scrollToHeading(editor: Editor, heading: OutlineHeading) {
  try {
    const { node } = editor.view.domAtPos(heading.pos, 1);
    let el: Node | null = node;
    while (el && el.nodeType !== Node.ELEMENT_NODE) el = el.parentNode;
    const target = el as HTMLElement | null;
    if (!target) return;
    target.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    target.classList.add("dohc-outline-target-flash");
    window.setTimeout(() => target.classList.remove("dohc-outline-target-flash"), 900);
    if (editor.isEditable) {
      editor.chain().setTextSelection(heading.pos).run();
    }
  } catch {
    // Offscreen/jsdom editors cannot always resolve DOM positions.
  }
}

export type OutlinePanelProps = {
  editor: Editor | null;
  /** The `.dohc-tiptap-editor` container — used only to find the
   *  scrollable ancestor for active-heading tracking. */
  containerRef: RefObject<HTMLDivElement | null>;
};

export function OutlinePanel({ editor, containerRef }: OutlinePanelProps) {
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const wordCount = useDebouncedWordCount(editor);

  // extractOutline always returns a fresh array (even when the flattened
  // heading list is unchanged), so `headings` gets a new reference on every
  // editor `update` — i.e. every keystroke. The scroll-tracking effect below
  // needs the CURRENT headings to resolve the active section, but it must
  // not treat every keystroke as a reason to tear down and reattach its
  // scroll listener (that forces a coordsAtPos layout read per heading on
  // every keystroke — see the ref below). Reading through a ref, kept in
  // sync here, decouples "know the current headings" from "the listener's
  // dependency array".
  const headingsRef = useRef<OutlineHeading[]>(headings);
  // Set by the scroll-tracking effect below; re-invoked (never re-created)
  // whenever headings change so a doc edit still refreshes which heading is
  // "active" without re-running the effect that owns the listener.
  const scheduleActiveUpdateRef = useRef<(() => void) | null>(null);

  // Recompute the heading list synchronously (cheap: a handful of nodes) on
  // every doc change. The word count is handled by useDebouncedWordCount above.
  useEffect(() => {
    if (!editor) {
      setHeadings([]);
      return;
    }
    const recomputeHeadings = () => {
      const next = extractOutline(editor.state.doc);
      // Keep the ref the scroll effect reads in lockstep with the rendered
      // outline: the later `[headings]` effect also syncs it, but setting it
      // here closes the window where a scroll during an editor change would
      // resolve the active heading against the previous outline.
      headingsRef.current = next;
      setHeadings(next);
    };

    recomputeHeadings();

    const onUpdate = () => {
      recomputeHeadings();
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [editor]);

  // Keep the ref in sync with the latest headings, and ask the scroll effect
  // (if it's attached) to refresh the active heading — via the SAME
  // rAF-coalesced scheduler the scroll listener uses, so a burst of
  // keystrokes collapses into at most one geometry read per frame instead of
  // one per keystroke.
  useEffect(() => {
    headingsRef.current = headings;
    scheduleActiveUpdateRef.current?.();
  }, [headings]);

  // Track scroll to resolve which section is active. Attaches once per
  // editor/containerRef (NOT per headings change — see headingsRef above),
  // so editing the document never tears down and reattaches this listener.
  useEffect(() => {
    if (!editor) return;
    const scrollEl = findScrollParent(containerRef.current);
    if (!scrollEl) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      const currentHeadings = headingsRef.current;
      if (currentHeadings.length === 0) return;
      const containerRect = scrollEl.getBoundingClientRect();
      const tops = currentHeadings.map((h) => {
        try {
          return editor.view.coordsAtPos(h.pos).top - containerRect.top + scrollEl.scrollTop;
        } catch {
          // resolveActiveHeadingIndex assumes ascending tops; a `0` here would
          // read as "already scrolled past" and override a correct earlier
          // heading. Infinity can never be mistaken for "reached".
          return Number.POSITIVE_INFINITY;
        }
      });
      setActiveIndex(
        resolveActiveHeadingIndex(tops, scrollEl.scrollTop, ACTIVE_HEADING_READING_OFFSET),
      );
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(update);
    };
    scheduleActiveUpdateRef.current = onScroll;

    update();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      scheduleActiveUpdateRef.current = null;
    };
  }, [editor, containerRef]);

  if (!editor || headings.length < 2) return null;

  return (
    <nav className="dohc-outline" aria-label="Document outline">
      <div className="dohc-outline-rail" aria-hidden="true">
        {headings.map((h, i) => (
          <span
            key={h.pos}
            className={`dohc-outline-rail-mark dohc-outline-rail-mark--level-${h.level}${
              i === activeIndex ? " is-active" : ""
            }`}
          />
        ))}
      </div>
      <div className="dohc-outline-panel dohc-popover">
        <ul className="dohc-outline-list">
          {headings.map((h, i) => (
            <li key={h.pos}>
              <button
                type="button"
                className={`dohc-outline-item dohc-outline-item--level-${h.level}${
                  i === activeIndex ? " is-active" : ""
                }`}
                aria-current={i === activeIndex ? "true" : undefined}
                onClick={() => scrollToHeading(editor, h)}
              >
                {h.text}
              </button>
            </li>
          ))}
        </ul>
        <div className="dohc-outline-wordcount">
          {wordCount.words.toLocaleString()} words · {wordCount.characters.toLocaleString()}{" "}
          characters
        </div>
      </div>
    </nav>
  );
}
