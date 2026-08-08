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
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  extractOutline,
  resolveActiveHeadingIndex,
  type OutlineHeading,
} from "./outline";
import { useDebouncedWordCount } from "./wordCount";
import { prefersReducedMotion } from "../reducedMotion";
import {
  allocateWorkspaceHeadingAnchors,
  resolveWorkspaceHeadingAnchorTarget,
} from "../../workspaces/workspaceHeadings";

// How far below the viewport's top edge a heading must scroll before it's
// considered "reached" — keeps the very top heading active for a beat
// after the user starts scrolling, instead of flipping the instant a new
// heading's pixel crosses y=0.
const ACTIVE_HEADING_READING_OFFSET = 72;

type HeadingFlashState = {
  token: number | null;
  decorations: DecorationSet;
};

type HeadingFlashMeta =
  | { kind: "show"; pos: number; token: number }
  | { kind: "clear"; token: number };

export const headingFlashPluginKey = new PluginKey<HeadingFlashState>(
  "dohc-heading-target-flash",
);

/** A node decoration keeps the flash inside ProseMirror's render lifecycle.
 * Directly mutating a heading class is interpreted as an editor DOM change and
 * can be replaced by block-control decorations before the user sees it. */
export function makeHeadingFlashPlugin(): Plugin<HeadingFlashState> {
  return new Plugin<HeadingFlashState>({
    key: headingFlashPluginKey,
    state: {
      init: () => ({ token: null, decorations: DecorationSet.empty }),
      apply(transaction, current) {
        const meta = transaction.getMeta(headingFlashPluginKey) as
          | HeadingFlashMeta
          | undefined;
        if (meta?.kind === "show") {
          const node = transaction.doc.nodeAt(meta.pos);
          if (!node) return { token: null, decorations: DecorationSet.empty };
          return {
            token: meta.token,
            decorations: DecorationSet.create(transaction.doc, [
              Decoration.node(meta.pos, meta.pos + node.nodeSize, {
                class: "dohc-outline-target-flash",
              }),
            ]),
          };
        }
        if (meta?.kind === "clear") {
          return meta.token === current.token
            ? { token: null, decorations: DecorationSet.empty }
            : current;
        }
        return {
          ...current,
          decorations: current.decorations.map(
            transaction.mapping,
            transaction.doc,
          ),
        };
      },
    },
    props: {
      decorations(state) {
        return headingFlashPluginKey.getState(state)?.decorations ?? null;
      },
    },
  });
}

let nextHeadingFlashToken = 0;

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

/** Reveal a navigation target: flash the node at `pos`, scroll it into view,
 *  and — when `moveCursorTo` is given and the editor is editable — put the
 *  cursor there. `resolveElement` runs AFTER the flash dispatch, because
 *  selection-driven decorations can replace the rendered node and resolving
 *  the DOM first would scroll a detached element.
 *
 *  Returns a cleanup that clears the flash early, or undefined when nothing
 *  was revealed — a caller that must not lose the jump retries on that. */
export function revealDocPosition(
  editor: Editor,
  pos: number,
  resolveElement: () => HTMLElement | null,
  moveCursorTo?: number,
): (() => void) | undefined {
  try {
    if (moveCursorTo !== undefined && editor.isEditable) {
      editor.chain().setTextSelection(moveCursorTo).run();
    }
    const flashToken = ++nextHeadingFlashToken;
    editor.view.dispatch(
      editor.state.tr.setMeta(headingFlashPluginKey, {
        kind: "show",
        pos,
        token: flashToken,
      } satisfies HeadingFlashMeta),
    );
    const clearFlash = () => {
      if (editor.isDestroyed) return;
      editor.view.dispatch(
        editor.state.tr.setMeta(headingFlashPluginKey, {
          kind: "clear",
          token: flashToken,
        } satisfies HeadingFlashMeta),
      );
    };
    const target = resolveElement();
    if (!target) {
      clearFlash();
      return;
    }
    target.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    const flashTimer = window.setTimeout(clearFlash, 900);
    return () => {
      window.clearTimeout(flashTimer);
      clearFlash();
    };
  } catch {
    // Offscreen/jsdom editors cannot always resolve DOM positions.
  }
}

