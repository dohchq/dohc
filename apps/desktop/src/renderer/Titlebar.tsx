import { shortcutText } from "../shortcuts/shortcutRegistry";
import { desktopPins } from "../testPins";
import { DohcMark } from "@dohc/brand";
import { Check, PanelLeft, PanelRight, Search } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import type { WorkspaceSummary } from "../ipc/bridgeContract";
import { TITLEBAR_HEIGHT_PX } from "./tokens";
import { Pill } from "./ui/controls";
import { useDismiss } from "./ui/useDismiss";
import { useWindowFullScreen } from "./windowFullScreen";

// Workspace labels use the final folder name on either platform.
export function workspaceName(workspace: Pick<WorkspaceSummary, "rootPath">): string {
  // Separator-agnostic: rootPath is backslash-separated on native Windows.
  return workspace.rootPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "workspace";
}

type TitlebarPanelToggle = {
  visible: boolean;
  onToggle: () => void;
};

// Shared by centered quick-open and the left group's available width. Below
// 1100px, where the names would start to cut, quick-open narrows to its icon
// and shortcut; the header sets the width for both.
const QUICK_OPEN_WIDTH = "var(--quick-open-width)";
// Centered, unless the names at their floors reach it: then it starts 12px
// after them, as the left group ends 12px before it. Its right edge stays,
// so it gives up width, and its word, before it moves right.
const QUICK_OPEN_LEFT = `max(50% - ${QUICK_OPEN_WIDTH} / 2, anchor(--titlebar-names-end right, 0px) + 12px)`;
const QUICK_OPEN_MIN_WIDTH = "5rem";
const QUICK_OPEN_END = `max(50% + ${QUICK_OPEN_WIDTH} / 2, ${QUICK_OPEN_LEFT} + ${QUICK_OPEN_MIN_WIDTH})`;

function LayoutToggle(props: {
  label: string;
  testId: string;
  pressed: boolean;
  onClick: () => void;
  Icon: typeof PanelLeft;
  agentActive?: boolean;
}) {
  const statusId = useId();
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        data-testid={props.testId}
        aria-label={props.label}
        aria-pressed={props.pressed}
        aria-describedby={props.agentActive ? statusId : undefined}
        title={props.agentActive ? `${props.label}: Agent running` : props.label}
        onClick={props.onClick}
        className={`titlebar-no-drag relative grid size-7 place-items-center rounded-md transition-colors active:translate-y-px ${
          props.pressed
            ? "bg-selected text-ink"
            : "text-subtle hover:bg-hover hover:text-ink"
        }`}
      >
        <props.Icon size={15} strokeWidth={1.8} aria-hidden />
      </button>
      {props.agentActive ? (
        <span
          id={statusId}
          data-testid="agent-run-indicator"
          role="status"
          aria-label="Agent running"
          className="pointer-events-none absolute right-0.5 top-0.5 size-1.5 rounded-full bg-agent"
        ><span className="sr-only">Agent running</span></span>
      ) : null}
    </span>
  );
}

