import {
  AlertTriangle,
  CircleDashed,
  Globe2,
  Pin,
  Plus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { APP_CHECK_FALLBACK_MESSAGE } from "../appCopy";
import type { SitePackageInfo } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { EmptyState, IconButton, PrimaryButton, RetryRow } from "../ui/controls";
import { ObjectGlyph } from "../ui/KindGlyph";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useAsyncResponseEffect } from "../useAsyncResponseEffect";
import type { AboutNotices } from "./About";
import { siteTabPath } from "./workbenchState";
import { ipcErrorMessage } from "../ipcError";

type AppsLoadState =
  | { status: "loading" }
  | { status: "ready"; workspaceId: string; apps: SitePackageInfo[] }
  | { status: "failed"; workspaceId: string };

// Every settled file listing refetches the apps. The list and its count stay
// on screen while that runs; only a first load, or another workspace, shows
// loading. A failed read goes to the shell's error hook as one Notices row
// per workspace, which a later read clears.
function useApps(
  workspaceId: string,
  filesSettledRevision: number,
  notices: AboutNotices,
): { state: AppsLoadState; retry: () => void } {
  const [state, setState] = useState<AppsLoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
  }, []);

  useAsyncResponseEffect(
    () => bridge().listSites({ workspaceId }),
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
    [workspaceId, filesSettledRevision, attempt, notices],
  );

  // The row goes when the view closes or the workspace changes, so its Try
  // again always reads the shelf on screen.
  useEffect(() => () => notices.clear(appsIdentity(workspaceId)), [notices, workspaceId]);

  return {
    state:
      state.status !== "loading" && state.workspaceId !== workspaceId
        ? { status: "loading" }
        : state,
    retry,
  };
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

// One app on the shelf: its glyph, title and folder, then a mark for each
// fact the app reports, then its pin. The row opens the app in a tab, which
// runs its preview; the active tab's app is the selected row.
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
      className={`group flex items-center gap-1 rounded-md pr-1.5 transition-colors duration-75 ${
        active ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      <button
        type="button"
        data-testid="sites-row"
        data-root={app.root}
        aria-current={active ? "page" : undefined}
        onClick={() => props.onOpenPath(siteTabPath(app.root))}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1.5 pl-2 text-left focus-visible:-outline-offset-2"
      >
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-md ${
            active ? "bg-bg text-ink" : "bg-panel-2 text-muted"
          }`}
        >
          <ObjectGlyph kind="app" size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{app.title}</span>
          <span className="block truncate text-[11px] leading-[1.4] text-subtle">
            {app.root}
          </span>
        </span>
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
        className={`shrink-0 ${
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

/** The shelf's rows, as the Apps view and the states page draw them. */
export function AppRows(props: {
  apps: readonly SitePackageInfo[];
  pinnedApps: readonly string[];
  activePath: string | null;
  onOpenPath: (path: string) => void;
  onSetPinned: (appRoot: string, pinned: boolean) => void;
}) {
  return (
    <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto p-1">
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

export function AppsView(props: {
  workspaceId: string;
  // Bumped once per settled workspace file listing — including a
  // content-only edit to an existing file (e.g. dohc.json, package.json),
  // not just an add/remove. A structural hash over path/kind/icon alone
  // produces the same value for a content edit, so the effect would never
  // rerun and the Apps view would keep stale titles, diagnostics,
  // scripts, and preview modes until the user manually refreshed it.
  filesSettledRevision: number;
  // The side panel's header, where the count and the create button sit
  // beside the panel's own actions. Null until the header has mounted.
  head: HTMLElement | null;
  // The focused tab, so the app it previews is the selected row.
  activePath: string | null;
  // Apps pinned to the sidebar in this workspace, by folder.
  pinnedApps: readonly string[];
  onSetPinned: (appRoot: string, pinned: boolean) => void;
  onOpenPath: (path: string) => void;
  onCreateFirstApp: () => Promise<void>;
  notices: AboutNotices;
  // A received share workspace rejects folder creation in main, including
  // for edit grants. Mounted shares inside a normal workspace do not set it.
  receivedShareWorkspace?: boolean;
}) {
  const { state, retry } = useApps(props.workspaceId, props.filesSettledRevision, props.notices);
  const apps = state.status === "ready" ? state.apps : [];
  const [creating, setCreating] = useState(false);

  const createFirstApp = async () => {
    if (creating || props.receivedShareWorkspace) return;
    setCreating(true);
    try {
      await props.onCreateFirstApp();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div data-testid="sites-view" className="flex min-h-0 flex-1 flex-col">
      {props.head
        ? createPortal(
            <>
              <output data-testid="sites-count" className="mr-1 text-[11px] text-subtle">
                {state.status === "ready" ? `${apps.length} app${apps.length === 1 ? "" : "s"}` : null}
              </output>
              {state.status === "ready" && apps.length > 0 && !props.receivedShareWorkspace ? (
                <IconButton
                  data-testid="sites-create"
                  aria-label="Create app"
                  title="Create app"
                  disabled={creating}
                  onClick={() => void createFirstApp()}
                >
                  <Plus size={13} aria-hidden />
                </IconButton>
              ) : null}
            </>,
            props.head,
          )
        : null}

      {state.status === "loading" ? (
        <SkeletonRows inSlot layout="panel" label="Loading apps…" />
      ) : state.status === "failed" ? (
        <div className="p-1">
          <RetryRow testId="sites-failed" onRetry={retry} />
        </div>
      ) : apps.length === 0 ? (
        props.receivedShareWorkspace ? (
          <EmptyState
            icon={Globe2}
            title="No apps in this workspace yet."
            hint="This shared view cannot create an app. Ask the workspace owner to add one."
          />
        ) : (
          <EmptyState icon={Globe2} title="No apps in this workspace yet.">
            <PrimaryButton
              data-testid="sites-create-first"
              disabled={creating}
              onClick={() => void createFirstApp()}
            >
              {creating ? "Creating app…" : "Create app"}
            </PrimaryButton>
          </EmptyState>
        )
      ) : (
        <AppRows
          apps={apps}
          pinnedApps={props.pinnedApps}
          activePath={props.activePath}
          onOpenPath={props.onOpenPath}
          onSetPinned={props.onSetPinned}
        />
      )}
    </div>
  );
}
