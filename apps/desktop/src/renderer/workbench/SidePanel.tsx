import { useRef } from "react";
import { SectionLabel } from "../ui/controls";
import {
  clampSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./workbenchState";
import { useCommitOnRelease } from "./useCommitOnRelease";

const KEYBOARD_RESIZE_STEP = 16;

// The workbench's collapsible, resizable side panel. The host unmounts it
// entirely when hidden (windowChrome pins file-tree toHaveCount(0) on
// toggle-sidebar). Pointer movement stays local to this panel; releasing the
// drag commits the final width to durable workbench state.
export function SidePanel(props: {
  title: string;
  width: number;
  actions?: React.ReactNode;
  onWidthChange: (width: number) => void;
  children: React.ReactNode;
}) {
  const asideRef = useRef<HTMLElement>(null);
  // The panel's left edge at drag start — widths derive from clientX against
  // it, so the math holds even if the activity bar ever changes width.
  const dragLeft = useRef<number | null>(null);
  const resize = useCommitOnRelease(props.onWidthChange);
  const width = resize.previewValue ?? props.width;

  return (
    <aside
      ref={asideRef}
      data-testid="side-panel"
      className="relative flex shrink-0 flex-col border-r border-line bg-panel-2"
      style={{ width }}
    >
      {/* h-9: ONE header band height across panel, tab strip, and history
          rail — all three bottom hairlines land on the same pixel row. */}
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <SectionLabel>{props.title}</SectionLabel>
        <span className="ml-auto flex items-center gap-0.5">{props.actions}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
      <div
        data-testid="sidebar-resize"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        onKeyDown={(event) => {
          const direction =
            event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
          if (direction === 0) return;
          event.preventDefault();
          props.onWidthChange(clampSidebarWidth(width + direction * KEYBOARD_RESIZE_STEP));
        }}
        onPointerDown={(event) => {
          // Left button only — a right/middle press must never start a resize.
          if (event.button !== 0) return;
          dragLeft.current = asideRef.current?.getBoundingClientRect().left ?? 0;
          resize.begin(event.pointerId, width);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragLeft.current === null || !resize.isActive(event.pointerId)) return;
          resize.update(
            event.pointerId,
            clampSidebarWidth(event.clientX - dragLeft.current),
            event.buttons,
          );
        }}
        onPointerUp={(event) => resize.commit(event.pointerId)}
        onPointerCancel={(event) => resize.commit(event.pointerId)}
        onLostPointerCapture={(event) => resize.commit(event.pointerId)}
        className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize bg-transparent transition-colors hover:bg-line/80 focus-visible:bg-accent/35"
      />
    </aside>
  );
}
