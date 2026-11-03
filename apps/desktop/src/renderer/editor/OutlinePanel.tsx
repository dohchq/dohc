// Notion-style outline rail: a slim column of dash marks pinned to the
// editor's right margin once the doc has ≥ 2 headings. Hovering (or
// keyboard-focusing, via :focus-within) expands it into a floating panel
// listing every heading; clicking one scrolls the editor there. The active
// section — the topmost heading currently in view — is emphasized in both.
//
// Positioning is CSS-only (position: sticky inside the shared grid cell
// set up in styles.css — see the "outline rail" comment there), so this
// component never measures or tracks its own placement; the only DOM
// measurement it does is figuring out which heading is "active", with one
// hit test at the reading line per frame.

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
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

// `end` turns the flash INLINE: the node at `pos` is the whole block, and a
// reveal inside a long one marks the matched lines instead.
type HeadingFlashMeta =
  | { kind: "show"; pos: number; end?: number; token: number }
  | { kind: "clear"; token: number };

const headingFlashPluginKey = new PluginKey<HeadingFlashState>(
  "dohc-heading-target-flash",
);

/** The flashed range's class, which is also how a caller finds the element it
 *  drew: an inline flash renders spans ProseMirror owns, and nothing else in
 *  the editor DOM can be addressed by position. */
export const FLASH_CLASS = "dohc-outline-target-flash";

