import {
  Cloud,
  Files,
  Globe2,
  History,
  MessagesSquare,
  Search,
  Settings,
  Workflow,
} from "lucide-react";
import { Fragment } from "react";
import { VIEW_IDS, type ViewId } from "./workbenchState";

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
  sites: "Sites",
  history: "History",
};

export function activityViewLabel(view: ViewId): string {
  return LABELS[view];
}

function RailButton(props: {
  label: string;
  testId: string;
  active?: boolean;
  // Toggle buttons (the Chats panel) speak aria-pressed instead of the
  // view buttons' aria-current — a panel is shown/hidden, not navigated to.
  pressed?: boolean;
  // Badge dot seam (conflicts, running agent — more arrive in later phases).
  badge?: "danger" | "success";
  // Numeric badge seam (Phase E5.0: search results count while showing).
  count?: number;
  onClick: () => void;
  Icon: typeof Files;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      title={props.label}
      aria-label={props.label}
      aria-current={props.active ? "page" : undefined}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className={`relative grid size-9 place-items-center rounded-lg transition-colors duration-100 ${
        props.active || props.pressed
          ? "bg-line/60 text-ink"
          : "text-subtle hover:bg-line/50 hover:text-ink"
      }`}
    >
      {props.active ? (
        <span
          aria-hidden
          className="absolute -left-1.5 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-ink"
        />
      ) : null}
      <props.Icon size={18} strokeWidth={1.9} aria-hidden />
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
    </button>
  );
}

export function ActivityBar(props: {
  activeView: ViewId;
  sidebarVisible: boolean;
  hasConflict: boolean;
  // Content-search results count (Phase E5.0); undefined = no badge.
  searchResultCount?: number;
  // The right-hand Chats panel toggle. Chats exists only for
  // workspace-engine-flagged workspaces; absent = no Chats entry at all.
  chats?: { visible: boolean; onToggle: () => void };
  onSelectView: (view: ViewId) => void;
  onOpenCloud: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <nav
      aria-label="Activity bar"
      data-testid="activity-bar"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2"
    >
      {VIEW_IDS.map((view) => (
        <Fragment key={view}>
          {/* Chats keeps its old slot (after Search) but toggles the RIGHT
              panel — it is not a side-panel view. */}
          {view === "graph" && props.chats ? (
            <RailButton
              testId="activity-chats"
              label="Chats"
              pressed={props.chats.visible}
              onClick={props.chats.onToggle}
              Icon={MessagesSquare}
            />
          ) : null}
          <RailButton
            testId={`activity-${view}`}
            label={LABELS[view]}
            // The rail reflects a collapsed panel: no active mark while hidden.
            active={props.sidebarVisible && props.activeView === view}
            badge={view === "explorer" && props.hasConflict ? "danger" : undefined}
            count={view === "search" ? props.searchResultCount : undefined}
            onClick={() => props.onSelectView(view)}
            Icon={ICONS[view]}
          />
        </Fragment>
      ))}
      <div className="mt-auto flex flex-col items-center gap-1 border-t border-line pt-2">
        {/* Labels deliberately differ from the status bar's "Connect dohc
            Cloud" button and "Settings" button — several specs pin those
            accessible names and must keep matching exactly one element. */}
        <RailButton
          testId="activity-cloud"
          label="dohc Cloud"
          badge={props.hasConflict ? "danger" : undefined}
          onClick={props.onOpenCloud}
          Icon={Cloud}
        />
        <RailButton
          testId="activity-settings"
          label="Open settings"
          onClick={props.onOpenSettings}
          Icon={Settings}
        />
      </div>
    </nav>
  );
}
