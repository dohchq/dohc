import { desktopPins } from "../../testPins";
import { useRef, type ReactNode } from "react";
import { useFocusReturn } from "../ui/focusReturn";
import { useCommitOnRelease } from "./useCommitOnRelease";
import {
  ABOUT_MAX_WIDTH,
  ABOUT_MIN_WIDTH,
  clampAboutWidth,
} from "./workbenchState";

const ABOUT_KEYBOARD_RESIZE_STEP = 16;
const ABOUT_KEYBOARD_RESIZE_PAGE_STEP = ABOUT_KEYBOARD_RESIZE_STEP * 8;

// The right-hand About rail — dohc's secondary sidebar (VS Code grammar:
// toggleable, resizable, persistent width, gone entirely while hidden). Its
// content draws its own header, the open object's name, so the rail has none.
export function AboutRail(props: {
  width: number;
  onWidthChange: (width: number) => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLElement>(null);
  useFocusReturn(true, panelRef);
  const dragRight = useRef<number | null>(null);
  const resize = useCommitOnRelease(props.onWidthChange);
  const width = resize.previewValue ?? props.width;

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      data-focus-surface="panel"
      data-testid={desktopPins.aboutRail}
      aria-label="About"
      className="relative flex shrink-0 flex-col border-l border-line bg-panel"
      style={{ width }}
    >
      <div
        data-testid="about-rail-resize"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize About"
        aria-valuemin={ABOUT_MIN_WIDTH}
        aria-valuemax={ABOUT_MAX_WIDTH}
        aria-valuenow={width}
        onKeyDown={(event) => {
          const nextWidth =
            event.key === "Home"
              ? ABOUT_MIN_WIDTH
              : event.key === "End"
                ? ABOUT_MAX_WIDTH
                : event.key === "PageUp"
                  ? clampAboutWidth(width + ABOUT_KEYBOARD_RESIZE_PAGE_STEP)
                  : event.key === "PageDown"
                    ? clampAboutWidth(width - ABOUT_KEYBOARD_RESIZE_PAGE_STEP)
                    : event.key === "ArrowLeft"
                      ? clampAboutWidth(width + ABOUT_KEYBOARD_RESIZE_STEP)
                      : event.key === "ArrowRight"
                        ? clampAboutWidth(width - ABOUT_KEYBOARD_RESIZE_STEP)
                        : null;
          if (nextWidth === null) return;
          event.preventDefault();
          props.onWidthChange(nextWidth);
        }}
        onPointerDown={(event) => {
          // Left button only — a right/middle press must never start a resize.
          if (event.button !== 0) return;
          dragRight.current =
            panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
          resize.begin(event.pointerId, width);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragRight.current === null || !resize.isActive(event.pointerId)) return;
          resize.update(
            event.pointerId,
            clampAboutWidth(dragRight.current - event.clientX),
            event.buttons,
          );
        }}
        onPointerUp={(event) => resize.commit(event.pointerId)}
        onPointerCancel={(event) => resize.commit(event.pointerId)}
        onLostPointerCapture={(event) => resize.commit(event.pointerId)}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize bg-transparent transition-colors hover:bg-line/80 keyboard:focus-visible:bg-accent/35"
      />
      {props.children}
    </aside>
  );
}
