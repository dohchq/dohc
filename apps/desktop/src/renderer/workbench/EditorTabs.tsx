import { ChevronDown, Columns2, X } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../reducedMotion";
import {
  isChatsTabPath,
  isGraphTabPath,
  isHistoryDiffTabPath,
  isHistoryTabPath,
  isVersionCompareTabPath,
  parseHistoryDiffTabPath,
} from "./workbenchState";

function fileName(path: string): string {
  if (isGraphTabPath(path)) return "Graph";
  if (isHistoryTabPath(path)) return "History";
  if (isChatsTabPath(path)) return "Chats";
  if (isHistoryDiffTabPath(path)) {
    const parsed = parseHistoryDiffTabPath(path);
    const name = parsed?.filePath.split("/").pop() ?? "Diff";
    return `Diff: ${name}`;
  }
  if (isVersionCompareTabPath(path)) return "Compare with Main";
  return path.split("/").pop() ?? path;
}

function tabTitle(path: string): string {
  if (isGraphTabPath(path)) return "Workspace graph";
  if (isHistoryTabPath(path)) return "Workspace history";
  if (isChatsTabPath(path)) return "Workspace chats";
  if (isHistoryDiffTabPath(path)) {
    const parsed = parseHistoryDiffTabPath(path);
    return parsed ? `History diff: ${parsed.filePath}` : "History diff";
  }
  if (isVersionCompareTabPath(path)) return "Compare this Version with Main";
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
  // Reveal on activation, however it happened (sidebar click, open-file,
  // Ctrl+Tab, close-neighbor). `nearest` makes it a no-op when already
  // visible, so plain clicks on visible tabs never nudge the strip.
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!props.active) return;
    ref.current?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [props.active]);
  return (
    <div
      ref={ref}
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

// The overlay thumb never shrinks below a grabbable pill (VS Code's minimum
// slider size treatment).
const MIN_THUMB_WIDTH = 32;

// Proportional thumb width for the overlay scrollbar; the native-bar ratio
// clamped to stay grabbable, but never wider than the track itself (a strip
// squeezed under 32px by the side panes must not push the thumb's travel
// range negative).
function thumbWidth(strip: HTMLElement): number {
  return Math.min(
    Math.max(
      (strip.clientWidth * strip.clientWidth) / strip.scrollWidth,
      MIN_THUMB_WIDTH,
    ),
    strip.clientWidth,
  );
}

// The tab strip above the editor area. Pure view over workbenchState's tabs:
// activation routes through the shell's single openFile() (which fires the
// file-open-start perf mark), closing through the same closeTab transition
// Ctrl+W and the menu use, reorder through the pure moveTab. `dirty` is
// runtime-only and known for the ACTIVE tab (the one mounted inspector
// reports its save state). h-9: ONE header band height with the side panel
// and Chats panel, so the three hairlines meet at the vertical seams.
export function EditorTabs(props: {
  groupNumber: number;
  tabs: Array<{ path: string }>;
  activeTab: string | null;
  activeTabDirty: boolean;
  // Paths with a set-aside draft (#567). Unlike `activeTabDirty`, this is
  // knowable for EVERY tab — the store outlives the keyed inspectors — so an
  // inactive tab keeps its marker (#579 review, r4).
  recoveryPaths: ReadonlySet<string>;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onContextMenu: (path: string) => void;
  onMove: (path: string, toIndex: number) => void;
  onCreateGroupRight: () => void;
}) {
  const [listOpen, setListOpen] = useState(false);
  const [dragPreview, setDragPreview] = useState<{
    path: string;
    toIndex: number;
  } | null>(null);
  // VS Code wheel behavior: a vertical wheel over the strip scrolls it
  // horizontally. Native listener because React registers `wheel` passive,
  // so preventDefault (needed once we consume the gesture) is a no-op there.
  // Keyed on `empty` — the strip renders null until a tab opens, so the
  // ref is only populated after that flip.
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Overlay scrollbar (VS Code treatment): the native bar stays hidden
  // because a painted bar eats the 36px strip, so the visible affordance is
  // a thin thumb drawn OVER the strip's bottom edge — zero layout height,
  // shown on hover, draggable. Positioned imperatively (scroll fires every
  // frame; no reason to re-render the whole strip per tick).
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const thumbDrag = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
  } | null>(null);
  const [thumbDragging, setThumbDragging] = useState(false);
  const empty = props.tabs.length === 0;
  useEffect(() => {
    const strip = stripRef.current;
    if (empty || !strip) return;
    const onWheel = (event: WheelEvent) => {
      // Trackpads already pan horizontally via deltaX — only translate
      // pure vertical wheels, and only when there is overflow to scroll.
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    // The thumb is a SIBLING of the scroller (it must not scroll away with
    // the content), so wheels over it never bubble through the strip —
    // listen there too or the gesture dies exactly over the affordance.
    const thumb = thumbRef.current;
    thumb?.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      strip.removeEventListener("wheel", onWheel);
      thumb?.removeEventListener("wheel", onWheel);
    };
  }, [empty]);
  useEffect(() => {
    const strip = stripRef.current;
    const thumb = thumbRef.current;
    if (empty || !strip || !thumb) return;
    const measure = () => {
      const maxScroll = strip.scrollWidth - strip.clientWidth;
      if (maxScroll <= 0) {
        thumb.style.display = "none";
        return;
      }
      const width = thumbWidth(strip);
      thumb.style.display = "";
      thumb.style.width = `${width}px`;
      thumb.style.transform = `translateX(${
        (strip.scrollLeft / maxScroll) * (strip.clientWidth - width)
      }px)`;
    };
    measure();
    strip.addEventListener("scroll", measure, { passive: true });
    // Tab opens/closes re-run this effect (deps), as does a dirty dot changing
    // tab width — the observer covers the container resizing under the same
    // tabs (panel toggle, window resize).
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", measure);
      resize?.disconnect();
    };
  }, [empty, props.tabs, props.activeTabDirty]);
  return (
    <div
      data-testid="editor-tabs"
      className="group/strip relative flex h-9 shrink-0 bg-panel-2"
    >
      <div
        ref={stripRef}
        role="tablist"
        aria-label={`Editor group ${props.groupNumber} tabs`}
        className="dohc-tab-strip flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        {props.tabs.map((tab) => (
          <Tab
            key={tab.path}
            path={tab.path}
            active={tab.path === props.activeTab}
            dirty={
              (tab.path === props.activeTab && props.activeTabDirty) ||
              props.recoveryPaths.has(tab.path)
            }
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
      <button
        type="button"
        data-testid="create-editor-group-right"
        aria-label="New editor group right"
        title="New editor group right"
        disabled={empty}
        onClick={props.onCreateGroupRight}
        className="grid w-7 shrink-0 place-items-center border-b border-line text-subtle hover:bg-line/50 hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-subtle"
      >
        <Columns2 size={14} aria-hidden />
      </button>
      {/* The overlay scrollbar thumb. Sibling of the scroller (a child would
          scroll away with the content); width/position are set by the
          measure effect, so it only ever paints when the strip overflows.
          The taller transparent zone is the grab target for the 4px pill. */}
      <div
        ref={thumbRef}
        data-testid="tab-strip-scrollbar"
        aria-hidden
        style={{ display: "none" }}
        onPointerDown={(event) => {
          const strip = stripRef.current;
          if (event.button !== 0 || !strip) return;
          // Keep the browser from starting a text selection / focus change.
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          thumbDrag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startScrollLeft: strip.scrollLeft,
          };
          setThumbDragging(true);
        }}
        onPointerMove={(event) => {
          const state = thumbDrag.current;
          const strip = stripRef.current;
          if (!state || !strip || state.pointerId !== event.pointerId) return;
          // Missed release (capture lost): a buttons-up move ends the drag,
          // or plain hovering would keep scrolling (Tab drag convention).
          if ((event.buttons & 1) === 0) {
            thumbDrag.current = null;
            setThumbDragging(false);
            return;
          }
          const range = strip.clientWidth - thumbWidth(strip);
          const maxScroll = strip.scrollWidth - strip.clientWidth;
          if (range <= 0 || maxScroll <= 0) return;
          strip.scrollLeft =
            state.startScrollLeft +
            ((event.clientX - state.startX) * maxScroll) / range;
        }}
        onPointerUp={() => {
          thumbDrag.current = null;
          setThumbDragging(false);
        }}
        onPointerCancel={() => {
          thumbDrag.current = null;
          setThumbDragging(false);
        }}
        className={`absolute bottom-0 left-0 z-10 flex h-2 touch-none items-end transition-opacity ${
          thumbDragging ? "opacity-100" : "opacity-0 group-hover/strip:opacity-100"
        }`}
      >
        <div
          className={`h-1 w-full rounded-full ${
            thumbDragging ? "bg-ink/40" : "bg-ink/20 hover:bg-ink/35"
          }`}
        />
      </div>
      {/* Overflow affordance: every open tab, reachable even when the strip
          scrolls. Lives OUTSIDE the scroller so the menu is never clipped. */}
      {!empty ? (
        <button
          type="button"
          data-testid="tabs-overflow"
          aria-label={`All tabs in editor group ${props.groupNumber}`}
          title={`All tabs in editor group ${props.groupNumber}`}
          aria-expanded={listOpen}
          onClick={() => setListOpen((open) => !open)}
          className="grid w-7 shrink-0 place-items-center border-b border-line text-subtle hover:text-ink"
        >
          <ChevronDown size={14} aria-hidden />
        </button>
      ) : null}
      {listOpen ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setListOpen(false)} />
          <div
            data-testid="tabs-overflow-menu"
            role="menu"
            aria-label={`Tabs in editor group ${props.groupNumber}`}
            className="dohc-popover dohc-pop-in absolute right-1 top-full z-20 mt-1 max-h-72 w-60 overflow-y-auto rounded-lg border border-line bg-panel py-1"
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
