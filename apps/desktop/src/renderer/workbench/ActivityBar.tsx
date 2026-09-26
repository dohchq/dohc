import {
  Cloud,
  Files,
  Globe2,
  History,
  Search,
  Settings,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { pinnedAppInitial, type PinnedApp } from "./pinnedApps";
import { appViewId, type ActivityViewId, type ViewId } from "./workbenchState";

// VS Code-style activity bar: 48px icon rail, leftmost column of the
// workbench. Ported a11y/active patterns from the retired web ActivityBar
// (7277c39^): data-table of items, title + aria-label + aria-current on every
// button, active = full-ink icon with a 2px left ink indicator. Clicking the
// active item toggles the side panel (the old explicit collapse button).

const ICONS: Record<ViewId, typeof Files> = {
  explorer: Files,
  search: Search,
  graph: Workflow,
  sites: Globe2,
  history: History,
};

const LABELS: Record<ViewId, string> = {
  explorer: "Explorer",
  search: "Search",
  graph: "Graph",
  sites: "Apps",
  history: "History",
};

export function activityViewLabel(view: ViewId): string {
  return LABELS[view];
}

// Every rail glyph is drawn the same size and weight; only the icon differs.
function RailGlyph(props: { Icon: typeof Files }) {
  return <props.Icon size={18} strokeWidth={1.9} aria-hidden />;
}

function RailButton(props: {
  label: string;
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
      ? "bg-line/60 text-ink"
      : props.onClick
        ? "text-subtle hover:bg-line/50 hover:text-ink"
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
      {typeof props.count === "number" ? (
        <span
          data-testid={`${props.testId}-count`}
          className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-ink px-1 text-center text-[10px] font-semibold leading-4 text-bg"
        >
          {/* Clamp at 99+: the right-anchored pill grows leftward, and at
              four glyphs ("999+") it spanned ~36px of the 48px rail and
              detached from its icon. Three glyphs keeps it a corner
              ornament on the icon tile. */}
          {props.count > 99 ? "99+" : props.count}
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
          aria-label={props.label}
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
  onOpenCloud?: () => void;
  onOpenSettings?: () => void;
  notices?: ReactNode;
  viewsDisabled?: boolean;
}) {
  return (
    <nav
      aria-label="Activity bar"
      data-testid="activity-bar"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel pb-2 pt-1"
    >
      {/* The view list scrolls, so enough pinned apps never push the
          Cloud and Settings buttons off the rail. It spans the rail and pads
          its ends, so the clip keeps the active bar, a tile's count, and the
          focus ring, and never scrolls sideways. */}
      <div inert={props.viewsDisabled || undefined} className="flex min-h-0 w-full flex-col items-center gap-1 overflow-y-auto overflow-x-hidden py-1">
        {props.views.map((view) => (
          <RailButton
            key={view}
            testId={`activity-${view}`}
            label={LABELS[view]}
            // The rail reflects a collapsed panel: no active mark while hidden.
            active={props.sidebarVisible && props.activeView === view}
            badge={view === "explorer" && props.hasConflict ? "danger" : undefined}
            count={view === "search" ? props.searchResultCount : undefined}
            onClick={() => props.onSelectView(view)}
            icon={<RailGlyph Icon={ICONS[view]} />}
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
        <RailButton
          testId="activity-cloud"
          label="Sync and sharing"
          badge={props.hasConflict ? "danger" : undefined}
          onClick={props.onOpenCloud}
          icon={<RailGlyph Icon={Cloud} />}
        />
        {props.notices}
        <RailButton
          testId="activity-settings"
          label="Open settings"
          onClick={props.onOpenSettings}
          icon={<RailGlyph Icon={Settings} />}
        />
      </div>
    </nav>
  );
}
