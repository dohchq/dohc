import { MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Workspace } from "./DesktopWorkspaceShell";
import { displayPath } from "./NewWorkspaceCard";
import { workspaceName } from "./Titlebar";

// One workspace drawn as a folder. The tab is the name; the sheet is where
// it lives and what is going on in it. Shared folders get a darker tab and
// the people in them. The whole folder opens the workspace; the dots open
// the row menu.

// Coarse and honest: minutes, hours, days, then a date. Recomputed on each
// render, which is every time the manager shows.
export function openedAgo(atMs: number | undefined, nowMs = Date.now()): string {
  if (atMs === undefined) return "Never opened here";
  const minutes = Math.floor(Math.max(0, nowMs - atMs) / 60_000);
  if (minutes < 1) return "Opened just now";
  if (minutes < 60) return `Opened ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Opened ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Opened yesterday";
  if (days < 7) return `Opened ${days} days ago`;
  return `Opened ${new Date(atMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : local.slice(0, 2);
  return letters.toUpperCase();
}

// What the dot and the first body line say. Only facts the summary carries.
function status(workspace: Workspace): { dot: "sync" | null; line: string } {
  if (workspace.shareView) {
    const who = workspace.shareView.granterEmail;
    return {
      dot: workspace.shareView.ended ? null : "sync",
      line: who ? `Shared by ${who.split("@")[0]}` : "Shared with you",
    };
  }
  if (workspace.synced) return { dot: "sync", line: "Synced" };
  return { dot: null, line: "Local only" };
}

export function WorkspaceFolder(props: {
  workspace: Workspace;
  current: boolean;
  onOpen: () => void;
  onReveal: () => void;
  onForget: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const name = workspaceName(props.workspace);
  const shared = props.workspace.shareView !== undefined;
  const { dot, line } = status(props.workspace);
  const people = shared
    ? [props.workspace.shareView?.granterEmail].filter((email): email is string => !!email)
    : [];

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const tabFill = shared ? "bg-panel-2 border-b-panel-2" : "bg-panel border-b-panel";

  return (
    <li
      data-testid="workspace-manager-row"
      data-workspace-id={props.workspace.workspaceId}
      className="group relative flex list-none flex-col"
    >
      {/* The sheet's top-left corner is square so the tab sits on it, and
          the tab's bottom edge matches the sheet fill to hide the seam. */}
      <button
        type="button"
        onClick={props.onOpen}
        aria-label={`Open ${name}`}
        aria-current={props.current ? "true" : undefined}
        className="flex w-full flex-col text-left"
      >
        <span
          className={`relative z-10 -mb-px flex h-8 max-w-[82%] items-center gap-2 rounded-t-lg border border-line px-3.5 text-[13px] font-semibold text-ink group-hover:border-ink group-hover:border-b-panel ${tabFill}`}
        >
          <span className="truncate">{name}</span>
          {dot ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" /> : null}
        </span>
        <span
          className={`flex min-h-24 w-full flex-col gap-2.5 rounded-xl rounded-tl-none border bg-panel p-3.5 transition-colors group-hover:border-ink ${
            props.current ? "border-ink" : "border-line"
          }`}
        >
          <span className="truncate font-mono text-[11px] leading-4 text-subtle">
            {displayPath(props.workspace.rootPath)}
          </span>
          <span className="mt-auto flex flex-col gap-0.5 pr-7">
            <span className="flex items-center gap-1.5 text-[11px] text-muted">
              {people.length > 0 ? (
                <span className="flex items-center gap-1">
                  {people.map((email) => (
                    <span
                      key={email}
                      aria-hidden
                      className="grid size-4 place-items-center rounded-full border border-line bg-bg font-mono text-[8px] text-muted"
                    >
                      {initials(email)}
                    </span>
                  ))}
                </span>
              ) : null}
              <span className="truncate">{line}</span>
            </span>
            <span className="text-[11px] text-subtle">{openedAgo(props.workspace.lastOpenedAt)}</span>
          </span>
        </span>
      </button>

      <div ref={menuRef} className="absolute bottom-2.5 right-2.5 z-10">
        <button
          type="button"
          aria-label={`More for ${name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          className={`grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink ${
            menuOpen ? "text-ink" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          }`}
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
        {menuOpen ? (
          <div
            role="menu"
            className="dohc-popover dohc-pop-in absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-line bg-panel p-1"
          >
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                props.onReveal();
              }}
            >
              Reveal in folder
            </MenuItem>
            <MenuItem
              danger
              onClick={() => {
                setMenuOpen(false);
                props.onForget();
              }}
            >
              Forget
            </MenuItem>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function MenuItem(props: { onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      className={`flex h-7 w-full items-center rounded px-2 text-left text-[13px] text-muted hover:bg-panel-2 ${
        props.danger ? "hover:text-danger" : "hover:text-ink"
      }`}
    >
      {props.children}
    </button>
  );
}

// The dashed folder-to-be at the end of the row.
export function NewWorkspaceFolder(props: { onClick: () => void }) {
  return (
    <li className="flex list-none flex-col">
      <button
        type="button"
        data-testid="workspace-manager-new"
        onClick={props.onClick}
        className="group flex w-full flex-col text-left"
      >
        <span className="relative z-10 -mb-px flex h-8 items-center rounded-t-lg border border-dashed border-line border-b-bg bg-bg px-3.5 text-[13px] font-medium text-muted group-hover:border-ink group-hover:border-b-bg group-hover:text-ink">
          New workspace
        </span>
        <span className="flex min-h-24 w-full flex-col items-center justify-center gap-2 rounded-xl rounded-tl-none border border-dashed border-line p-3.5 text-muted group-hover:border-ink group-hover:text-ink">
          <span className="grid size-7 place-items-center rounded-full border border-line">
            <Plus size={13} strokeWidth={1.9} aria-hidden />
          </span>
          <span className="text-[13px]">Create</span>
        </span>
      </button>
    </li>
  );
}
