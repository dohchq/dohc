import { ChevronDown, X } from "lucide-react";
import { memo, useRef, useState } from "react";
import { isGraphTabPath, isHistoryTabPath } from "./workbenchState";

function fileName(path: string): string {
  if (isGraphTabPath(path)) return "Graph";
  if (isHistoryTabPath(path)) return "History";
  return path.split("/").pop() ?? path;
}

function tabTitle(path: string): string {
  if (isGraphTabPath(path)) return "Workspace graph";
  if (isHistoryTabPath(path)) return "Workspace history";
  return path;
}

// Memoized so the dirty flips while typing (saveState ticks every autosave)
// re-render only the active tab, not the whole strip (FileRow precedent —
// typingLongTaskMs budget). All callbacks must be referentially stable.
const Tab = memo(function Tab(props: {
  path: string;
  active: boolean;
  dirty: boolean;
  dragging: boolean;
  dropBefore: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onContextMenu: (path: string) => void;
  onDragPreview: (path: string, toIndex: number) => void;
  onDragEnd: () => void;
  onMove: (path: string, toIndex: number) => void;
}) {
  const name = fileName(props.path);
  // Pointer-drag reorder (no dnd dep): a press only becomes a drag after 4px
  // of travel, so plain clicks never reorder. While captured, the tab lives
  // at "how many sibling midpoints sit left of the cursor" (live reorder,
  // VS Code-style); moveTab no-ops same-slot moves so the stream is cheap.
  const drag = useRef<{ pointerId: number; startX: number; active: boolean } | null>(
    null,
  );
  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={props.active}
      data-testid={`tab-${props.path}`}
      data-active={props.active || undefined}
      title={tabTitle(props.path)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onActivate(props.path);
        }
      }}
      // Middle-click closes (VS Code convention); auxclick is the only
      // reliable middle-button event.
      onAuxClick={(event) => {
        if (event.button === 1) props.onClose(props.path);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(props.path);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // Activate on PRESS (VS Code behavior) — click can't be relied on
        // after a drag: the live reorder re-inserts the DOM node, which
        // cancels both pointer capture and click synthesis in Chromium.
        if (!props.active) props.onActivate(props.path);
        drag.current = { pointerId: event.pointerId, startX: event.clientX, active: false };
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state || state.pointerId !== event.pointerId) return;
        // A mouse keeps one pointerId for life: if the release was missed
        // (capture lost mid-reorder), a buttons-up move must end the drag,
        // or plain hovering would keep reordering.
        if ((event.buttons & 1) === 0) {
          if (state.active) props.onDragEnd();
          drag.current = null;
          return;
        }
        if (!state.active) {
          if (Math.abs(event.clientX - state.startX) < 4) return;
          state.active = true;
        }
        // (Re-)capture each move: every reorder re-insertion drops capture.
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        const siblings = event.currentTarget.parentElement?.querySelectorAll('[role="tab"]');
        if (!siblings) return;
        let toIndex = 0;
        for (const sibling of siblings) {
          if (sibling === event.currentTarget) continue;
          const box = sibling.getBoundingClientRect();
          if (box.left + box.width / 2 < event.clientX) toIndex += 1;
        }
        props.onDragPreview(props.path, toIndex);
        props.onMove(props.path, toIndex);
      }}
      onPointerUp={() => {
        if (drag.current?.active) props.onDragEnd();
        drag.current = null;
      }}
      onPointerCancel={() => {
        if (drag.current?.active) props.onDragEnd();
        drag.current = null;
      }}
      // The strip's bottom hairline is drawn PER TAB so the active one can
      // break it: transparent bottom border + the editor's bg merge the tab
      // with its document (VS Code/Zed treatment) instead of severing it.
      className={`group relative flex h-9 shrink-0 select-none items-center gap-1.5 border-b border-r border-line px-3 text-[13px] transition-[background-color,box-shadow,color,transform] ${
        props.dragging
          ? "z-10 -translate-y-px cursor-grabbing border-b-transparent bg-bg text-ink shadow-md ring-1 ring-inset ring-ink/20"
          : `cursor-default ${
              props.active
                ? "border-b-transparent bg-bg text-ink"
                : "bg-panel-2 text-muted hover:bg-line/50 hover:text-ink"
            }`
      }`}
    >
      {props.dropBefore ? (
        <span
          data-testid="tab-drop-marker"
          aria-hidden
          className="absolute -left-px bottom-1.5 top-1.5 z-20 w-0.5 rounded-full bg-ink"
        />
      ) : null}
      {props.dirty ? (
        <span
          data-testid="tab-dirty"
          aria-label="Unsaved changes"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink"
        />
      ) : null}
      <span className="max-w-44 truncate">{name}</span>
      <button
        type="button"
        aria-label={`Close ${name}`}
        // Don't let a press on the close button arm the drag above.
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          props.onClose(props.path);
        }}
        className={`grid size-4 place-items-center rounded text-subtle hover:bg-line hover:text-ink ${
          props.active ? "" : "opacity-0 focus:opacity-100 group-hover:opacity-100"
        }`}
      >
        <X size={12} aria-hidden />
      </button>
    </div>
  );
});

