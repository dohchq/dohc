import { AlertTriangle, ChevronRight, CircleDashed, Pin, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { APP_CHECK_FALLBACK_MESSAGE } from "../appCopy";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { IconButton, RetryRow } from "../ui/controls";
import { ObjectGlyph } from "../ui/KindGlyph";
import { useAsyncResponseEffect } from "../useAsyncResponseEffect";
import type { AboutNotices } from "./About";
import { siteTabPath } from "./workbenchState";
import { ipcErrorMessage } from "../ipcError";

export type AppsLoadState =
  | { status: "loading" }
  | { status: "ready"; workspaceId: string; apps: SitePackageInfo[] }
  | { status: "failed"; workspaceId: string };

export interface WorkspaceApps {
  state: AppsLoadState;
  retry: () => void;
}

/** Whether the workspace has an app to show. */
export function hasApps(apps: WorkspaceApps): boolean {
  return apps.state.status === "ready" && apps.state.apps.length > 0;
}

// The workspace's apps, for the Explorer's Apps section and the side panel's
// Add an app here…. Every settled file listing refetches them, so an app an
// agent writes appears by itself. The list stays while that runs; only a
// first load, or another workspace, shows loading. Try again keeps the
// failure on screen until the new answer replaces it. A failed read goes to
// the shell's error hook as one Notices row per workspace, which a later read
// clears.
export function useApps(
  workspaceId: string,
  filesSettledRevision: number,
  notices: AboutNotices,
  enabled: boolean,
): WorkspaceApps {
  const [state, setState] = useState<AppsLoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useAsyncResponseEffect(
    () => (enabled ? bridge().listSites({ workspaceId }) : null),
    {
      onSuccess: (result) => {
        notices.clear(appsIdentity(workspaceId));
        setState({ status: "ready", workspaceId, apps: result.sites });
      },
      onError: (error) => {
        setState({ status: "failed", workspaceId });
        notices.report({
          identity: appsIdentity(workspaceId),
          message: ipcErrorMessage(error, "Could not load apps."),
          cause: error,
          retry,
        });
      },
    },
    [workspaceId, filesSettledRevision, attempt, notices, enabled],
  );

  // The row goes when the workspace closes or changes, so its Try again
  // always reads the workspace on screen.
  useEffect(() => () => notices.clear(appsIdentity(workspaceId)), [notices, workspaceId]);

  return useMemo(
    () => ({
      state:
        state.status !== "loading" && state.workspaceId !== workspaceId
          ? { status: "loading" }
          : state,
      retry,
    }),
    [retry, state, workspaceId],
  );
}

function appsIdentity(workspaceId: string): string {
  return `apps:${workspaceId}`;
}

function appDiagnosticLabel(app: SitePackageInfo): string | null {
  const diagnostic =
    app.diagnostics.find((entry) => entry.severity === "error") ??
    app.diagnostics[0];
  if (!diagnostic) return null;
  const prefix = diagnostic.severity === "error" ? "Error" : "Warning";
  const detail = diagnostic.message || APP_CHECK_FALLBACK_MESSAGE;
  return diagnostic.path ? `${prefix}: ${detail} (${diagnostic.path})` : `${prefix}: ${detail}`;
}

// One app: its glyph and title, then a mark for each fact the app reports,
// then its pin. The row opens the app in a tab, which runs its preview; the
// active tab's app is the selected row. Sized like a Collections row.
function AppRow(props: {
  app: SitePackageInfo;
  pinned: boolean;
  active: boolean;
  onOpenPath: (path: string) => void;
  onSetPinned: (appRoot: string, pinned: boolean) => void;
}) {
  const { app, pinned, active } = props;
  const diagnosticLabel = appDiagnosticLabel(app);
  const pinLabel = pinned ? "Unpin" : "Pin to sidebar";
  return (
    <li
      className={`group flex h-7 items-center rounded-md pr-1 transition-colors duration-75 ${
        active ? "bg-selected font-medium text-ink" : "text-muted hover:bg-hover hover:text-ink"
      }`}
    >
      <button
        type="button"
        data-testid="sites-row"
        data-root={app.root}
        aria-current={active ? "page" : undefined}
        title={app.root}
        onClick={() => props.onOpenPath(siteTabPath(app.root))}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] focus-visible:-outline-offset-2"
      >
        <ObjectGlyph kind="app" size={14} />
        <span className="min-w-0 flex-1 truncate">{app.title}</span>
        {app.authority.kind === "share" ? (
          <span
            data-testid="sites-shared-label"
            role="img"
            aria-label="Shared"
            title="Shared"
            className="shrink-0 text-muted"
          >
            <Users size={13} aria-hidden />
          </span>
        ) : null}
        {diagnosticLabel ? (
          <span
            data-testid="sites-diagnostic-indicator"
            role="img"
            aria-label={diagnosticLabel}
            title={diagnosticLabel}
            className="shrink-0 text-warning"
          >
            <AlertTriangle size={13} aria-hidden />
          </span>
        ) : app.confidence === "low" ? (
          <span
            data-testid="sites-low-confidence"
            role="img"
            aria-label="Low confidence detection"
            title="Low confidence detection"
            className="shrink-0 text-subtle"
          >
            <CircleDashed size={13} aria-hidden />
          </span>
        ) : null}
      </button>
      {/* A pinned app keeps its pin in view; the others show it while the
          row is hovered or holds keyboard focus, not after a click. */}
      <IconButton
        data-testid="sites-pin"
        aria-label={pinLabel}
        title={pinLabel}
        onClick={() => props.onSetPinned(app.root, !pinned)}
        className={`shrink-0 focus-visible:-outline-offset-2 ${
          pinned ? "" : "opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100"
        }`}
      >
        {/* The glyph takes the pinned color: the button's own rest color
            would win over a second color class. */}
        <Pin size={13} aria-hidden className={pinned ? "text-ink" : undefined} />
      </IconButton>
    </li>
  );
}

