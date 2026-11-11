import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import { preferredBuildOutput } from "@dohc/workspace-core";
import { previewRunsAppCode, type SitePackageInfo, type SitePreviewMode } from "../../ipc/bridgeContract";
import { APP_CHECK_FALLBACK_MESSAGE } from "../appCopy";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import {
  availableModes,
  forgetMode,
  modeLabel,
  readStoredMode,
  rememberMode,
  startingMode,
  type StartingModeSource,
  type WorkspacePreviewMode,
} from "../previewModes";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SkeletonRows } from "../ui/SkeletonRows";
import { RetryRow, SecondaryButton } from "../ui/controls";
import { useAsyncResponseEffect } from "../useAsyncResponseEffect";
import { AppMarks } from "../workbench/AppsSection";
import { SettingRow, SettingsSection, SwitchControl } from "./SettingRow";

const DEFAULT_DESCRIPTIONS: Record<WorkspacePreviewMode, string> = {
  auto: "Dev when an app has a dev script. Otherwise Build for a package, or Static.",
  dev: "Runs each app's dev script on this computer.",
  build: "Shows each app's build output. Runs its build script first when it has one.",
  static: "Shows each app's files as they are. Runs no commands on this computer.",
};

const SOURCE_WORDS: Record<StartingModeSource, string> = {
  picked: "Picked on this computer",
  shared: "Shared",
  app: "Set in dohc.json",
  workspace: "Workspace default",
  automatic: "Automatic",
};

type ListState =
  | { status: "loading" }
  | { status: "ready"; workspaceId: string; apps: SitePackageInfo[] }
  | { status: "failed"; workspaceId: string };

type ReportError = (message: string, cause?: unknown, retry?: () => Promise<void>, details?: undefined, identity?: string) => void;

