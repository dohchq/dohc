import { useRef } from "react";
import { clampSidebarWidth } from "./workbenchState";

// The workbench's collapsible, resizable side panel. The host unmounts it
// entirely when hidden (windowChrome pins file-tree toHaveCount(0) on
// toggle-sidebar). Width is workbench state: the drag handle streams clamped
// widths up via pointer capture (no dependencies) and the shell's debounced
// ui-state writer persists the final value.
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

  return (
    <aside
      ref={asideRef}
      data-testid="side-panel"
      className="relative flex shrink-0 flex-col border-r border-line bg-panel-2"
      style={{ width: props.width }}
    >
      {/* h-9: ONE header band height across panel, tab strip, and history
          rail — all three bottom hairlines land on the same pixel row. */}
      <header className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {props.title}
        </span>
        <span className="ml-auto flex items-center gap-0.5">{props.actions}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
      <div
        data-testid="sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(event) => {
          dragLeft.current = asideRef.current?.getBoundingClientRect().left ?? 0;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (dragLeft.current === null) return;
          props.onWidthChange(clampSidebarWidth(event.clientX - dragLeft.current));
        }}
        onPointerUp={() => {
          dragLeft.current = null;
        }}
        onPointerCancel={() => {
          dragLeft.current = null;
        }}
        className="absolute -right-0.5 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-line"
      />
    </aside>
  );
}
