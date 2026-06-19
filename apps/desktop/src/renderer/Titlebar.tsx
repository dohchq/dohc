import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useState } from "react";
import type { WorkspaceSummary } from "../ipc/bridgeContract";
import { TITLEBAR_HEIGHT_PX } from "./tokens";

// Exported: the status bar shows the same name (one derivation, two surfaces).
export function workspaceName(workspace: WorkspaceSummary): string {
  // Separator-agnostic: rootPath is backslash-separated on native Windows.
  return workspace.rootPath.split(/[\\/]/).pop() ?? "workspace";
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
  onSwitchWorkspace?: (workspace: WorkspaceSummary) => void;
  onQuickOpen?: () => void;
}) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // macOS draws traffic lights on the LEFT and never populates the
  // titlebar-area-* env vars (WCO is only enabled on the non-darwin branch of
  // createMainWindow) — lay out around them with fixed insets there, and
  // around the OS window-controls overlay via env() everywhere else.
  const isMac = window.dohcDesktop?.platform === "darwin";

  return (
    <header
      data-testid="titlebar"
      className="titlebar-drag relative flex shrink-0 items-center gap-2 border-b border-line bg-panel-2"
      style={{
        height: TITLEBAR_HEIGHT_PX,
        paddingLeft: isMac ? 80 : "calc(env(titlebar-area-x, 0px) + 12px)",
      }}
    >
      <span
        aria-hidden
        className="text-[13px] font-semibold tracking-tight text-ink"
      >
        dohc
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
              className="absolute left-0 top-full z-20 mt-1 m-0 w-64 list-none rounded-md border border-line bg-panel p-1 shadow-sm"
            >
              {props.workspaces.map((candidate) => (
                <li
                  key={candidate.workspaceId}
                  role="option"
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
          className="titlebar-no-drag absolute left-1/2 top-1/2 flex h-7 w-80 max-w-[min(40vw,100vw_-_560px)] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-md border border-line bg-bg px-2.5 text-[12px] text-subtle hover:text-ink"
        >
          <Search size={12} aria-hidden />
          <span className="truncate">Search files…</span>
          <kbd className="ml-auto font-mono text-[10px]">Ctrl P</kbd>
        </button>
      ) : null}

      {/* Spacer under the OS window controls (minimize/maximize/close);
          macOS has no right-side controls. */}
      <div
        aria-hidden
        className="ml-auto h-full shrink-0"
        style={{
          width: isMac
            ? 12
            : "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 140px)))",
        }}
      />
    </header>
  );
}
