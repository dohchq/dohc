import { basenameOf } from "../path";
import { ChevronDown, Columns2, X } from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { prefersReducedMotion } from "../reducedMotion";
import {
  isChatsTabPath,
  isGraphTabPath,
  isHistoryTabPath,
  isMomentDiffTabPath,
  isPluginDetailsTabPath,
  isPluginPanelTabPath,
  isPluginWebAppTabPath,
  isSingletonEditorTabPath,
  isVersionCompareTabPath,
  parsePluginDetailsTabPath,
  parsePluginPanelTabPath,
  parsePluginWebAppTabPath,
} from "./workbenchState";

export function momentDiffName(label?: string): string {
  const name = label === undefined ? undefined : basenameOf(label);
  return name ? `Diff: ${name}` : "History change";
}

// A plugin's own names — its display name and its web apps' titles — live in
// its manifest, which the tab path cannot carry and this strip cannot read.
// `label` is that name once a mounted plugin page has reported it, and the id
// from the path is the fallback until then (a tab restored on launch has no
// page yet).
function fileName(path: string, label?: string): string {
  if (isGraphTabPath(path)) return "Graph";
  if (isHistoryTabPath(path)) return "History";
  if (isChatsTabPath(path)) return "Chats";
  if (isPluginPanelTabPath(path)) {
    return parsePluginPanelTabPath(path)?.panelId ?? "Plugin panel";
  }
  if (isPluginWebAppTabPath(path)) {
    // Until the app starts and reports its own title, every instance of one
    // web app would read alike. The instance key is what the user picked, so
    // it names the tab in the meantime.
    const webApp = parsePluginWebAppTabPath(path);
    return label ?? webApp?.instanceKey ?? webApp?.webAppId ?? "Plugin app";
  }
  if (isPluginDetailsTabPath(path)) {
    return label ?? parsePluginDetailsTabPath(path)?.pluginId ?? "Plugin";
  }
  if (isMomentDiffTabPath(path)) {
    return momentDiffName(label);
  }
  if (isVersionCompareTabPath(path)) return "Compare with Main";
  return basenameOf(path);
}

function tabTitle(path: string, label?: string): string {
  if (isGraphTabPath(path)) return "Workspace graph";
  if (isHistoryTabPath(path)) return "Workspace history";
  if (isChatsTabPath(path)) return "Workspace chats";
  if (isPluginPanelTabPath(path)) {
    const panel = parsePluginPanelTabPath(path);
    return panel ? `${panel.pluginId} — ${panel.panelId}` : "Plugin panel";
  }
  if (isPluginWebAppTabPath(path)) {
    const webApp = parsePluginWebAppTabPath(path);
    if (!webApp) return "Plugin app";
    return `${webApp.pluginId} — ${label ?? webApp.instanceKey ?? webApp.webAppId}`;
  }
  // A plugin's details tab and its app tab can sit side by side under the
  // same name, so the tooltip is what tells them apart.
  if (isPluginDetailsTabPath(path)) {
    const details = parsePluginDetailsTabPath(path);
    return details ? `Plugin details: ${details.pluginId}` : "Plugin details";
  }
  if (isMomentDiffTabPath(path)) {
    return label ? `History diff: ${label}` : "History change";
  }
  if (isVersionCompareTabPath(path)) return "Compare this Version with Main";
  return path;
}

// The active tab and the editor body below it share one surface. The tab's
// bottom outer corners curve out into the strip's hairline (the joins) and
// the body's top corners curve up into it (the pane corners). Both radii
// follow the active tab's distance from the pane edge: a tab at the edge
// leaves one straight line, a tab further in sits on a rounded pane, and a
// dragged tab morphs between the two as it passes.
const CORNER_RADIUS = 8;
const MORPH_RANGE = 20;
const DRAG_THRESHOLD = 4;
const SETTLE_MS = 160;
const SETTLE_EASING = "cubic-bezier(0.2, 0.8, 0.3, 1)";

