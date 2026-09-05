// Notion-style outline rail: a slim column of dash marks pinned to the
// editor's right margin once the doc has ≥ 2 headings. Hovering (or
// keyboard-focusing, via :focus-within) expands it into a floating panel
// listing every heading; clicking one scrolls the editor there. The active
// section — the topmost heading currently in view — is emphasized in both.
//
// Positioning is CSS-only (position: sticky inside the shared grid cell
// set up in styles.css — see the "outline rail" comment there), so this
// component never measures or tracks its own placement; the only DOM
// measurement it does is figuring out which heading is "active". During
// layout churn it measures directly; after layout settles it searches cached
// offsets and remeasures them once when a new scroll gesture starts.

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
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
export const OUTLINE_GEOMETRY_HOT_MS = 250;

type OutlineSnapshot = {
  generation: number;
  headings: OutlineHeading[];
};

type HeadingGeometry = {
  generation: number;
  values: number[];
};

type HeadingFlashState = {
  token: number | null;
  decorations: DecorationSet;
};

// `end` turns the flash INLINE: the node at `pos` is the whole block, and a
// reveal inside a long one (#688) marks the matched lines instead.
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
 *  inside it, which is how a reveal lands inside a long block (#688).
 *  `resolveElement` runs AFTER the flash dispatch, because selection-driven
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
 * Deliberately not consumable, unlike `BlockNavigationTarget` (#680, #685): a
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
  const [outline, setOutline] = useState<OutlineSnapshot>({
    generation: 0,
    headings: [],
  });
  const [activePos, setActivePos] = useState<number | null>(null);
  const wordCount = useDebouncedWordCount(editor);

  // The scroll-tracking effect attaches once per editor and reads current
  // headings through this ref. Document transactions replace the snapshot
  // without tearing down the listener.
  const outlineRef = useRef<OutlineSnapshot>(outline);
  const activePosRef = useRef<number | null>(activePos);
  const setActivePosIfChanged = (next: number | null) => {
    if (activePosRef.current === next) return;
    activePosRef.current = next;
    setActivePos(next);
  };

  // Recompute the heading list synchronously (cheap: a handful of nodes) on
  // every doc change. The word count is handled by useDebouncedWordCount above.
  useEffect(() => {
    setActivePosIfChanged(null);
    if (!editor) {
      const empty = {
        generation: outlineRef.current.generation + 1,
        headings: [],
      };
      outlineRef.current = empty;
      setOutline(empty);
      return;
    }
    const recomputeHeadings = () => {
      const next = {
        generation: outlineRef.current.generation + 1,
        headings: extractOutline(editor.state.doc),
      };
      outlineRef.current = next;
      setOutline(next);
    };
    const handleTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      const previousActivePos = activePosRef.current;
      if (previousActivePos !== null) {
        setActivePosIfChanged(transaction.mapping.map(previousActivePos));
      }
      recomputeHeadings();
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

  // Cache contract: active geometry is pixel-correct within one frame of any
  // observable signal and from the first frame of every scroll gesture.
  // Non-first steady-state frames perform zero layout reads. An unobservable
  // shift mid-gesture can remain stale until the next gesture; this accepted
  // staleness is bounded by the gesture's length.
  useEffect(() => {
    if (!editor) return;
    const scrollEl = findScrollParent(containerRef.current);
    if (!scrollEl) return;

    let frame = 0;
    let settleTimer = 0;
    let lastGeometrySignalAt = Number.NEGATIVE_INFINITY;
    let lastScrollAt = Number.NEGATIVE_INFINITY;
    let remeasurePending = false;
    let headingTops: HeadingGeometry | null = null;
    const measureHeadingTops = (snapshot: OutlineSnapshot): HeadingGeometry => {
      const containerTop = scrollEl.getBoundingClientRect().top;
      const measuredTops: number[] = [];
      let previousTop = Number.NEGATIVE_INFINITY;
      for (const heading of snapshot.headings) {
        let measuredTop = Number.POSITIVE_INFINITY;
        try {
          measuredTop =
            editor.view.coordsAtPos(heading.pos).top
            - containerTop
            + scrollEl.scrollTop;
        } catch {
          // An unresolved position and everything after its first gap remain
          // unreached until the next measurement can resolve them.
        }
        // Hidden descendants can share an ancestor's coordinates. Keeping the
        // search values nondecreasing preserves the old full scan's first-gap
        // behavior and makes binary search safe.
        previousTop = Number.isFinite(measuredTop)
          ? Math.max(previousTop, measuredTop)
          : Number.POSITIVE_INFINITY;
        measuredTops.push(previousTop);
      }
      return {
        generation: snapshot.generation,
        values: measuredTops,
      };
    };
    const resolveActiveHeading = (
      snapshot: OutlineSnapshot,
      geometry: HeadingGeometry,
    ) => {
      const activeIndex = resolveActiveHeadingIndex(
        geometry.values,
        scrollEl.scrollTop,
        ACTIVE_HEADING_READING_OFFSET,
      );
      const heading = snapshot.headings[activeIndex];
      setActivePosIfChanged(heading?.pos ?? null);
    };
    const geometryIsHot = (time: number) =>
      time - lastGeometrySignalAt < OUTLINE_GEOMETRY_HOT_MS;
    const updateActiveHeading = (time: number) => {
      frame = 0;
      const snapshot = outlineRef.current;
      if (geometryIsHot(time)) {
        resolveActiveHeading(snapshot, measureHeadingTops(snapshot));
        return;
      }

      if (
        remeasurePending
        || headingTops?.generation !== snapshot.generation
      ) {
        remeasurePending = false;
        if (settleTimer) {
          window.clearTimeout(settleTimer);
          settleTimer = 0;
        }
        headingTops = measureHeadingTops(snapshot);
      }

      resolveActiveHeading(snapshot, headingTops);
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(updateActiveHeading);
    };
    const scheduleSettledRecompute = () => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = 0;
        scheduleUpdate();
      }, OUTLINE_GEOMETRY_HOT_MS);
    };
    const markGeometryHot = () => {
      lastGeometrySignalAt = performance.now();
      remeasurePending = true;
      scheduleUpdate();
      scheduleSettledRecompute();
    };
    const handleScroll = () => {
      const time = performance.now();
      if (time - lastScrollAt > OUTLINE_GEOMETRY_HOT_MS) {
        remeasurePending = true;
      }
      lastScrollAt = time;
      scheduleUpdate();
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(markGeometryHot);
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
            markGeometryHot();
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
    fonts?.addEventListener("loadingdone", markGeometryHot);
    fonts?.addEventListener("loadingerror", markGeometryHot);
    window.addEventListener("resize", markGeometryHot);
    scrollEl.addEventListener("load", markGeometryHot, true);
    scrollEl.addEventListener("error", markGeometryHot, true);
    editor.on("update", markGeometryHot);
    const handleDocumentTransaction = (
      { transaction }: { transaction: { docChanged: boolean } },
    ) => {
      if (transaction.docChanged) markGeometryHot();
    };
    editor.on("transaction", handleDocumentTransaction);
    scrollEl.addEventListener("scroll", handleScroll, { passive: true });

    let resolutionQuery: MediaQueryList | null = null;
    const handleResolutionChange = () => {
      resolutionQuery?.removeEventListener("change", handleResolutionChange);
      markGeometryHot();
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
      scrollEl.removeEventListener("scroll", handleScroll);
      editor.off("transaction", handleDocumentTransaction);
      editor.off("update", markGeometryHot);
      scrollEl.removeEventListener("load", markGeometryHot, true);
      scrollEl.removeEventListener("error", markGeometryHot, true);
      window.removeEventListener("resize", markGeometryHot);
      fonts?.removeEventListener("loadingdone", markGeometryHot);
      fonts?.removeEventListener("loadingerror", markGeometryHot);
      resolutionQuery?.removeEventListener("change", handleResolutionChange);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.clearTimeout(settleTimer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [editor, containerRef]);

  const headings = outline.headings;
  if (!editor || headings.length < 2) return null;

  return (
    <nav className="dohc-outline" aria-label="Document outline">
      <div className="dohc-outline-rail" aria-hidden="true">
        {headings.map((h) => (
          <span
            key={h.pos}
            className={`dohc-outline-rail-mark dohc-outline-rail-mark--level-${h.level}${
              h.pos === activePos ? " is-active" : ""
            }`}
          />
        ))}
      </div>
      <div className="dohc-outline-panel dohc-popover">
        <ul className="dohc-outline-list">
          {headings.map((h) => (
            <li key={h.pos}>
              <button
                type="button"
                className={`dohc-outline-item dohc-outline-item--level-${h.level}${
                  h.pos === activePos ? " is-active" : ""
                }`}
                aria-current={h.pos === activePos ? "true" : undefined}
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