// Custom titlebar: a drag strip under the hidden OS titlebar, sized by the
// same constant the titleBarOverlay uses so they can never disagree. Every
// interactive child opts out of dragging (titlebar-no-drag). The right spacer
// reserves room for the OS window-control overlay via env(titlebar-area-*)
// where the platform provides it, falling back to 140px (three controls).
// First-run mounts it without props — just the glyph and the drag region.
export function Titlebar(props: {
  workspace?: WorkspaceSummary;
  workspaces?: WorkspaceSummary[];
  onOpenShare?: () => void;
  onManageWorkspaces?: () => void;
  onSwitchWorkspace?: (workspace: WorkspaceSummary) => void;
  onQuickOpen?: () => void;
  primarySidebar?: TitlebarPanelToggle;
  aboutSidebar?: TitlebarPanelToggle;
  // The version breadcrumb after the workspace name, when versions are on.
  version?: ReactNode;
  workspaceStatus?: ReactNode;
  onWorkspaceContextMenu?: () => void;
  agentActive?: boolean;
  // The update button, just left of the layout toggles.
  update?: ReactNode;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement | null>(null);
  const switcherTriggerRef = useRef<HTMLButtonElement | null>(null);
  useDismiss({
    open: switcherOpen,
    container: switcherRef,
    trigger: switcherTriggerRef,
    onClose: () => setSwitcherOpen(false),
  });
  // macOS draws traffic lights on the left and never populates the
  // titlebar-area-* env vars (WCO is only enabled on the non-darwin branch of
  // createMainWindow) — lay out around them with fixed insets there, and
  // around the OS window-controls overlay via env() everywhere else. On
  // macOS 26 and later the lights end 76pt from the left edge, so the mark
  // starts 12px after them; full screen hides them.
  const isMac = window.dohcDesktop?.platform === "darwin";
  const fullScreen = useWindowFullScreen();
  const quickOpenShortcut = shortcutText("quick-open", window.dohcDesktop?.platform);
  const leftInset = isMac
    ? fullScreen ? "12px" : "88px"
    : "calc(env(titlebar-area-x, 0px) + 12px)";
  const rightInset = isMac
    ? "12px"
    : "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 140px)))";
  const hasRightGroup = props.update !== undefined || props.primarySidebar !== undefined || props.aboutSidebar !== undefined;

  return (
    <header
      data-testid={desktopPins.titlebar}
      className="titlebar-drag relative flex shrink-0 items-center gap-2 border-b border-line bg-panel [--quick-open-width:20rem] [anchor-scope:--titlebar-names-end] max-[1100px]:[--quick-open-width:5rem]"
      style={{ height: TITLEBAR_HEIGHT_PX, paddingLeft: leftInset }}
    >
      {/* Reserve space for centered quick-open. */}
      <div
        data-testid="titlebar-left-group"
        className="flex min-w-0 items-center gap-2"
        style={{ maxWidth: `calc(50vw - ${QUICK_OPEN_WIDTH} / 2 - ${leftInset} - 12px)` }}
      >
        {/* The product word only before a workspace is open; after that the
            workspace's own name says where the person is. */}
        <span aria-hidden className="flex shrink-0 items-center gap-1.5 text-ink">
          <DohcMark size={15} className="shrink-0" />
          {props.workspace ? null : <span className="text-[13px] font-semibold tracking-tight">dohc</span>}
        </span>
        {/* Every nightly is an alpha, so the build says so beside the mark. */}
        {window.dohcDesktop?.releaseChannel === "nightly" ? (
          <span data-testid="titlebar-alpha" className="shrink-0"><Pill>Alpha</Pill></span>
        ) : null}

        {props.workspace && props.workspaces && props.onSwitchWorkspace ? (
          <div
            ref={switcherRef}
            className="titlebar-no-drag relative flex min-w-0 items-center gap-0.5"
            onContextMenu={props.onWorkspaceContextMenu ? (event) => {
              event.preventDefault();
              props.onWorkspaceContextMenu?.();
            } : undefined}
          >
            <button
              ref={switcherTriggerRef}
              type="button"
              data-testid="workspace-switcher"
              aria-haspopup="listbox"
              aria-expanded={switcherOpen}
              title={workspaceName(props.workspace)}
              onClick={() => setSwitcherOpen((open) => !open)}
              // Each name keeps its padding and three letters with an
              // ellipsis, or all of it when shorter.
              className="titlebar-no-drag flex h-7 min-w-[calc-size(max-content,min(size,4rem))] items-center rounded-md px-2 text-[13px] font-medium text-ink hover:bg-hover"
            >
              {/* Truncate the name before the version and the saved dot. */}
              <span data-testid="status-workspace" className="min-w-0 max-w-48 truncate">
                {workspaceName(props.workspace)}
              </span>
            </button>
            {/* The slash belongs to the version, so it shows only once the
                picker has a version to name. Its floor holds the slash, the
                version's icons and three letters with an ellipsis. */}
            {props.version ? (
              <span className="flex min-w-[calc-size(max-content,min(size,7.5rem))] items-center gap-0.5 empty:hidden before:text-[13px] before:text-subtle before:content-['/']">
                {props.version}
              </span>
            ) : null}
            {props.workspaceStatus}
            {/* Where the names and their status end, past the group's edge
                when their floors overflow it. Go to… stays clear of it. */}
            <span aria-hidden className="-ml-0.5 w-0 self-stretch [anchor-name:--titlebar-names-end]" />
            {switcherOpen ? (
              <ul
                role="listbox"
                aria-label="Workspaces"
                className="dohc-popover dohc-pop-in absolute left-0 top-full z-20 mt-1 m-0 w-64 list-none rounded-lg border border-line bg-panel p-1"
              >
                {props.workspaces.map((candidate) => (
                  <li
                    key={candidate.workspaceId}
                    role="option"
                    data-testid="workspace-switcher-option"
                    data-workspace-id={candidate.workspaceId}
                    aria-selected={
                      candidate.workspaceId === props.workspace?.workspaceId
                    }
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSwitcherOpen(false);
                        props.onSwitchWorkspace?.(candidate);
                      }}
                      className="titlebar-no-drag flex h-7 w-full items-center gap-1.5 rounded px-2 text-left text-[13px] text-muted hover:bg-hover hover:text-ink"
                    >
                      {candidate.workspaceId === props.workspace?.workspaceId ? (
                        <Check size={12} aria-hidden />
                      ) : (
                        <span className="w-3" aria-hidden />
                      )}
                      <span className="truncate">{workspaceName(candidate)}</span>
                      {candidate.kind === "shared" ? (
                        <span className="ml-auto text-[12px] text-subtle">Shared</span>
                      ) : null}
                    </button>
                  </li>
                ))}
                {props.onManageWorkspaces ? (
                  <li role="presentation" className="mt-1 border-t border-line pt-1">
                    <button
                      type="button"
                      data-testid="workspace-switcher-manage"
                      onClick={() => {
                        setSwitcherOpen(false);
                        props.onManageWorkspaces?.();
                      }}
                      className="titlebar-no-drag flex h-7 w-full items-center gap-1.5 rounded px-2 text-left text-[13px] text-muted hover:bg-hover hover:text-ink"
                    >
                      <span className="w-3" aria-hidden />
                      <span className="truncate">Manage workspaces…</span>
                    </button>
                  </li>
                ) : null}
                {props.onOpenShare ? (
                  <li role="presentation">
                    <button
                      type="button"
                      data-testid="workspace-switcher-open-share"
                      onClick={() => {
                        setSwitcherOpen(false);
                        props.onOpenShare?.();
                      }}
                      className="titlebar-no-drag flex h-7 w-full items-center gap-1.5 rounded px-2 text-left text-[13px] text-muted hover:bg-hover hover:text-ink"
                    >
                      <span className="w-3" aria-hidden />
                      <span className="truncate">Open a share…</span>
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      {props.onQuickOpen ? (
        <button
          type="button"
          data-testid="titlebar-quick-open"
          title="Go to…"
          onClick={props.onQuickOpen}
          style={{ left: QUICK_OPEN_LEFT, right: `calc(50% - ${QUICK_OPEN_WIDTH} / 2)`, minWidth: QUICK_OPEN_MIN_WIDTH }}
          className="@container titlebar-no-drag absolute top-1/2 flex h-7 -translate-y-1/2 items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 text-[12px] text-subtle hover:text-ink"
        >
          <Search size={12} aria-hidden className="shrink-0" />
          <span className="truncate @max-[8.5rem]:sr-only">Go to…</span>
          <kbd className="ml-auto whitespace-nowrap font-sans text-[11px]">{quickOpenShortcut}</kbd>
        </button>
      ) : null}

      {/* Starts 12px after quick-open, wherever the names put it, and ends
          16px before the window controls, as it would in the row. Buttons
          that can't fit run toward the window controls, not over quick-open. */}
      {hasRightGroup ? (
        <div
          data-testid="titlebar-right-group"
          className={`flex items-center justify-end-safe gap-2 ${props.onQuickOpen ? "absolute inset-y-0" : "ml-auto flex-1"}`}
          style={props.onQuickOpen
            ? { left: `calc(${QUICK_OPEN_END} + 12px)`, right: `calc(${rightInset} + 16px)` }
            : undefined}
        >
          {/* The button's own box: its width decides whether the label fits. */}
          {props.update ? <div className="@container flex min-w-7 flex-1 justify-end">{props.update}</div> : null}
          {props.primarySidebar || props.aboutSidebar ? (
            <div
              data-testid="titlebar-layout-controls"
              role="group"
              aria-label="Layout controls"
              className="titlebar-no-drag flex shrink-0 items-center gap-0.5"
            >
              {props.primarySidebar ? (
                <LayoutToggle
                  testId="titlebar-primary-sidebar"
                  label="Toggle primary sidebar"
                  pressed={props.primarySidebar.visible}
                  onClick={props.primarySidebar.onToggle}
                  Icon={PanelLeft}
                />
              ) : null}
              {props.aboutSidebar ? (
                <LayoutToggle
                  testId={desktopPins.titlebarAboutSidebar}
                  label="Toggle About"
                  pressed={props.aboutSidebar.visible}
                  onClick={props.aboutSidebar.onToggle}
                  Icon={PanelRight}
                  agentActive={props.agentActive}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Spacer under the OS window controls (minimize/maximize/close);
          macOS has no right-side controls. */}
      <div
        aria-hidden
        className={`${hasRightGroup && !props.onQuickOpen ? "ml-2" : "ml-auto"} h-full shrink-0`}
        style={{ width: rightInset }}
      />
    </header>
  );
}