export function cornerRadius(distance: number): number {
  return CORNER_RADIUS * Math.min(1, Math.max(0, distance / MORPH_RANGE));
}

// Each decoration is a fixed square of the full radius plus its hairline,
// holding an arc child whose one rounded corner is the morph. Only the
// radius changes: a border radius is paint-only, whereas resizing even a
// tiny absolute box invalidates layout up the tree, and with a large
// document open that is milliseconds per frame. Below the full radius the
// straight remainder of the two bordered sides lies on lines that are
// already there: the strip hairline, the tab outline, or the pane edge.
type Arc = "tl" | "tr" | "br" | "bl";

function setCornerRadius(el: Element | null, radius: number) {
  const arc = el?.firstElementChild;
  if (!(el instanceof HTMLElement) || !(arc instanceof HTMLElement)) return;
  const r = `${radius + 1}px`;
  const corners: Record<Arc, string> = {
    tl: `${r} 0px 0px 0px`,
    tr: `0px ${r} 0px 0px`,
    br: `0px 0px ${r} 0px`,
    bl: `0px 0px 0px ${r}`,
  };
  const value = corners[(el.dataset.arc ?? "tl") as Arc];
  if (arc.style.borderRadius !== value) arc.style.borderRadius = value;
}

// The arc is a rounded, hairlined child filling the square; its spread
// shadow is the chrome or paper fill outside the arc, and the square clips
// it with overflow, which Chromium snaps to whole pixels. A clip-path here
// would antialias the edge of a fractionally placed square and leak a
// half-pixel of fill along it.
const DECORATION = "pointer-events-none absolute size-[9px] overflow-hidden";
const DECORATION_ARC =
  "absolute inset-0 border-line transition-[border-radius] duration-[160ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]";
const TAB_JOIN = `${DECORATION} -bottom-px`;
const TAB_JOIN_ARC = `${DECORATION_ARC} border-b shadow-[0_0_0_8px_var(--color-bg)]`;
const PANE_CORNER = `${DECORATION} top-0`;
const PANE_CORNER_ARC = `${DECORATION_ARC} border-t shadow-[0_0_0_8px_var(--color-panel-2)]`;

