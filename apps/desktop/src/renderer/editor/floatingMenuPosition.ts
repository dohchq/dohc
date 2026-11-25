import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export type FloatingMenuPlacement = "above" | "below";

export type FloatingMenuBounds = { top: number; left: number; right: number; bottom: number };

export type FloatingMenuPosition = {
  x: number;
  y: number;
  maxHeight: number;
  placement: FloatingMenuPlacement;
  // CSS `bottom` offset for "above" placement. `y` assumes the menu fills
  // maxHeight, so a top-anchored menu whose content is shorter than maxHeight
  // hangs detached above the cursor and leaps up/down as filtering changes its
  // height. Anchoring the bottom edge here keeps it glued to the cursor while
  // content grows upward. Undefined for "below" (top-anchored at the cursor).
  bottom?: number;
};

type FloatingMenuPositionInput = {
  cursorRect: { left: number; top: number; bottom: number };
  viewportWidth?: number;
  viewportHeight?: number;
  bounds?: FloatingMenuBounds;
  menuWidth?: number;
  menuMaxHeight?: number;
  margin?: number;
  gap?: number;
  // The side to open on when it has room; the other side otherwise.
  prefer?: FloatingMenuPlacement;
};

const FLOATING_MENU_VIEWPORT_MARGIN = 12;
const FLOATING_MENU_CURSOR_GAP = 6;
const FLOATING_MENU_WIDTH = 320;
export const FLOATING_MENU_MAX_HEIGHT = 320;

export function resolveFloatingMenuPosition({
  cursorRect,
  viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth,
  viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight,
  bounds = { top: 0, left: 0, right: viewportWidth, bottom: viewportHeight },
  menuWidth = FLOATING_MENU_WIDTH,
  menuMaxHeight = FLOATING_MENU_MAX_HEIGHT,
  margin = FLOATING_MENU_VIEWPORT_MARGIN,
  gap = FLOATING_MENU_CURSOR_GAP,
  prefer = "below",
}: FloatingMenuPositionInput): FloatingMenuPosition {
  const minLeft = bounds.left + margin;
  const maxLeft = Math.max(minLeft, bounds.right - menuWidth - margin);
  const x = Math.min(Math.max(cursorRect.left, minLeft), maxLeft);
  const availableBelow = Math.max(0, bounds.bottom - cursorRect.bottom - gap - margin);
  const availableAbove = Math.max(0, cursorRect.top - bounds.top - gap - margin);
  const belowHeight = Math.min(menuMaxHeight, availableBelow);
  const aboveHeight = Math.min(menuMaxHeight, availableAbove);
  const placement =
    prefer === "above"
      ? aboveHeight >= menuMaxHeight || aboveHeight >= belowHeight
        ? "above"
        : "below"
      : belowHeight >= menuMaxHeight || belowHeight >= aboveHeight
        ? "below"
        : "above";
  const maxHeight = placement === "above" ? aboveHeight : belowHeight;
  const y =
    placement === "above"
      ? Math.max(bounds.top + margin, cursorRect.top - gap - maxHeight)
      : Math.min(cursorRect.bottom + gap, bounds.bottom - margin);

  if (placement === "above") {
    // Same box as `y`+maxHeight describes, expressed from the viewport's
    // bottom edge so the menu's bottom stays pinned when content is shorter.
    return { x, y, maxHeight, placement, bottom: viewportHeight - (y + maxHeight) };
  }
  return { x, y, maxHeight, placement };
}

export function floatingMenuBounds(node: Node): FloatingMenuBounds {
  const win = node.ownerDocument?.defaultView ?? window;
  const bounds = { top: 0, left: 0, right: win.innerWidth, bottom: win.innerHeight };
  const root = node.getRootNode();
  if (!(root instanceof ShadowRoot)) return bounds;
  const host = root.host.getBoundingClientRect();
  return {
    top: Math.max(bounds.top, host.top),
    left: Math.max(bounds.left, host.left),
    right: Math.min(bounds.right, host.right),
    bottom: Math.min(bounds.bottom, host.bottom),
  };
}

export function onScrollOutside(menu: Element, listener: () => void): () => void {
  const onScroll = (event: Event) => {
    if (event.target instanceof Node && menu.contains(event.target)) return;
    listener();
  };
  const roots = new Set<Document | ShadowRoot>([menu.ownerDocument]);
  const root = menu.getRootNode();
  // A scroll inside a shadow root doesn't reach the document.
  if (root instanceof ShadowRoot) roots.add(root);
  for (const target of roots) target.addEventListener("scroll", onScroll, true);
  return () => {
    for (const target of roots) target.removeEventListener("scroll", onScroll, true);
  };
}

type AnchorPoint = { left: number; top: number };

type Placement = { at: AnchorPoint | null; doc: ProseMirrorNode; selection: Selection };

function place(view: EditorView, from: number): Placement {
  let at: AnchorPoint | null = null;
  try {
    at = view.coordsAtPos(from);
  } catch {
    // coordsAtPos throws when the editor has no layout.
  }
  return { at, doc: view.state.doc, selection: view.state.selection };
}

export function useCloseOnScrollAway(
  menuRef: RefObject<HTMLElement | null>,
  view: EditorView | null,
  from: number | null,
  onClose: () => void,
): void {
  const latest = useRef({ view, from, onClose });
  const placed = useRef<Placement | null>(null);
  useLayoutEffect(() => {
    latest.current = { view, from, onClose };
    placed.current = view && from !== null ? place(view, from) : null;
  });
  const open = view !== null && from !== null;
  useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    let closed = false;
    return onScrollOutside(menu, () => {
      const { view: editor, from: pos, onClose: close } = latest.current;
      const was = placed.current;
      if (closed || !editor || pos === null || !was) return;
      const now = place(editor, pos);
      // ProseMirror's scroll to the caret can arrive before the menu follows an edit.
      if (now.at && was.at) {
        if (Math.abs(now.at.left - was.at.left) < 1 && Math.abs(now.at.top - was.at.top) < 1)
          return;
        if (now.doc !== was.doc || !now.selection.eq(was.selection)) {
          placed.current = now;
          return;
        }
      }
      closed = true;
      close();
    });
  }, [open, menuRef]);
}
