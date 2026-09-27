import { PanelRight } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { useFocusReturn } from "../ui/focusReturn";
import { useCommitOnRelease } from "./useCommitOnRelease";
import {
  CHATS_MAX_WIDTH,
  CHATS_MIN_WIDTH,
  clampChatsWidth,
} from "./workbenchState";

// Which surface the right-hand Chats panel shows: every workspace chat
// (channels, DMs, file threads) or the active file's chats. Runtime-only.
export type ChatsPanelTab = "all" | "file";

const CHATS_PANEL_TAB_LABELS: Record<ChatsPanelTab, string> = {
  all: "Chats",
  file: "This file",
};
const CHATS_KEYBOARD_RESIZE_STEP = 16;
const CHATS_KEYBOARD_RESIZE_PAGE_STEP = CHATS_KEYBOARD_RESIZE_STEP * 8;
// Every workspace this machine owns offers both. A shared view offers the
// file tab only: it has no workspace-wide chat listing, by design.

// The right-hand Chats panel — dohc's secondary sidebar (VS Code grammar:
// toggleable, resizable, persistent width, gone entirely while hidden).
export function ChatsPanel(props: {
  width: number;
  onWidthChange: (width: number) => void;
  onCollapse: () => void;
  tabs: readonly ChatsPanelTab[];
  tab: ChatsPanelTab;
  onTabChange: (tab: ChatsPanelTab) => void;
  actions?: ReactNode;
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
      data-testid="chats-panel"
      aria-label="Chats"
      className="relative flex shrink-0 flex-col border-l border-line bg-panel-2"
      style={{ width }}
    >
      <div
        data-testid="chats-panel-resize"
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize chats"
        aria-valuemin={CHATS_MIN_WIDTH}
        aria-valuemax={CHATS_MAX_WIDTH}
        aria-valuenow={width}
        onKeyDown={(event) => {
          const nextWidth =
            event.key === "Home"
              ? CHATS_MIN_WIDTH
              : event.key === "End"
                ? CHATS_MAX_WIDTH
                : event.key === "PageUp"
                  ? clampChatsWidth(width + CHATS_KEYBOARD_RESIZE_PAGE_STEP)
                  : event.key === "PageDown"
                    ? clampChatsWidth(width - CHATS_KEYBOARD_RESIZE_PAGE_STEP)
                    : event.key === "ArrowLeft"
                      ? clampChatsWidth(width + CHATS_KEYBOARD_RESIZE_STEP)
                      : event.key === "ArrowRight"
                        ? clampChatsWidth(width - CHATS_KEYBOARD_RESIZE_STEP)
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
            clampChatsWidth(dragRight.current - event.clientX),
            event.buttons,
          );
        }}
        onPointerUp={(event) => resize.commit(event.pointerId)}
        onPointerCancel={(event) => resize.commit(event.pointerId)}
        onLostPointerCapture={(event) => resize.commit(event.pointerId)}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize bg-transparent transition-colors hover:bg-line/80 focus-visible:bg-accent/35"
      />
      {/* Same header grammar + h-9 band as the side panel: the two
          peer chrome surfaces speak one language and their hairlines
          meet the tab strip's on the same pixel row. */}
      <header className="flex h-9 shrink-0 items-center border-b border-line px-3">
        <div className="flex items-center gap-0.5">
          {props.tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              data-testid={`chats-panel-tab-${tab}`}
              aria-pressed={props.tab === tab}
              onClick={() => props.onTabChange(tab)}
              className={`h-7 rounded-md px-3 text-[12px] font-medium transition-colors dohc-focus-visible ${
                props.tab === tab
                  ? "bg-line/60 text-ink"
                  : "text-muted hover:bg-line/40 hover:text-ink"
              }`}
            >
              {CHATS_PANEL_TAB_LABELS[tab]}
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-0.5">
          {props.actions}
          <button
            type="button"
            data-testid="chats-panel-collapse"
            aria-label="Hide chats"
            title="Hide chats"
            onClick={props.onCollapse}
            className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
          >
            <PanelRight size={13} aria-hidden />
          </button>
        </span>
      </header>
      {props.children}
    </aside>
  );
}