/** The Apps section's rows, as the Explorer and the states page draw them. */
export function AppRows(props: {
  apps: readonly SitePackageInfo[];
  pinnedApps: readonly string[];
  activePath: string | null;
  onOpenPath: (path: string) => void;
  onSetPinned: (appRoot: string, pinned: boolean) => void;
}) {
  return (
    <ul className="m-0 list-none px-1 py-0">
      {props.apps.map((app) => (
        <AppRow
          key={app.root}
          app={app}
          pinned={props.pinnedApps.includes(app.root)}
          active={props.activePath === siteTabPath(app.root)}
          onOpenPath={props.onOpenPath}
          onSetPinned={props.onSetPinned}
        />
      ))}
    </ul>
  );
}

/** What the shell hands the Explorer for its Apps section. */
export interface ExplorerApps extends WorkspaceApps {
  // Apps pinned to the sidebar in this workspace, by folder.
  pinnedApps: readonly string[];
  onSetPinned: (appRoot: string, pinned: boolean) => void;
  // Add an app here… asks for the section: it opens and its first row takes
  // focus, then onRevealed clears the request.
  reveal: boolean;
  onRevealed: () => void;
}

// The workspace's apps, between Open editors and Collections. A workspace
// with no apps has no section, and neither does a first read still on its
// way, so a header never shows and then goes. A failed read keeps the
// section, with Try again.
export function AppsSection(props: ExplorerApps & {
  // The focused tab, so the app it previews is the selected row.
  activePath: string | null;
  onOpenPath: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const sectionRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const { state, reveal, onRevealed } = props;
  const apps = state.status === "ready" ? state.apps : [];
  const shown = state.status === "failed" || apps.length > 0;
  const settled = state.status !== "loading";

  useEffect(() => {
    if (!reveal) return;
    if (!shown) {
      // Nothing to show once the read answers: drop the request, so it
      // cannot take focus when an app appears later.
      if (settled) onRevealed();
      return;
    }
    if (!expanded) {
      setExpanded(true);
      return;
    }
    const firstRow = sectionRef.current?.querySelector<HTMLElement>('[data-testid="sites-row"]');
    (firstRow ?? toggleRef.current)?.focus();
    onRevealed();
  }, [expanded, onRevealed, reveal, settled, shown]);

  if (!shown) return null;
  return (
    <section ref={sectionRef} data-testid="explorer-apps-section" aria-label="Apps" className="mt-4">
      <header
        data-testid="explorer-apps-header"
        className="group flex h-6 items-center gap-1 pr-1 hover:bg-hover"
      >
        <button
          ref={toggleRef}
          type="button"
          data-testid="explorer-apps-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left dohc-section-label group-hover:text-muted"
        >
          <span className="min-w-0 truncate">Apps</span>
          {apps.length > 0 ? (
            <span
              data-testid="sites-count"
              aria-label={`${apps.length} app${apps.length === 1 ? "" : "s"}`}
              className="rounded bg-line/70 px-1.5 py-0.5 text-[10px] leading-none text-subtle"
            >
              {apps.length}
            </span>
          ) : null}
          <ChevronRight
            size={11}
            aria-hidden
            className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </button>
      </header>

      {!expanded ? null : state.status === "failed" ? (
        <div className="px-1">
          <RetryRow testId="sites-failed" onRetry={props.retry} />
        </div>
      ) : (
        <AppRows
          apps={apps}
          pinnedApps={props.pinnedApps}
          activePath={props.activePath}
          onOpenPath={props.onOpenPath}
          onSetPinned={props.onSetPinned}
        />
      )}
    </section>
  );
}