/** The whole block, or the range inside it the caller named. */
function flashDecoration(
  doc: ProseMirrorNode,
  meta: { pos: number; end?: number },
): Decoration | null {
  if (meta.end !== undefined) {
    return Decoration.inline(meta.pos, meta.end, { class: FLASH_CLASS });
  }
  const node = doc.nodeAt(meta.pos);
  if (!node) return null;
  return Decoration.node(meta.pos, meta.pos + node.nodeSize, { class: FLASH_CLASS });
}

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
          const decoration = flashDecoration(transaction.doc, meta);
          if (!decoration) return { token: null, decorations: DecorationSet.empty };
          return {
            token: meta.token,
            decorations: DecorationSet.create(transaction.doc, [decoration]),
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

/** The index of the heading whose section holds the reading line, `line` in
 *  viewport coordinates: the last heading at or before the position under
 *  it. Above the editor that is the first heading and below it the last.
 *  Null when the line resolves to no position. */
function headingIndexAtReadingLine(
  view: EditorView,
  headings: readonly OutlineHeading[],
  line: number,
): number | null {
  const box = view.dom.getBoundingClientRect();
  let pos: number | null = null;
  if (line < box.top) pos = 0;
  else if (line >= box.bottom) pos = view.state.doc.content.size;
  else {
    try {
      pos = view.posAtCoords({ left: box.left + box.width / 2, top: line })?.pos ?? null;
    } catch {
      // A point in DOM that is mid-change can fail to resolve; the next
      // signal tries again.
    }
  }
  if (pos === null) return null;
  const headingBox = (heading: OutlineHeading) => {
    const element = view.nodeDOM(heading.pos);
    return element instanceof HTMLElement ? element.getBoundingClientRect() : null;
  };
  let index = resolveActiveHeadingIndex(headings, pos);
  // A hit in the margin above a heading can resolve to its start, and a hit
  // in a table cell can follow headings lower in an earlier cell. A heading
  // is reached only once it is drawn and its top crosses the line.
  const reached = (heading: OutlineHeading) => {
    const box = headingBox(heading);
    return !!box && box.height > 0 && box.top <= line;
  };
  while (index > 0 && !reached(headings[index]!)) index -= 1;
  // Headings side by side, as in a table row, follow the hit in document
  // order on the same line: the last drawn one the line has reached is
  // active. A heading in folded content draws no box and is passed over.
  for (let next = index + 1; next < headings.length; next += 1) {
    const box = headingBox(headings[next]!);
    if (!box || box.top > line) break;
    if (box.height > 0) index = next;
  }
  return index;
}

/** The same headings with the same text and levels draw the same outline,
 *  wherever an edit moved them. */
function sameOutline(
  a: readonly OutlineHeading[],
  b: readonly OutlineHeading[],
): boolean {
  return a.length === b.length && a.every((heading, index) => {
    const other = b[index]!;
    return heading.level === other.level && heading.text === other.text;
  });
}

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (/(auto|scroll)/.test(overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}

/** Reveal a navigation target: flash it, scroll it into view, and — when
 *  `moveCursorTo` is given and the editor is editable — put the cursor there.
 *  A number flashes the NODE at that position; a range flashes the text
 *  inside it, which is how a reveal lands inside a long block.
 *  `resolveElement` runs after the flash dispatch, because selection-driven
 *  decorations can replace the rendered node and resolving the DOM first
 *  would scroll a detached element — and because an inline flash IS the
 *  element its caller scrolls.
 *
 *  Returns a cleanup that clears the flash early, or undefined when nothing
 *  was revealed — a caller that must not lose the jump retries on that. */
export function revealDocPosition(
  editor: Editor,
  pos: number | { from: number; to: number },
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
        ...(typeof pos === "number" ? { pos } : { pos: pos.from, end: pos.to }),
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
 * Deliberately not consumable, unlike `BlockNavigationTarget`: a
 * remount re-applies it, so a version switch returns the reader to their
 * heading rather than to the top of the document. */
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

type OutlinePanelProps = {
  editor: Editor | null;
  /** The `.dohc-tiptap-editor` container — used only to find the
   *  scrollable ancestor for active-heading tracking. */
  containerRef: RefObject<HTMLDivElement | null>;
  headingTarget?: HeadingNavigationTarget;
};

export function OutlinePanel({ editor, containerRef, headingTarget }: OutlinePanelProps) {
  // The drawn list: it changes only when a heading's text or level does.
  const [headings, setHeadings] = useState<OutlineHeading[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wordCount = useDebouncedWordCount(editor);

  // The current headings with their positions, which every edit before a
  // heading moves. The scroll-tracking effect and clicks read them here, so
  // typing redraws nothing.
  const outlineRef = useRef<OutlineHeading[]>(headings);
  // The active heading is kept by position, so an edit maps it to where its
  // heading went; the list draws it by index.
  const activePosRef = useRef<number | null>(null);
  const activeIndexRef = useRef(-1);
  const setActivePos = (next: number | null) => {
    activePosRef.current = next;
    const current = outlineRef.current;
    const index = next === null ? -1 : resolveActiveHeadingIndex(current, next);
    const shown = index >= 0 && current[index]!.pos === next ? index : -1;
    if (activeIndexRef.current === shown) return;
    activeIndexRef.current = shown;
    setActiveIndex(shown);
  };

  // Recompute the heading list synchronously (a walk over blocks, not text)
  // on every doc change, and redraw only when it changed. The word count is
  // handled by useDebouncedWordCount above.
  useEffect(() => {
    setActivePos(null);
    if (!editor) {
      outlineRef.current = [];
      setHeadings([]);
      return;
    }
    const recomputeHeadings = () => {
      const next = extractOutline(editor.state.doc);
      const redraw = !sameOutline(next, outlineRef.current);
      outlineRef.current = next;
      if (redraw) setHeadings(next);
    };
    const handleTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      recomputeHeadings();
      const previousActivePos = activePosRef.current;
      if (previousActivePos !== null) {
        setActivePos(transaction.mapping.map(previousActivePos));
      }
    };

    recomputeHeadings();

    // Tiptap suppresses `update` for setContent(..., { emitUpdate: false }) but
    // still emits `transaction`; docChanged is the complete document boundary.
    editor.on("transaction", handleTransaction);
    return () => {
      editor.off("transaction", handleTransaction);
    };
  }, [editor]);

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

  // The active heading is the last one at or before the document position
  // under the reading line. One hit test and a read of the headings beside
  // the hit find it each frame, so the cost does not grow with the note's
  // length. Every signal that can move content under that line schedules
  // one frame.
  useEffect(() => {
    if (!editor) return;
    const scrollEl = findScrollParent(containerRef.current);
    if (!scrollEl) return;

    let frame = 0;
    const updateActiveHeading = () => {
      frame = 0;
      const current = outlineRef.current;
      const index = headingIndexAtReadingLine(
        editor.view,
        current,
        scrollEl.getBoundingClientRect().top + ACTIVE_HEADING_READING_OFFSET,
      );
      if (index !== null) setActivePos(current[index]?.pos ?? null);
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(updateActiveHeading);
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);
    const observedElements = new Set<HTMLElement>();
    const refreshResizeTargets = () => {
      const nextElements = new Set<HTMLElement>([
        scrollEl,
        editor.view.dom,
        ...(containerRef.current ? [containerRef.current] : []),
        ...Array.from(scrollEl.children).filter(
          (element): element is HTMLElement => element instanceof HTMLElement,
        ),
      ]);
      for (const element of observedElements) {
        if (nextElements.has(element)) continue;
        resizeObserver?.unobserve(element);
        observedElements.delete(element);
      }
      for (const element of nextElements) {
        if (observedElements.has(element)) continue;
        resizeObserver?.observe(element);
        observedElements.add(element);
      }
    };
    refreshResizeTargets();

    // Async math/Mermaid rendering and direct table-resize writes do not
    // necessarily dispatch a document update. Observe only DOM changes that
    // can affect layout; ResizeObserver supplies the settled height signal.
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            if (records.some((record) =>
              record.type === "childList" && record.target === scrollEl
            )) {
              refreshResizeTargets();
            }
            scheduleUpdate();
          });
    mutationObserver?.observe(editor.view.dom, {
      attributes: true,
      attributeFilter: ["class", "hidden", "open", "style"],
      childList: true,
      subtree: true,
    });
    // The pane can be kept mounted under `hidden`, and top matter can be
    // inserted before the editor without touching the ProseMirror document.
    // Direct children are re-snapshotted below so later pane siblings also
    // receive ResizeObserver coverage.
    mutationObserver?.observe(scrollEl, {
      attributes: true,
      attributeFilter: ["hidden"],
      childList: true,
    });

    const fonts = document.fonts;
    fonts?.addEventListener("loadingdone", scheduleUpdate);
    fonts?.addEventListener("loadingerror", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    scrollEl.addEventListener("load", scheduleUpdate, true);
    scrollEl.addEventListener("error", scheduleUpdate, true);
    editor.on("update", scheduleUpdate);
    const handleDocumentTransaction = (
      { transaction }: { transaction: { docChanged: boolean } },
    ) => {
      if (transaction.docChanged) scheduleUpdate();
    };
    editor.on("transaction", handleDocumentTransaction);
    scrollEl.addEventListener("scroll", scheduleUpdate, { passive: true });

    let resolutionQuery: MediaQueryList | null = null;
    const handleResolutionChange = () => {
      resolutionQuery?.removeEventListener("change", handleResolutionChange);
      scheduleUpdate();
      resolutionQuery = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`,
      );
      resolutionQuery.addEventListener("change", handleResolutionChange);
    };
    if (typeof window.matchMedia === "function") {
      resolutionQuery = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`,
      );
      resolutionQuery.addEventListener("change", handleResolutionChange);
    }

    scheduleUpdate();
    return () => {
      scrollEl.removeEventListener("scroll", scheduleUpdate);
      editor.off("transaction", handleDocumentTransaction);
      editor.off("update", scheduleUpdate);
      scrollEl.removeEventListener("load", scheduleUpdate, true);
      scrollEl.removeEventListener("error", scheduleUpdate, true);
      window.removeEventListener("resize", scheduleUpdate);
      fonts?.removeEventListener("loadingdone", scheduleUpdate);
      fonts?.removeEventListener("loadingerror", scheduleUpdate);
      resolutionQuery?.removeEventListener("change", handleResolutionChange);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, containerRef]);

  if (!editor || headings.length < 2) return null;

  return (
    <nav className="dohc-outline" aria-label="Document outline">
      <div className="dohc-outline-rail" aria-hidden="true">
        {headings.map((h, index) => (
          <span
            key={index}
            className={`dohc-outline-rail-mark dohc-outline-rail-mark--level-${h.level}${
              index === activeIndex ? " is-active" : ""
            }`}
          />
        ))}
      </div>
      <div className="dohc-outline-panel dohc-popover">
        <ul className="dohc-outline-list">
          {headings.map((h, index) => (
            <li key={index}>
              <button
                type="button"
                className={`dohc-focus-row dohc-outline-item dohc-outline-item--level-${h.level}${
                  index === activeIndex ? " is-active" : ""
                }`}
                aria-current={index === activeIndex ? "true" : undefined}
                onClick={() => {
                  const heading = outlineRef.current[index];
                  if (heading) scrollToHeading(editor, heading);
                }}
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