// Memoized so the dirty flips while typing (saveState ticks every autosave)
// re-render only the active tab, not the whole strip (FileRow precedent —
// typingLongTaskMs budget). All callbacks must be referentially stable.
const Tab = memo(function Tab(props: {
  groupId: string;
  path: string;
  /** The tab's display name when the path alone cannot supply it. A string,
   * not a lookup: this component is memoized on its props. */
  label?: string;
  active: boolean;
  dirty: boolean;
  onActivate: (groupId: string, path: string) => void;
  onClose: (groupId: string, path: string) => void;
  onContextMenu: (groupId: string, path: string) => void;
  onDragStart: (event: ReactPointerEvent<HTMLDivElement>, path: string) => void;
}) {
  const name = fileName(props.path, props.label);
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
      title={tabTitle(props.path, props.label)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onActivate(props.groupId, props.path);
        }
      }}
      // Middle-click closes (VS Code convention); auxclick is the only
      // reliable middle-button event.
      onAuxClick={(event) => {
        if (event.button === 1) props.onClose(props.groupId, props.path);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(props.groupId, props.path);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // Activate on press (VS Code behavior) — click can't be relied on
        // after a drag: the reorder re-inserts the DOM node, which cancels
        // both pointer capture and click synthesis in Chromium.
        if (!props.active) props.onActivate(props.groupId, props.path);
        props.onDragStart(event, props.path);
      }}
      // Every tab carries a 1px border on all sides so activation never
      // changes its size: an inactive tab shows only the strip's bottom
      // hairline, the active tab shows its outline and paints its bottom
      // edge paper so it merges with the editor and covers the pane
      // corner's straight edge beneath it. Tabs stand on the strip's floor
      // (self-end) under a band of chrome, browser style. Every tab keeps a
      // transform, so the drag's writes never toggle it from none, which
      // would re-layout the strip on every crossing. `transform`
      // transitions slide displaced neighbours; the dragged tab itself
      // follows the pointer with no interpolation.
      className={`group relative flex h-8 shrink-0 select-none items-center gap-1.5 self-end border px-3 text-[13px] [transform:translateX(0)] transition-[background-color,color,transform] duration-150 data-dragging:z-20 data-dragging:cursor-grabbing data-dragging:transition-none ${
        props.active
          ? "z-10 rounded-t-lg border-line border-b-bg bg-bg text-ink"
          : "cursor-default border-transparent border-b-line text-muted before:absolute before:inset-y-2 before:-left-px before:w-px before:bg-line first:before:hidden [[data-active]+&::before]:hidden hover:bg-line/50 hover:text-ink"
      }`}
    >
      {props.active ? (
        <>
          <span aria-hidden data-tab-join="left" data-arc="br" className={`${TAB_JOIN} right-full`}>
            <span className={`${TAB_JOIN_ARC} border-r`} />
          </span>
          <span aria-hidden data-tab-join="right" data-arc="bl" className={`${TAB_JOIN} left-full`}>
            <span className={`${TAB_JOIN_ARC} border-l`} />
          </span>
        </>
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
          props.onClose(props.groupId, props.path);
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

function editorGroupAtPoint(
  clientX: number,
  clientY: number,
): { groupId: string; toIndex: number } | null {
  const hit = document.elementFromPoint?.(clientX, clientY);
  const group = hit?.closest<HTMLElement>("[data-editor-group-id]");
  const groupId = group?.dataset.editorGroupId;
  if (!group || !groupId) return null;

  const tabs = group.querySelectorAll<HTMLElement>('[role="tab"]');
  return { groupId, toIndex: tabInsertionIndex(tabs, clientX) };
}

function tabInsertionIndex(tabs: Iterable<HTMLElement>, clientX: number): number {
  let toIndex = 0;
  for (const tab of tabs) {
    const box = tab.getBoundingClientRect();
    if (box.left + box.width / 2 < clientX) toIndex += 1;
  }
  return toIndex;
}

// Clears the tab's drag translation and animates it from where the pointer
// left it into the slot it now occupies. The animation is kept so a grab
// during those 160ms can stop it in place instead of fighting it.
const settling = new WeakMap<HTMLElement, Animation>();

function settleTab(tab: HTMLElement, visualLeft: number) {
  tab.style.transform = "";
  const delta = visualLeft - tab.offsetLeft;
  if (
    Math.abs(delta) < 0.5 ||
    prefersReducedMotion() ||
    typeof tab.animate !== "function"
  ) {
    return;
  }
  const animation = tab.animate(
    [{ transform: `translateX(${delta}px)` }, { transform: "none" }],
    { duration: SETTLE_MS, easing: SETTLE_EASING },
  );
  settling.set(tab, animation);
  animation.addEventListener("finish", () => settling.delete(tab));
}

// Stops a settling tab. Frozen, the animated transform becomes its inline
// transform so the next drag starts from there; otherwise it lands in its
// slot at once, so a drag preview can own its transform.
function stopSettling(tab: HTMLElement, freeze: boolean) {
  const animation = settling.get(tab);
  if (!animation) return;
  settling.delete(tab);
  if (freeze) animation.commitStyles();
  animation.cancel();
}

function inlineTranslateX(el: HTMLElement): number {
  if (!el.style.transform || typeof DOMMatrix === "undefined") return 0;
  try {
    return new DOMMatrix(el.style.transform).m41;
  } catch {
    return 0;
  }
}

interface DragSlot {
  el: HTMLElement;
  // Content-space geometry from offsetLeft/offsetWidth: unaffected by the
  // strip's scroll and by the translations this drag applies.
  left: number;
  width: number;
  offset: number;
}

interface DragSession {
  pointerId: number;
  path: string;
  tab: HTMLElement;
  startX: number;
  startY: number;
  pointerX: number;
  pointerY: number;
  active: boolean;
  slots: DragSlot[];
  index: number;
  toIndex: number;
  // Pointer x minus the tab's visual left, both in content space, fixed at
  // activation so the tab keeps the same spot under the pointer.
  grab: number;
  dx: number;
  frameLeft: number;
  paneWidth: number;
  viewWidth: number;
  multiGroup: boolean;
  frame: number;
  joins: [Element | null, Element | null];
}

interface TabDragHost {
  frame: () => HTMLElement | null;
  scroller: () => HTMLElement | null;
  paneCorners: () => [Element | null, Element | null];
  groupId: () => string;
  move: (path: string, toIndex: number) => void;
  moveToGroup: (targetGroupId: string, path: string, toIndex: number) => void;
  // The order commit re-renders the strip; the host settles the tab into its
  // new slot once that render has landed.
  settle: (tab: HTMLElement, visualLeft: number) => void;
  sync: () => void;
}

// Pointer-drag reorder (no dnd dep). A press only becomes a drag after 4px
// of travel, so plain clicks never reorder. While captured, the tab follows
// the pointer as a transform, the tabs it has passed slide aside by its
// width, and the corner decorations morph with its distance from the pane
// edge — all direct DOM writes, coalesced per frame, with no React state
// and no layout reads: geometry is cached at activation and refreshed only
// when the tab list or strip size changes. The order commits once, on
// release; terminal events commit the last position, unmount drops it.
function createTabDrag(host: TabDragHost) {
  let session: DragSession | null = null;

  // The arc children carry the radius transition that a drag must suspend.
  const decorations = (s: DragSession): Array<Element | null> =>
    [...s.joins, ...host.paneCorners()].map((el) => el?.firstElementChild ?? null);

  const measure = (s: DragSession): boolean => {
    const frame = host.frame();
    const scroller = host.scroller();
    if (!frame || !scroller || !s.tab.isConnected) return false;
    s.slots = Array.from(
      scroller.querySelectorAll<HTMLElement>('[role="tab"]'),
      (el) => ({ el, left: el.offsetLeft, width: el.offsetWidth, offset: 0 }),
    );
    s.index = s.slots.findIndex((slot) => slot.el === s.tab);
    if (s.index < 0) return false;
    s.frameLeft = frame.getBoundingClientRect().left;
    s.paneWidth = frame.clientWidth;
    s.viewWidth = scroller.clientWidth;
    return true;
  };

  const applyFrame = (s: DragSession) => {
    const scroller = host.scroller();
    const slot = s.slots[s.index];
    if (!scroller || !slot) return;
    const scrollLeft = scroller.scrollLeft;
    // Crossing into another group is committed on release. While the
    // pointer is over its destination, the source shows its committed order
    // again instead of a stale preview; the grab offset survives, so coming
    // back resumes under the pointer.
    if (s.multiGroup) {
      const target = editorGroupAtPoint(s.pointerX, s.pointerY);
      if (target && target.groupId !== host.groupId()) {
        placeNeighbours(s, s.index);
        placeTab(s, slot.left, scrollLeft);
        return;
      }
    }
    const wanted = s.pointerX - s.frameLeft + scrollLeft - s.grab;
    // The tab stays inside the visible strip: the scroller would clip it
    // anyway, and the clamp keeps its joins inside the pane. The insertion
    // slot follows the unclamped position, or a tab wider than the room
    // left beside it could never reach the end.
    const min = scrollLeft;
    const max = Math.max(min, scrollLeft + s.viewWidth - slot.width);
    placeTab(s, Math.min(max, Math.max(min, wanted)), scrollLeft);
    const center = wanted + slot.width / 2;
    let toIndex = 0;
    for (const other of s.slots) {
      if (other !== slot && other.left + other.width / 2 < center) toIndex += 1;
    }
    placeNeighbours(s, toIndex);
  };

  // Moves the dragged tab to a content-space left edge and morphs the
  // corners with its distance from each pane edge.
  const placeTab = (s: DragSession, left: number, scrollLeft: number) => {
    const slot = s.slots[s.index];
    if (!slot) return;
    const dx = left - slot.left;
    if (dx !== s.dx) {
      s.dx = dx;
      s.tab.style.transform = dx === 0 ? "" : `translateX(${dx}px)`;
    }
    const distanceLeft = left - scrollLeft;
    const distanceRight = s.paneWidth - (left + slot.width - scrollLeft);
    const [joinLeft, joinRight] = s.joins;
    const [cornerLeft, cornerRight] = host.paneCorners();
    setCornerRadius(joinLeft, cornerRadius(distanceLeft));
    setCornerRadius(cornerLeft, cornerRadius(distanceLeft));
    setCornerRadius(joinRight, cornerRadius(distanceRight));
    setCornerRadius(cornerRight, cornerRadius(distanceRight));
  };

  // Slides the tabs between the dragged tab's slot and its insertion slot
  // aside by its width; every other tab returns home.
  const placeNeighbours = (s: DragSession, toIndex: number) => {
    if (toIndex === s.toIndex) return;
    s.toIndex = toIndex;
    const slot = s.slots[s.index];
    if (!slot) return;
    s.slots.forEach((other, i) => {
      const offset =
        i > s.index && i <= toIndex
          ? -slot.width
          : i < s.index && i >= toIndex
            ? slot.width
            : 0;
      if (other === slot || other.offset === offset) return;
      other.offset = offset;
      other.el.style.transform = offset === 0 ? "" : `translateX(${offset}px)`;
    });
  };

  const scheduleFrame = (s: DragSession) => {
    if (s.frame !== 0) return;
    s.frame = requestAnimationFrame(() => {
      s.frame = 0;
      if (session === s) applyFrame(s);
    });
  };

  const activate = (s: DragSession): boolean => {
    if (!measure(s)) return false;
    const scroller = host.scroller();
    const slot = s.slots[s.index];
    if (!scroller || !slot) return false;
    s.active = true;
    s.toIndex = s.index;
    s.dx = inlineTranslateX(s.tab);
    s.grab = s.startX - s.frameLeft + scroller.scrollLeft - (slot.left + s.dx);
    s.multiGroup = document.querySelectorAll("[data-editor-group-id]").length > 1;
    s.joins = [
      s.tab.querySelector('[data-tab-join="left"]'),
      s.tab.querySelector('[data-tab-join="right"]'),
    ];
    s.tab.dataset.dragging = "";
    // A neighbour still settling from the last reorder lands now, or its
    // animation would override the translation this drag writes.
    for (const other of s.slots) {
      if (other.el !== s.tab) stopSettling(other.el, false);
    }
    // Pointer-driven writes must land as written; a transition would trail.
    for (const el of decorations(s)) {
      if (el instanceof HTMLElement) el.style.transition = "none";
    }
    return true;
  };

  const detach = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("blur", onBlur);
  };

  const finish = (commit: boolean, release: PointerEvent | null) => {
    const s = session;
    if (!s) return;
    session = null;
    detach();
    if (s.frame !== 0) {
      cancelAnimationFrame(s.frame);
      s.frame = 0;
    }
    if (!s.active) {
      // A press that never became a drag may still hold a frozen settle.
      s.tab.style.transform = "";
      return;
    }
    // A release counts where it happened, even when its frame never ran. A
    // cancel, a missed release, or blur keeps the last painted preview.
    if (release) {
      s.pointerX = release.clientX;
      s.pointerY = release.clientY;
      applyFrame(s);
    }
    delete s.tab.dataset.dragging;
    for (const el of decorations(s)) {
      if (el instanceof HTMLElement) el.style.transition = "";
    }
    // Every tab resets without a slide: the displaced neighbours are about to
    // re-render in their new slots, and the dragged tab settles through its
    // own animation. Transitions return next frame, once the commit's render
    // has landed and nothing is left to interpolate.
    const slot = s.slots[s.index];
    for (const other of s.slots) {
      other.el.style.transition = "none";
      if (other !== slot) other.el.style.transform = "";
    }
    requestAnimationFrame(() => {
      for (const other of s.slots) other.el.style.transition = "";
    });
    const target = release && editorGroupAtPoint(release.clientX, release.clientY);
    if (commit && target && target.groupId !== host.groupId()) {
      s.tab.style.transform = "";
      host.moveToGroup(target.groupId, s.path, target.toIndex);
      return;
    }
    const visualLeft = slot ? slot.left + s.dx : 0;
    if (!commit || !slot || s.toIndex === s.index) {
      settleTab(s.tab, visualLeft);
      host.sync();
      return;
    }
    host.settle(s.tab, visualLeft);
    host.move(s.path, s.toIndex);
  };

  const onPointerMove = (event: PointerEvent) => {
    const s = session;
    if (!s || s.pointerId !== event.pointerId) return;
    // A mouse keeps one pointerId for life. If release was missed, a
    // buttons-up move must end the drag before hovering can reorder.
    if ((event.buttons & 1) === 0) {
      finish(true, null);
      return;
    }
    if (!s.active) {
      if (
        Math.hypot(event.clientX - s.startX, event.clientY - s.startY) <
        DRAG_THRESHOLD
      ) {
        return;
      }
      if (!activate(s)) {
        finish(false, null);
        return;
      }
    }
    s.pointerX = event.clientX;
    s.pointerY = event.clientY;
    scheduleFrame(s);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (session?.pointerId === event.pointerId) finish(true, event);
  };
  const onPointerCancel = (event: PointerEvent) => {
    if (session?.pointerId === event.pointerId) finish(true, null);
  };
  const onBlur = () => finish(true, null);

  return {
    begin(event: ReactPointerEvent<HTMLElement>, path: string) {
      // Finish the previous pointer's drag before arming this one; its
      // listeners would otherwise end the new drag.
      finish(true, null);
      stopSettling(event.currentTarget, true);
      session = {
        pointerId: event.pointerId,
        path,
        tab: event.currentTarget,
        startX: event.clientX,
        startY: event.clientY,
        pointerX: event.clientX,
        pointerY: event.clientY,
        active: false,
        slots: [],
        index: -1,
        toIndex: -1,
        grab: 0,
        dx: 0,
        frameLeft: 0,
        paneWidth: 0,
        viewWidth: 0,
        multiGroup: false,
        frame: 0,
        joins: [null, null],
      };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("blur", onBlur);
    },
    active() {
      return session?.active === true;
    },
    // The strip scrolled under the pointer: the tab's position and the
    // corner radii depend on scrollLeft, so the next frame re-derives them.
    scrolled() {
      if (session?.active) scheduleFrame(session);
    },
    // The tab list or the strip's size changed under the drag: re-measure
    // from clean positions and rebuild the preview. A dragged tab that left
    // the strip (closed mid-drag) ends its drag without a commit.
    refresh() {
      const s = session;
      if (!s?.active) return;
      for (const other of s.slots) {
        other.el.style.transform = "";
        other.offset = 0;
      }
      if (!measure(s)) {
        finish(false, null);
        return;
      }
      s.toIndex = s.index;
      // Force the transform write: the tab's own slot may have moved.
      s.dx = Number.NaN;
      applyFrame(s);
    },
    dispose() {
      finish(false, null);
    },
  };
}

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
// runtime-only and known for the active tab (the one mounted inspector
// reports its save state). h-9: one header band height with the side panel
// and Chats panel, so the three hairlines meet at the vertical seams.
export const EditorTabs = memo(function EditorTabs(props: {
  groupId: string;
  groupNumber: number;
  tabs: Array<{ path: string }>;
  activeTab: string | null;
  activeTabDirty: boolean;
  /** Display names the tab path cannot supply, keyed by path: plugin titles
   * from manifests and moment paths from history records. */
  tabLabels?: ReadonlyMap<string, string>;
  // Paths with a set-aside draft. Unlike `activeTabDirty`, this is
  // knowable for every tab — the store outlives the keyed inspectors — so an
  // inactive tab keeps its marker.
  recoveryPaths: ReadonlySet<string>;
  onActivate: (groupId: string, path: string) => void;
  onClose: (groupId: string, path: string) => void;
  onContextMenu: (groupId: string, path: string) => void;
  onMove: (groupId: string, path: string, toIndex: number) => void;
  onMoveToGroup: (
    sourceGroupId: string,
    targetGroupId: string,
    path: string,
    toIndex: number,
  ) => void;
  onCreateGroupRight: (groupId: string) => void;
  onCloseGroup?: (groupId: string) => void;
}) {
  const [listOpen, setListOpen] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  // The strip's frame spans the pane's full width; the scroller inside it
  // starts at the pane's left edge, so a tab's offsetLeft is its content
  // position and offsetLeft minus scrollLeft its distance from that edge.
  const frameRef = useRef<HTMLDivElement | null>(null);
  // VS Code wheel behavior: a vertical wheel over the strip scrolls it
  // horizontally. Native listener because React registers `wheel` passive,
  // so preventDefault (needed once we consume the gesture) is a no-op there.
  // Keyed on `empty` — the strip renders null until a tab opens, so the
  // ref is only populated after that flip.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const leftCornerRef = useRef<HTMLSpanElement | null>(null);
  const rightCornerRef = useRef<HTMLSpanElement | null>(null);
  // A committed reorder settles in the layout effect below, once the new
  // order has rendered; a commit the shell rejects settles next frame.
  const pendingSettle = useRef<{ tab: HTMLElement; left: number } | null>(null);
  // Overlay scrollbar (VS Code treatment): the native bar stays hidden
  // because a painted bar eats the 36px strip, so the visible affordance is
  // a thin thumb drawn over the strip's bottom edge — zero layout height,
  // shown on hover, draggable. Positioned imperatively (scroll fires every
  // frame; no reason to re-render the whole strip per tick).
  const thumbRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (props.tabs.length === 0) setListOpen(false);
  }, [props.tabs.length]);
  const thumbDrag = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
  } | null>(null);
  const [thumbDragging, setThumbDragging] = useState(false);
  const empty = props.tabs.length === 0;

  // Resting corner radii: the active tab's distance from each pane edge, or
  // the full radius when no tab is near it. Skipped during a drag, which
  // writes the same elements per frame.
  const syncCorners = useRef<() => void>(() => {});
  const tabDrag = useRef<ReturnType<typeof createTabDrag> | null>(null);
  if (tabDrag.current === null) {
    tabDrag.current = createTabDrag({
      frame: () => frameRef.current,
      scroller: () => stripRef.current,
      paneCorners: () => [leftCornerRef.current, rightCornerRef.current],
      groupId: () => latest.current.groupId,
      move: (path, toIndex) =>
        latest.current.onMove(latest.current.groupId, path, toIndex),
      moveToGroup: (targetGroupId, path, toIndex) =>
        latest.current.onMoveToGroup(
          latest.current.groupId,
          targetGroupId,
          path,
          toIndex,
        ),
      settle: (tab, left) => {
        pendingSettle.current = { tab, left };
        requestAnimationFrame(() => {
          if (pendingSettle.current?.tab !== tab) return;
          pendingSettle.current = null;
          tab.style.transform = "";
          syncCorners.current();
        });
      },
      sync: () => syncCorners.current(),
    });
  }
  const drag = tabDrag.current;
  syncCorners.current = () => {
    const frame = frameRef.current;
    const scroller = stripRef.current;
    if (!frame || !scroller || drag.active()) return;
    const active = scroller.querySelector<HTMLElement>('[role="tab"][data-active]');
    let left = Number.POSITIVE_INFINITY;
    let right = Number.POSITIVE_INFINITY;
    if (active) {
      left = active.offsetLeft - scroller.scrollLeft;
      right = frame.clientWidth - (left + active.offsetWidth);
    }
    setCornerRadius(active?.querySelector('[data-tab-join="left"]') ?? null, cornerRadius(left));
    setCornerRadius(leftCornerRef.current, cornerRadius(left));
    setCornerRadius(active?.querySelector('[data-tab-join="right"]') ?? null, cornerRadius(right));
    setCornerRadius(rightCornerRef.current, cornerRadius(right));
  };
  useEffect(() => () => drag.dispose(), [drag]);
  useLayoutEffect(() => {
    if (drag.active()) {
      drag.refresh();
      return;
    }
    const pending = pendingSettle.current;
    if (!pending) return;
    pendingSettle.current = null;
    if (pending.tab.isConnected) settleTab(pending.tab, pending.left);
    syncCorners.current();
  }, [drag, props.tabs]);

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
    if (!strip || !thumb) return;
    const measure = () => {
      drag.scrolled();
      syncCorners.current();
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
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            drag.refresh();
            measure();
          });
    resize?.observe(strip);
    return () => {
      strip.removeEventListener("scroll", measure);
      resize?.disconnect();
    };
  }, [drag, props.tabs, props.activeTab, props.activeTabDirty]);
  return (
    <div
      ref={frameRef}
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
            groupId={props.groupId}
            path={tab.path}
            label={props.tabLabels?.get(tab.path)}
            active={tab.path === props.activeTab}
            dirty={
              (tab.path === props.activeTab && props.activeTabDirty) ||
              props.recoveryPaths.has(tab.path)
            }
            onActivate={props.onActivate}
            onClose={props.onClose}
            onContextMenu={props.onContextMenu}
            onDragStart={drag.begin}
          />
        ))}
        {/* Continues the hairline across the empty strip — only the active
            tab interrupts it. */}
        <div aria-hidden className="min-w-4 flex-1 border-b border-line" />
      </div>
      {props.onCloseGroup ? (
        <button
          type="button"
          aria-label="Close editor group"
          title="Close editor group"
          onClick={() => props.onCloseGroup?.(props.groupId)}
          className="grid w-7 shrink-0 place-items-center border-b border-line text-subtle hover:bg-line/50 hover:text-ink"
        >
          <X size={14} aria-hidden />
        </button>
      ) : null}
      <button
        type="button"
        data-testid="create-editor-group-right"
        aria-label="New editor group right"
        title="New editor group right"
        disabled={empty || isSingletonEditorTabPath(props.activeTab)}
        onClick={() => props.onCreateGroupRight(props.groupId)}
        className="grid w-7 shrink-0 place-items-center border-b border-line text-subtle hover:bg-line/50 hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-subtle"
      >
        <Columns2 size={14} aria-hidden />
      </button>
      {/* The pane's top corners, drawn over the editor body just below the
          strip. They hang off the strip so the drag that morphs them writes
          one element tree; the editor's own box keeps square corners and
          never repaints for them. Each sits one pixel past the pane edge so
          its arc meets the neighbouring line, and the band clips that pixel
          horizontally: past the window edge it would give the document a
          scrollbar. The band stacks under the active tab (z-10) and over
          the editor body. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[calc(100%-1px)] z-[5] h-[9px] overflow-x-clip"
      >
        <span
          ref={leftCornerRef}
          data-pane-corner="left"
          data-arc="tl"
          className={`${PANE_CORNER} -left-px`}
        >
          <span className={`${PANE_CORNER_ARC} border-l`} />
        </span>
        <span
          ref={rightCornerRef}
          data-pane-corner="right"
          data-arc="tr"
          className={`${PANE_CORNER} -right-px`}
        >
          <span className={`${PANE_CORNER_ARC} border-r`} />
        </span>
      </div>
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
          scrolls. Lives outside the scroller so the menu is never clipped. */}
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
                  props.onActivate(props.groupId, tab.path);
                }}
                className={`flex h-7 w-full items-center px-3 text-left text-[13px] ${
                  tab.path === props.activeTab
                    ? "text-ink"
                    : "text-muted hover:bg-line/50 hover:text-ink"
                }`}
              >
                <span className="truncate">
                  {fileName(tab.path, props.tabLabels?.get(tab.path))}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
});
