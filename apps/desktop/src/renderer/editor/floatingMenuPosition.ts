export type FloatingMenuPlacement = "above" | "below";

export type FloatingMenuPosition = {
  x: number;
  y: number;
  maxHeight: number;
  placement: FloatingMenuPlacement;
  // CSS `bottom` offset for "above" placement. `y` assumes the menu fills
  // maxHeight, so a top-anchored menu whose content is SHORTER than maxHeight
  // hangs detached above the cursor and leaps up/down as filtering changes its
  // height. Anchoring the bottom edge here keeps it glued to the cursor while
  // content grows upward. Undefined for "below" (top-anchored at the cursor).
  bottom?: number;
};

export type FloatingMenuPositionInput = {
  cursorRect: { left: number; top: number; bottom: number };
  viewportWidth?: number;
  viewportHeight?: number;
  menuWidth?: number;
  menuMaxHeight?: number;
  margin?: number;
  gap?: number;
};

const FLOATING_MENU_VIEWPORT_MARGIN = 12;
const FLOATING_MENU_CURSOR_GAP = 6;
const FLOATING_MENU_WIDTH = 320;
export const FLOATING_MENU_MAX_HEIGHT = 320;

export function resolveFloatingMenuPosition({
  cursorRect,
  viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth,
  viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight,
  menuWidth = FLOATING_MENU_WIDTH,
  menuMaxHeight = FLOATING_MENU_MAX_HEIGHT,
  margin = FLOATING_MENU_VIEWPORT_MARGIN,
  gap = FLOATING_MENU_CURSOR_GAP,
}: FloatingMenuPositionInput): FloatingMenuPosition {
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
  const x = Math.min(Math.max(cursorRect.left, margin), maxLeft);
  const availableBelow = Math.max(
    0,
    viewportHeight - cursorRect.bottom - gap - margin,
  );
  const availableAbove = Math.max(0, cursorRect.top - gap - margin);
  const belowHeight = Math.min(menuMaxHeight, availableBelow);
  const aboveHeight = Math.min(menuMaxHeight, availableAbove);
  const placement =
    belowHeight >= menuMaxHeight || belowHeight >= aboveHeight ? "below" : "above";
  const maxHeight = placement === "above" ? aboveHeight : belowHeight;
  const y =
    placement === "above"
      ? Math.max(margin, cursorRect.top - gap - maxHeight)
      : Math.min(cursorRect.bottom + gap, viewportHeight - margin);

  if (placement === "above") {
    // Same box as `y`+maxHeight describes, expressed from the viewport's
    // bottom edge so the menu's bottom stays pinned when content is shorter.
    return { x, y, maxHeight, placement, bottom: viewportHeight - (y + maxHeight) };
  }
  return { x, y, maxHeight, placement };
}