// The tab strip above the editor area. Pure view over workbenchState's tabs:
// activation routes through the shell's single openFile() (which fires the
// file-open-start perf mark), closing through the same closeTab transition
// Ctrl+W and the menu use, reorder through the pure moveTab. `dirty` is
// runtime-only and known for the ACTIVE tab (the one mounted inspector
// reports its save state). h-9: ONE header band height with the side panel
// and history rail, so the three hairlines meet at the vertical seams.
export function EditorTabs(props: {
  tabs: Array<{ path: string }>;
  activeTab: string | null;
  activeTabDirty: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onContextMenu: (path: string) => void;
  onMove: (path: string, toIndex: number) => void;
}) {
  const [listOpen, setListOpen] = useState(false);
  const [dragPreview, setDragPreview] = useState<{
    path: string;
    toIndex: number;
  } | null>(null);
  if (props.tabs.length === 0) return null;
  return (
    <div data-testid="editor-tabs" className="relative flex h-9 shrink-0 bg-panel-2">
      <div
        role="tablist"
        aria-label="Open files"
        className="flex min-w-0 flex-1 overflow-x-auto"
      >
        {props.tabs.map((tab) => (
          <Tab
            key={tab.path}
            path={tab.path}
            active={tab.path === props.activeTab}
            dirty={tab.path === props.activeTab && props.activeTabDirty}
            dragging={dragPreview?.path === tab.path}
            dropBefore={
              dragPreview !== null &&
              props.tabs[dragPreview.toIndex]?.path === tab.path
            }
            onActivate={props.onActivate}
            onClose={props.onClose}
            onContextMenu={props.onContextMenu}
            onDragPreview={(path, toIndex) => setDragPreview({ path, toIndex })}
            onDragEnd={() => setDragPreview(null)}
            onMove={props.onMove}
          />
        ))}
        {/* Continues the hairline across the empty strip — only the active
            tab interrupts it. */}
        <div aria-hidden className="min-w-4 flex-1 border-b border-line" />
      </div>
      {/* Overflow affordance: every open tab, reachable even when the strip
          scrolls. Lives OUTSIDE the scroller so the menu is never clipped. */}
      <button
        type="button"
        data-testid="tabs-overflow"
        aria-label="All open tabs"
        title="All open tabs"
        aria-expanded={listOpen}
        onClick={() => setListOpen((open) => !open)}
        className="grid w-7 shrink-0 place-items-center border-b border-line text-subtle hover:text-ink"
      >
        <ChevronDown size={14} aria-hidden />
      </button>
      {listOpen ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setListOpen(false)} />
          <div
            data-testid="tabs-overflow-menu"
            role="menu"
            aria-label="Open tabs"
            className="absolute right-1 top-full z-20 mt-1 max-h-72 w-60 overflow-y-auto rounded-md border border-line bg-panel py-1 shadow-sm"
          >
            {props.tabs.map((tab) => (
              <button
                key={tab.path}
                type="button"
                role="menuitem"
                title={tab.path}
                onClick={() => {
                  setListOpen(false);
                  props.onActivate(tab.path);
                }}
                className={`flex h-7 w-full items-center px-3 text-left text-[13px] ${
                  tab.path === props.activeTab
                    ? "text-ink"
                    : "text-muted hover:bg-line/50 hover:text-ink"
                }`}
              >
                <span className="truncate">{fileName(tab.path)}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
