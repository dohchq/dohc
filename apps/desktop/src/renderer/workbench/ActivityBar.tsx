import {
  Blocks,
  Cloud,
  Files,
  History,
  Search,
  Settings,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import type { PluginActivityView } from "./pluginActivityViews";
import { PluginIcon } from "./PluginIcon";
import { VIEW_IDS, type ActivityViewId, type ViewId } from "./workbenchState";

// VS Code-style activity bar: 48px icon rail, leftmost column of the
// workbench. Ported a11y/active patterns from the retired web ActivityBar
// (7277c39^): data-table of items, title + aria-label + aria-current on every
// button, active = full-ink icon with a 2px left ink indicator. Clicking the
// active item toggles the side panel (the old explicit collapse button).

const ICONS: Record<ViewId, typeof Files> = {
  explorer: Files,
  search: Search,
  graph: Workflow,
  history: History,
  plugins: Blocks,
};

const LABELS: Record<ViewId, string> = {
  explorer: "Explorer",
  search: "Search",
  graph: "Graph",
  history: "History",
  plugins: "Plugins",
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
  // A node, not a component: dohc's views draw a lucide glyph and a plugin's
  // view draws its own icon file.
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
      {props.active ? (
        <span
          aria-hidden
          className="absolute -left-1.5 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-ink"
        />
      ) : null}
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
          className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-ink px-1 text-center text-[9px] font-semibold leading-[14px] text-bg"
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
  return props.onClick ? (
    <button
      type="button"
      data-testid={props.testId}
      title={props.label}
      aria-label={props.label}
      aria-current={props.active ? "page" : undefined}
      onClick={props.onClick}
      className={className}
    >
      {content}
    </button>
  ) : (
    <span data-testid={props.testId} aria-hidden="true" className={className}>
      {content}
    </span>
  );
}

export function ActivityBar(props: {
  workspaceId: string;
  activeView: ActivityViewId;
  sidebarVisible: boolean;
  hasConflict: boolean;
  // Content-search results count (Phase E5.0); undefined = no badge.
  searchResultCount?: number;
  // The views plugins contribute, after dohc's own. A plugin that is gone or
  // turned off contributes none, so its button leaves the rail with it.
  pluginViews: readonly PluginActivityView[];
  onSelectView: (view: ActivityViewId) => void;
  onOpenCloud?: () => void;
  onOpenSettings?: () => void;
}) {
  return (
    <nav
      aria-label="Activity bar"
      data-testid="activity-bar"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2"
    >
      {/* The view list scrolls, so enough contributed views never push the
          Cloud and Settings buttons off the rail. */}
      <div className="flex min-h-0 flex-col items-center gap-1 overflow-y-auto">
        {VIEW_IDS.map((view) => (
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
        {props.pluginViews.map((view) => (
          <RailButton
            key={view.viewId}
            testId={`activity-${view.viewId}`}
            label={view.title}
            active={props.sidebarVisible && props.activeView === view.viewId}
            onClick={() => props.onSelectView(view.viewId)}
            icon={
              <PluginIcon
                workspaceId={props.workspaceId}
                plugin={view.plugin}
                icon={view.icon}
                glyphSize={18}
                className="grid size-[18px] place-items-center"
              />
            }
          />
        ))}
      </div>
      <div className="mt-auto flex flex-col items-center gap-1 border-t border-line pt-2">
        {/* Labels deliberately differ from the status bar's "Connect dohc
            Cloud" button and "Settings" button — several specs pin those
            accessible names and must keep matching exactly one element. */}
        <RailButton
          testId="activity-cloud"
          label="dohc Cloud"
          badge={props.hasConflict ? "danger" : undefined}
          onClick={props.onOpenCloud}
          icon={<RailGlyph Icon={Cloud} />}
        />
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
