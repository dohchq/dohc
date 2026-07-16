import { DohcMark } from "@dohc/brand";
import { Check, ChevronsUpDown, PanelLeft, PanelRight, Search } from "lucide-react";
import { useState } from "react";
import type { WorkspaceSummary } from "../ipc/bridgeContract";
import { TITLEBAR_HEIGHT_PX } from "./tokens";

// Exported: the status bar shows the same name (one derivation, two surfaces).
export function workspaceName(workspace: WorkspaceSummary): string {
  // Separator-agnostic: rootPath is backslash-separated on native Windows.
  return workspace.rootPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "workspace";
}

type TitlebarPanelToggle = {
  visible: boolean;
  onToggle: () => void;
};

function LayoutToggle(props: {
  label: string;
  testId: string;
  pressed: boolean;
  onClick: () => void;
  Icon: typeof PanelLeft;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.label}
      onClick={props.onClick}
      className={`titlebar-no-drag grid size-7 place-items-center rounded-md transition-colors active:translate-y-px ${
        props.pressed
          ? "bg-line/70 text-ink"
          : "text-subtle hover:bg-line/50 hover:text-ink"
      }`}
    >
      <props.Icon size={15} strokeWidth={1.8} aria-hidden />
    </button>
  );
}

// Custom titlebar: a drag strip under the hidden OS titlebar, sized by the
// SAME constant the titleBarOverlay uses so they can never disagree. Every
// interactive child opts out of dragging (titlebar-no-drag). The right spacer
// reserves room for the OS window-control overlay via env(titlebar-area-*)
// where the platform provides it, falling back to 140px (three controls).
// First-run mounts it without props — just the glyph and the drag region.
export function Titlebar(props: {
  workspace?: WorkspaceSummary;
  workspaces?: WorkspaceSummary[];
  onOpenShare?: () => void;
  onSwitchWorkspace?: (workspace: WorkspaceSummary) => void;
  onQuickOpen?: () => void;
  primarySidebar?: TitlebarPanelToggle;
  chatsSidebar?: TitlebarPanelToggle;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // macOS draws traffic lights on the LEFT and never populates the
  // titlebar-area-* env vars (WCO is only enabled on the non-darwin branch of
  // createMainWindow) — lay out around them with fixed insets there, and
  // around the OS window-controls overlay via env() everywhere else.
  const isMac = window.dohcDesktop?.platform === "darwin";
  const quickOpenShortcut = isMac ? "⌘P" : "Ctrl P";

  return (
    <header
      data-testid="titlebar"
      className="titlebar-drag relative flex shrink-0 items-center gap-2 border-b border-line bg-panel-2"
      style={{
        height: TITLEBAR_HEIGHT_PX,
        paddingLeft: isMac ? 80 : "calc(env(titlebar-area-x, 0px) + 12px)",
      }}
    >
      <span aria-hidden className="flex items-center gap-1.5 text-ink">
        <DohcMark size={14} className="shrink-0" />
        <span className="text-[13px] font-semibold tracking-tight">dohc</span>
      </span>

      {props.workspace && props.workspaces && props.onSwitchWorkspace ? (
        <div className="titlebar-no-drag relative">
          <button
            type="button"
            data-testid="workspace-switcher"
            aria-haspopup="listbox"
            aria-expanded={switcherOpen}
            onClick={() => setSwitcherOpen((open) => !open)}
            className="titlebar-no-drag flex h-7 items-center gap-1.5 rounded px-2 text-[13px] text-muted hover:bg-line/50 hover:text-ink"
          >
            <span className="max-w-48 truncate">
              {workspaceName(props.workspace)}
            </span>
            <ChevronsUpDown size={13} aria-hidden className="text-subtle" />
          </button>
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
                    className="titlebar-no-drag flex h-7 w-full items-center gap-1.5 rounded px-2 text-left text-[13px] text-muted hover:bg-panel-2 hover:text-ink"
                  >
                    {candidate.workspaceId === props.workspace?.workspaceId ? (
                      <Check size={12} aria-hidden />
                    ) : (
                      <span className="w-3" aria-hidden />
                    )}
                    <span className="truncate">{workspaceName(candidate)}</span>
                    <span className="ml-auto text-[10px] uppercase text-subtle">
                      {candidate.kind}
                    </span>
                  </button>
                </li>
              ))}
              {props.onOpenShare ? (
                <li role="presentation" className="mt-1 border-t border-line pt-1">
                  <button
                    type="button"
                    data-testid="workspace-switcher-open-share"
                    onClick={() => {
                      setSwitcherOpen(false);
                      props.onOpenShare?.();
                    }}
                    className="titlebar-no-drag flex h-7 w-full items-center gap-1.5 rounded px-2 text-left text-[13px] text-muted hover:bg-panel-2 hover:text-ink"
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

      {/* Window-centered (absolute, like VS Code's command center) — flex
          centering would drift with the workspace-name width. The max-width
          clamp keeps it clear of the left group and the window controls at
          the minimum window width. */}
      {props.onQuickOpen ? (
        <button
          type="button"
          data-testid="titlebar-quick-open"
          onClick={props.onQuickOpen}
          className="titlebar-no-drag absolute left-1/2 top-1/2 flex h-7 w-80 max-w-[min(40vw,100vw_-_640px)] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 text-[12px] text-subtle hover:text-ink"
        >
          <Search size={12} aria-hidden />
          <span className="truncate">Search files…</span>
          <kbd className="ml-auto font-mono text-[10px]">{quickOpenShortcut}</kbd>
        </button>
      ) : null}

      {props.primarySidebar || props.chatsSidebar ? (
        <div
          data-testid="titlebar-layout-controls"
          role="group"
          aria-label="Layout controls"
          className="titlebar-no-drag ml-auto flex shrink-0 items-center gap-0.5"
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
          {props.chatsSidebar ? (
            <LayoutToggle
              testId="titlebar-chats-sidebar"
              label="Toggle chats sidebar"
              pressed={props.chatsSidebar.visible}
              onClick={props.chatsSidebar.onToggle}
              Icon={PanelRight}
            />
          ) : null}
        </div>
      ) : null}

      {/* Spacer under the OS window controls (minimize/maximize/close);
          macOS has no right-side controls. */}
      <div
        aria-hidden
        className={`${
          props.primarySidebar || props.chatsSidebar ? "ml-2" : "ml-auto"
        } h-full shrink-0`}
        style={{
          width: isMac
            ? 12
            : "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 140px)))",
        }}
      />
    </header>
  );
}