export function AppsSettings(props: {
  workspaceId: string;
  sharedView: boolean;
  defaultPreviewMode: WorkspacePreviewMode;
  defaultModified: boolean;
  onDefaultChange: (mode: WorkspacePreviewMode) => void;
  onDefaultReset: () => void;
  // Null while main has not answered. Absent in a shared view, which runs no commands.
  trust?: { trusted: boolean | null; onOpen: () => void };
  pinned: readonly string[];
  onSetPinned?: (appRoot: string, pinned: boolean) => void;
  onOpenApp?: (appRoot: string) => void;
  onError?: ReportError;
  onClearError?: (identity: string) => void;
}) {
  const { workspaceId } = props;
  // The list reads once per workspace and Try again, whatever the callbacks' identity.
  const report = useRef({ onError: props.onError, onClearError: props.onClearError });
  report.current = { onError: props.onError, onClearError: props.onClearError };
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<string | null>(null);
  // A pick lives in this computer's storage, so a change re-reads it.
  const [, setPicks] = useState(0);
  const identity = `settings-apps:${workspaceId}`;
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useAsyncResponseEffect(
    () => bridge().listSites({ workspaceId }),
    {
      onSuccess: (result) => {
        report.current.onClearError?.(identity);
        setList({ status: "ready", workspaceId, apps: result.sites });
      },
      onError: (error) => {
        setList({ status: "failed", workspaceId });
        report.current.onError?.(ipcErrorMessage(error, "dohc could not list this workspace's apps."), error, async () => retry(), undefined, identity);
      },
    },
    [workspaceId, attempt],
  );
  useEffect(() => () => report.current.onClearError?.(identity), [identity]);

  // An answer for another workspace never shows.
  const current = list.status !== "loading" && list.workspaceId !== workspaceId ? { status: "loading" as const } : list;
  const apps = current.status === "ready" ? current.apps : [];
  const page = opened === null ? null : apps.find((app) => app.root === opened) ?? null;

  // Opening a page focuses its back button; going back focuses the app's row.
  const card = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<{ row: string } | "page" | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    if (target === "page") back.current?.focus();
    else card.current?.querySelector<HTMLElement>(`[data-testid="settings-app-row"][data-app-root="${CSS.escape(target.row)}"]`)?.focus();
  });
  // A page whose app left the workspace goes back to the list.
  useEffect(() => {
    if (opened !== null && current.status === "ready" && page === null) setOpened(null);
  }, [current.status, opened, page]);
  useEffect(() => setOpened(null), [workspaceId]);

  const modesOf = (app: SitePackageInfo) => availableModes(app, props.sharedView);
  const pickOf = (app: SitePackageInfo) => readStoredMode(workspaceId, app.root, modesOf(app));
  const startOf = (app: SitePackageInfo, picked = pickOf(app)) =>
    startingMode(app, modesOf(app), picked, props.defaultPreviewMode, props.sharedView);

  if (page) {
    return (
      <AppPage
        app={page}
        modes={modesOf(page)}
        picked={pickOf(page)}
        fallback={startOf(page, null)}
        restricted={props.trust?.trusted === false}
        pinned={props.pinned.includes(page.root)}
        backRef={back}
        onBack={() => {
          focusAfter.current = { row: page.root };
          setOpened(null);
        }}
        onPick={(mode) => {
          if (mode === null) forgetMode(workspaceId, page.root);
          else rememberMode(workspaceId, page.root, mode);
          setPicks((count) => count + 1);
        }}
        {...(props.onSetPinned ? { onSetPinned: (pinned: boolean) => props.onSetPinned?.(page.root, pinned) } : {})}
        {...(props.onOpenApp ? { onOpen: () => props.onOpenApp?.(page.root) } : {})}
      />
    );
  }

  return (
    <div data-testid="settings-apps">
      <h3 className="m-0 mb-6 text-base font-semibold text-ink">Apps</h3>
      <SettingsSection title="Previews">
        <SettingRow
          title="Start previews with"
          description={DEFAULT_DESCRIPTIONS[props.defaultPreviewMode]}
          modified={props.defaultModified}
          onReset={props.onDefaultReset}
          testId="settings-row-site-preview-mode"
        >
          <SegmentedControl
            label="Default app preview mode"
            testId="site-preview-mode-control"
            value={props.defaultPreviewMode}
            options={[
              { value: "auto", label: "Auto" },
              { value: "dev", label: "Dev" },
              { value: "build", label: "Build" },
              { value: "static", label: "Static" },
            ]}
            onChange={props.onDefaultChange}
          />
        </SettingRow>
        {props.trust ? (
          <SettingRow
            title="Workspace trust"
            description="Dev and Build run commands on this computer. Restricted Mode holds them until you trust this workspace."
            testId="settings-row-apps-trust"
          >
            <span data-testid="apps-trust-state" className="text-[12px] text-muted">
              {props.trust.trusted === null ? "Checking" : props.trust.trusted ? "Trusted" : "Restricted Mode"}
            </span>
            <SecondaryButton size="compact" onClick={props.trust.onOpen}>Change</SecondaryButton>
          </SettingRow>
        ) : null}
      </SettingsSection>

      <section aria-label="Apps in this workspace" className="mt-8">
        <h4 className="m-0 mb-2.5 text-sm font-semibold text-ink">Apps in this workspace</h4>
        <div ref={card}>
          {current.status === "loading" ? (
            <SkeletonRows layout="panel" label="Loading apps..." />
          ) : current.status === "failed" ? (
            <RetryRow testId="settings-apps-failed" onRetry={retry}>dohc could not list this workspace's apps.</RetryRow>
          ) : apps.length === 0 ? (
            <p data-testid="settings-apps-empty" className="m-0 rounded-lg border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">
              No apps in this workspace yet.
            </p>
          ) : (
            <div className="rounded-lg border border-line bg-panel">
              {apps.map((app) => {
                const start = startOf(app);
                return (
                  <button
                    key={app.root}
                    type="button"
                    data-testid="settings-app-row"
                    data-app-root={app.root}
                    aria-label={app.title}
                    onClick={() => {
                      focusAfter.current = "page";
                      setOpened(app.root);
                    }}
                    className="flex min-h-11 w-full items-center gap-3 border-b border-line px-3 py-2 text-left transition-colors first:rounded-t-lg last:rounded-b-lg last:border-b-0 hover:bg-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate text-[13px] font-medium text-ink">{app.title}</span>
                        <AppMarks app={app} />
                      </span>
                      <span className="block truncate font-mono text-[11px] text-subtle">{app.root}</span>
                    </span>
                    <span data-testid="settings-app-mode" className="flex shrink-0 items-center gap-2 text-[12px] text-muted">
                      {start ? (
                        <>
                          <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-ink">{modeLabel(start.mode)}</span>
                          <span>{SOURCE_WORDS[start.source]}</span>
                        </>
                      ) : (
                        <span>Nothing to preview</span>
                      )}
                    </span>
                    <ChevronRight size={16} aria-hidden className="shrink-0 text-subtle" />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function fallbackWords(fallback: { mode: SitePreviewMode; source: StartingModeSource } | null): string {
  if (!fallback) return "This app has nothing to preview yet.";
  const mode = modeLabel(fallback.mode);
  if (fallback.source === "app") return `Default starts ${mode}, as its dohc.json sets.`;
  if (fallback.source === "workspace") return `Default starts ${mode}, the workspace default.`;
  if (fallback.source === "shared") return `Default starts ${mode}, the only mode a shared app has.`;
  return `Default starts ${mode}, which dohc picks for this app.`;
}

function AppPage(props: {
  app: SitePackageInfo;
  modes: SitePreviewMode[];
  picked: SitePreviewMode | null;
  fallback: { mode: SitePreviewMode; source: StartingModeSource } | null;
  restricted: boolean;
  pinned: boolean;
  backRef: React.Ref<HTMLButtonElement>;
  onBack: () => void;
  onPick: (mode: SitePreviewMode | null) => void;
  onSetPinned?: (pinned: boolean) => void;
  onOpen?: () => void;
}) {
  const { app } = props;
  const starts = props.picked ?? props.fallback?.mode ?? null;
  const held = props.restricted && starts !== null && previewRunsAppCode(app, starts);
  const devScript = app.configuredScripts.dev ?? app.scripts.dev ?? app.configuredScripts.start ?? app.scripts.start;
  const buildScript = app.configuredScripts.build ?? app.scripts.build;
  const output = preferredBuildOutput(app);
  const details: Array<[string, string]> = [
    ["Folder", app.root],
    ...(app.entryPath ? [["Opens", app.entryPath] as [string, string]] : []),
    ...(app.configPath ? [["Settings file", app.configPath] as [string, string]] : []),
    ...(app.packagePath ? [["Package", app.packageManager ? `${app.packagePath} (${app.packageManager})` : app.packagePath] as [string, string]] : []),
    ...(devScript ? [["Dev script", devScript] as [string, string]] : []),
    ...(buildScript ? [["Build script", buildScript] as [string, string]] : []),
    ...(output ? [["Build output", output] as [string, string]] : []),
  ];
  return (
    <section data-testid="settings-app-page" data-app-root={app.root} aria-label={app.title}>
      <button
        ref={props.backRef}
        type="button"
        data-testid="settings-app-back"
        onClick={props.onBack}
        className="-ml-1 mb-4 inline-flex items-center gap-1 rounded px-1 text-[13px] text-muted hover:text-ink"
      >
        <ChevronLeft size={14} aria-hidden />Apps
      </button>
      <div className="mb-6 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 flex min-w-0 items-center gap-1.5 text-base font-semibold text-ink">
            <span className="min-w-0 truncate">{app.title}</span>
            <AppMarks app={app} />
          </h3>
          <p className="m-0 mt-0.5 truncate font-mono text-[12px] text-muted">{app.root}</p>
        </div>
        {props.onOpen ? (
          <SecondaryButton data-testid="settings-app-open" onClick={props.onOpen} className="shrink-0">Open app</SecondaryButton>
        ) : null}
      </div>

      <SettingsSection title="Preview">
        <SettingRow
          title="Start with"
          description={<>
            {props.picked
              ? "Picked on this computer. Applies the next time this preview starts."
              : fallbackWords(props.fallback)}
            {held ? (
              <span data-testid="settings-app-restricted" className="mt-1 flex items-center gap-1.5 text-warning">
                <TriangleAlert size={12} aria-hidden className="shrink-0" />
                Restricted Mode holds {modeLabel(starts)} until you trust this workspace.
              </span>
            ) : null}
          </>}
          testId="settings-app-start-with"
        >
          {props.modes.length > 0 ? (
            <SegmentedControl<"default" | SitePreviewMode>
              label={`${app.title} preview mode`}
              testId="settings-app-mode-control"
              value={props.picked ?? "default"}
              options={[
                { value: "default", label: "Default" },
                ...props.modes.map((mode) => ({ value: mode, label: modeLabel(mode) })),
              ]}
              onChange={(value) => props.onPick(value === "default" ? null : value)}
            />
          ) : null}
        </SettingRow>
        {props.onSetPinned ? (
          <SettingRow title="Pin to sidebar" testId="settings-app-pin">
            <SwitchControl
              label={`Pin ${app.title} to sidebar`}
              checked={props.pinned}
              onChange={(pinned) => props.onSetPinned?.(pinned)}
            />
          </SettingRow>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Details">
        <dl data-testid="settings-app-details" className="m-0">
          {details.map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-4 border-b border-line py-2.5 last:border-b-0">
              <dt className="w-28 shrink-0 text-[13px] text-muted">{label}</dt>
              <dd className="m-0 min-w-0 select-text break-all font-mono text-[12px] text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </SettingsSection>

      {app.diagnostics.length > 0 ? (
        <SettingsSection title="Problems">
          <ul data-testid="settings-app-problems" className="m-0 list-none p-0">
            {app.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.code}-${index}`} className="flex items-start gap-2 border-b border-line py-2.5 text-[12px] last:border-b-0">
                <TriangleAlert size={12} aria-hidden className={`mt-0.5 shrink-0 ${diagnostic.severity === "error" ? "text-danger" : "text-warning"}`} />
                <span className="min-w-0 text-ink">
                  {diagnostic.message || APP_CHECK_FALLBACK_MESSAGE}
                  {diagnostic.path ? <span className="ml-1.5 font-mono text-subtle">{diagnostic.path}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}
    </section>
  );
}