/** Scroll the editor to a heading, briefly flashing it, and (when the
 *  editor is editable) moving the cursor there. Read-only mode still gets
 *  the scroll + flash, just no cursor move. */
function scrollToHeading(
  editor: Editor,
  heading: OutlineHeading,
  moveCursor = true,
): (() => void) | undefined {
  return revealDocPosition(
    editor,
    heading.pos,
    () => {
      // Resolve by document-order index against the live editor DOM. Some
      // decoration plugins briefly retain stale position→DOM mappings while
      // replacing block nodes, but heading order remains identical.
      const headingIndex = extractOutline(editor.state.doc).findIndex(
        (candidate) => candidate.pos === heading.pos,
      );
      if (headingIndex < 0) return null;
      return (
        editor.view.dom.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")[
          headingIndex
        ] ?? null
      );
    },
    moveCursor ? heading.pos + 1 : undefined,
  );
}

/** Where the reader is in the document. `nonce` lets callers repeat a jump to
 * the same heading without changing the stable anchor identity.
 *
 * Deliberately NOT consumable, unlike `BlockNavigationTarget` (#680, #685):
 * this target has no consumed-callback, so a remount re-applies it and a
 * version switch returns the reader to their heading instead of the top of the
 * document. FileInspector.test.tsx pins that. */
export type HeadingNavigationTarget = {
  anchor: string;
  occurrence?: number;
  nonce: number;
};

type AnchoredOutlineHeading = {
  heading: OutlineHeading;
  text: string;
  anchor: string;
  anchorBase: string;
  occurrence: number;
};

/** Resolve editor headings with the same base + numeric-suffix convention as
 * workspaceHeadings. Supporting both the canonical unique anchor (`plan-1`)
 * and `{ anchor: "plan", occurrence: 1 }` keeps navigation exact for records
 * that store the duplicate ordinal separately. */
export function resolveOutlineHeadingTarget(
  headings: readonly OutlineHeading[],
  target: Pick<HeadingNavigationTarget, "anchor" | "occurrence">,
): OutlineHeading | null {
  const anchors = allocateWorkspaceHeadingAnchors(headings);
  const anchored: AnchoredOutlineHeading[] = headings.map((heading, index) => {
    const identity = anchors[index]!;
    return {
      heading,
      text: heading.text,
      ...identity,
    };
  });
  return resolveWorkspaceHeadingAnchorTarget(anchored, target)?.heading ?? null;
}

export type OutlinePanelProps = {
  editor: Editor | null;
  /** The `.dohc-tiptap-editor` container — used only to find the
   *  scrollable ancestor for active-heading tracking. */
  containerRef: RefObject<HTMLDivElement | null>;
  headingTarget?: HeadingNavigationTarget;
};

export function OutlinePanel({ editor, containerRef, headingTarget }: OutlinePanelProps) {
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

  // Apply an external heading jump once per target identity. If a collaborative
  // document has not received that heading yet, keep one lightweight editor
  // update listener until it appears instead of silently losing the jump.
  useEffect(() => {
    if (!editor || !headingTarget) return;
    let cleanupFlash: (() => void) | undefined;
    let firstFrame = 0;
    let secondFrame = 0;
    const applyTarget = () => {
      const heading = resolveOutlineHeadingTarget(
        extractOutline(editor.state.doc),
        headingTarget,
      );
      if (!heading) return;
      editor.off("update", applyTarget);
      cleanupFlash = scrollToHeading(editor, heading, false);
    };
    // The editor installs selection/block decorations during its first paint.
    // Wait until that two-frame setup settles so the highlighted DOM node is
    // not immediately replaced underneath the flash.
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        applyTarget();
        if (!cleanupFlash) editor.on("update", applyTarget);
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      editor.off("update", applyTarget);
      cleanupFlash?.();
    };
  }, [editor, headingTarget?.anchor, headingTarget?.occurrence, headingTarget?.nonce]);

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
