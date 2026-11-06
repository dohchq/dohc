import { desktopPins, activityPin } from "../../testPins";
import { Settings, Users, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { pinnedAppInitial, type PinnedApp } from "./pinnedApps";
import { VIEW_IDENTITY } from "./viewIdentity";
import { appViewId, SHARING_VIEW_ID, type ActivityViewId, type ViewId } from "./workbenchState";

// VS Code-style activity bar: 48px icon rail, leftmost column of the
// workbench. Ported a11y/active patterns from the retired web ActivityBar
// (7277c39^): data-table of items, title + aria-label + aria-current on every
// button, active = full-ink icon with a 2px left ink indicator. Clicking the
// active item toggles the side panel (the old explicit collapse button).
// dohc's own views draw the label and icon VIEW_IDENTITY names.

// Every rail glyph is drawn the same size and weight; only the icon differs.
function RailGlyph(props: { Icon: LucideIcon }) {
  return <props.Icon size={18} strokeWidth={1.9} aria-hidden />;
}

function RailButton(props: {
  label: string;
  // The button's name when it says more than its label, such as a count.
  name?: string;
  testId: string;
  active?: boolean;
  // Badge dot seam (conflicts, running agent — more arrive in later phases).
  badge?: "danger" | "success";
  // Numeric badge seam (Phase E5.0: search results count while showing).
  count?: number;
  onClick?: () => void;
  onContextMenu?: () => void;
  // A node, not a component: dohc's views draw a lucide glyph and a pinned
  // app draws its initial.
  icon: ReactNode;
}) {
  const className = `relative grid size-9 place-items-center rounded-lg transition-colors duration-100 ${
    props.active
      ? "bg-selected text-ink"
      : props.onClick
        ? "text-subtle hover:bg-hover hover:text-ink"
        : "text-subtle"
  }`;
  const content = (
    <>
      {props.icon}
      {props.badge ? (
        <span
          aria-hidden
          className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${
            props.badge === "danger" ? "bg-danger" : "bg-success"
          }`}
        />
      ) : null}
      {/* Notices' count, 1px further out up and right: at Notices' place
          "9+" touches the magnifier's ring. 1px in from both edges, it clears
          the ring and stays inside the button's rounded corner. The button's
          name carries the exact number. */}
      {typeof props.count === "number" ? (
        <span
          data-testid={`${props.testId}-count`}
          aria-hidden
          className="absolute right-px top-px h-3 min-w-3 rounded-full bg-ink px-0.5 text-center text-[8px] font-semibold leading-3 text-bg"
        >
          {props.count > 9 ? "9+" : props.count}
        </span>
      ) : null}
    </>
  );
  // The active bar sits on the rail's left edge, outside the tile, so it
  // belongs to a full-width row rather than to the tile.
  return (
    <div className="relative flex w-full justify-center">
      {props.active ? (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-ink"
        />
      ) : null}
      {props.onClick ? (
        <button
          type="button"
          data-testid={props.testId}
          title={props.label}
          aria-label={props.name ?? props.label}
          aria-current={props.active ? "page" : undefined}
          onClick={props.onClick}
          onContextMenu={
            props.onContextMenu
              ? (event) => {
                  event.preventDefault();
                  props.onContextMenu?.();
                }
              : undefined
          }
          className={className}
        >
          {content}
        </button>
      ) : (
        <span data-testid={props.testId} aria-hidden="true" className={className}>
          {content}
        </span>
      )}
    </div>
  );
}

export function ActivityBar(props: {
  // dohc's own views the person keeps in the sidebar, in their order.
  views: readonly ViewId[];
  activeView: ActivityViewId;
  sidebarVisible: boolean;
  hasConflict: boolean;
  // Content-search results count; undefined = no badge.
  searchResultCount?: number;
  // Apps pinned in this workspace, after dohc's own views.
  pinnedApps?: readonly PinnedApp[];
  onPinnedAppMenu?: (appRoot: string) => void;
  onSelectView: (view: ActivityViewId) => void;
  onOpenSettings?: () => void;
  notices?: ReactNode;
  viewsDisabled?: boolean;
  showSharing?: boolean;
}) {
  return (
    <nav
      aria-label="Activity bar"
      data-testid={desktopPins.activityBar}
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel pb-2 pt-1"
    >
      {/* The view list scrolls, so enough pinned apps never push the
          Sharing and Settings buttons off the rail. It spans the rail and pads
          its ends, so the clip keeps the active bar, a tile's count, and the
          focus ring, and never scrolls sideways. */}
      <div inert={props.viewsDisabled || undefined} className="flex min-h-0 w-full flex-col items-center gap-1 overflow-y-auto overflow-x-hidden py-1">
        {props.views.map((view) => (
          <RailButton
            key={view}
            testId={activityPin(view)}
            label={VIEW_IDENTITY[view].label}
            // The rail reflects a collapsed panel: no active mark while hidden.
            active={props.sidebarVisible && props.activeView === view}
            badge={view === "explorer" && props.hasConflict ? "danger" : undefined}
            count={view === "search" ? props.searchResultCount : undefined}
            name={view === "search" && props.searchResultCount
              ? `${VIEW_IDENTITY.search.label}, ${props.searchResultCount} result${props.searchResultCount === 1 ? "" : "s"}`
              : undefined}
            onClick={() => props.onSelectView(view)}
            icon={<RailGlyph Icon={VIEW_IDENTITY[view].Icon} />}
          />
        ))}
        {(props.pinnedApps ?? []).map((app) => {
          const viewId = appViewId(app.root);
          return (
            <RailButton
              key={viewId}
              testId="activity-pinned-app"
              label={app.label}
              active={props.sidebarVisible && props.activeView === viewId}
              onClick={() => props.onSelectView(viewId)}
              onContextMenu={
                props.onPinnedAppMenu ? () => props.onPinnedAppMenu?.(app.root) : undefined
              }
              // The app's initial tells pinned apps apart; its title is the
              // button's name and tooltip.
              icon={
                <span
                  aria-hidden
                  className="grid size-[18px] place-items-center rounded-md border-[1.5px] border-current text-[11px] font-semibold leading-none"
                >
                  {pinnedAppInitial(app.label)}
                </span>
              }
            />
          );
        })}
      </div>
      <div className="mt-auto flex flex-col items-center gap-1 border-t border-line pt-2">
        {/* Sharing opens a view like the ones above, so it goes inert with them. */}
        {props.showSharing !== false ? (
          <div inert={props.viewsDisabled || undefined} className="flex w-full justify-center">
            <RailButton
              testId={activityPin(SHARING_VIEW_ID)}
              label="Sharing"
              active={props.sidebarVisible && props.activeView === SHARING_VIEW_ID}
              badge={props.hasConflict ? "danger" : undefined}
              onClick={() => props.onSelectView(SHARING_VIEW_ID)}
              icon={<RailGlyph Icon={Users} />}
            />
          </div>
        ) : null}
        {props.notices}
        <RailButton
          testId={activityPin("settings")}
          label="Open settings"
          onClick={props.onOpenSettings}
          icon={<RailGlyph Icon={Settings} />}
        />
      </div>
    </nav>
  );
}
