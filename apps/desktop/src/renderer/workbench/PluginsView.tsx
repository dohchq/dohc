import { AlertTriangle, Blocks, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PluginPipelineError,
  PluginStatusChangedEvent,
  PluginStatusRecord,
  PluginUninstallPreflightRecord,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { EmptyState, SectionLabel } from "../ui/controls";

// The plugin browser, in the side panel behind the activity bar's Plugins
// item. VS Code's Extensions view is the model: a filter box pinned at the
// top, then Installed above what the workspace merely offers, each plugin a
// compact row with one status label and its actions. dohc has no marketplace
// and manifests carry no version, description, or icon, so a row shows only
// what the pipeline actually knows.

type LoadState =
  | { status: "loading" }
  | { status: "ready"; plugins: PluginStatusRecord[] }
  | { status: "error"; message: string };

type PluginAction =
  | "install"
  | "disable"
  | "enable"
  | "approve"
  | "preflight"
  | "uninstall";

type Confirmation = {
  plugin: PluginStatusRecord;
  confirmationToken: string;
  preflight: PluginUninstallPreflightRecord;
};

type PendingStatusEvent = {
  revision: number;
  event: PluginStatusChangedEvent;
};

const primaryButton =
  "rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50";
const secondaryButton =
  "rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink disabled:opacity-50";
const dangerButton =
  "rounded-md border border-danger/40 bg-bg px-2 py-1 text-[11px] text-danger transition-colors hover:bg-danger/10 disabled:opacity-50";

function upsertPlugin(
  plugins: readonly PluginStatusRecord[],
  plugin: PluginStatusRecord,
): PluginStatusRecord[] {
  const next = plugins.filter((entry) => entry.id !== plugin.id);
  next.push(plugin);
  return next.sort(
    (left, right) =>
      left.directoryName.localeCompare(right.directoryName) ||
      left.id.localeCompare(right.id),
  );
}

function applyStatusEvents(
  plugins: readonly PluginStatusRecord[],
  events: readonly PendingStatusEvent[],
): PluginStatusRecord[] {
  return events.reduce<PluginStatusRecord[]>((current, pending) => {
    if (pending.event.kind === "removed") {
      const { pluginId } = pending.event;
      return current.filter((plugin) => plugin.id !== pluginId);
    }
    return upsertPlugin(current, pending.event.plugin);
  }, [...plugins]);
}

function statusText(plugin: PluginStatusRecord): string {
  if (plugin.status === "disabled-pending-approval") {
    return "Disabled — approval required";
  }
  if (plugin.status === "disabled-pending-repair") {
    return "Disabled — repair required";
  }
  if (plugin.status === "disabled") {
    return plugin.disabledReason === "crash-loop"
      ? "Disabled after repeated crashes"
      : "Disabled";
  }
  const labels: Record<PluginStatusRecord["status"], string> = {
    discovered: "Not installed",
    queued: "Queued",
    snapshotting: "Checking source",
    installing: "Installing",
    scanning: "Checking dependencies",
    building: "Building",
    starting: "Starting",
    ready: "Ready",
    failed: "Failed",
    crashed: "Crashed",
    disabled: "Disabled",
    "disabled-pending-approval": "Disabled — approval required",
    "disabled-pending-repair": "Disabled — repair required",
    invalid: "Invalid",
    uninstalling: "Uninstalling",
  };
  return labels[plugin.status];
}

// One label per row, colored by what the state costs the user: a broken
// plugin reads danger, a switched-off one warning, everything else quiet.
function statusTone(plugin: PluginStatusRecord): string {
  if (["failed", "crashed", "invalid"].includes(plugin.status)) return "text-danger";
  if (plugin.status.startsWith("disabled")) return "text-warning";
  return "text-subtle";
}

function actionLabel(action: PluginAction, busy: boolean): string {
  if (!busy) {
    const labels: Record<PluginAction, string> = {
      install: "Install",
      disable: "Disable",
      enable: "Enable",
      approve: "Approve",
      preflight: "Uninstall",
      uninstall: "Uninstall plugin",
    };
    return labels[action];
  }
  const labels: Record<PluginAction, string> = {
    install: "Installing",
    disable: "Disabling",
    enable: "Enabling",
    approve: "Approving",
    preflight: "Checking",
    uninstall: "Uninstalling",
  };
  return labels[action];
}

function actionError(
  action: Exclude<PluginAction, "preflight" | "uninstall">,
  pluginId: string,
  error: PluginPipelineError,
): string {
  const verbs: Record<typeof action, string> = {
    install: "install",
    disable: "disable",
    enable: "enable",
    approve: "approve",
  };
  return `dohc could not ${verbs[action]} ${pluginId}. ${error.message}`;
}

function isPipelineBusy(plugin: PluginStatusRecord): boolean {
  return [
    "queued",
    "snapshotting",
    "installing",
    "scanning",
    "building",
    "starting",
    "uninstalling",
  ].includes(plugin.status);
}

function canInstall(plugin: PluginStatusRecord): boolean {
  return plugin.valid && plugin.status === "discovered" && plugin.approvedHash === null;
}

// A fresh install that never succeeded lands here with no approvedHash —
// none of the other action predicates match that combination, so without
// this the row has no control at all (CodeRabbit #779 R30). Retrying is the
// same installPlugin call as a first install; PluginPipeline's install()
// always runs a full fresh build regardless of prior state.
function canRetryInstall(plugin: PluginStatusRecord): boolean {
  return (
    plugin.valid &&
    plugin.status === "disabled-pending-repair" &&
    plugin.approvedHash === null
  );
}

function canEnable(plugin: PluginStatusRecord): boolean {
  return (
    plugin.status === "disabled" &&
    (plugin.disabledReason === "user" || plugin.disabledReason === "crash-loop")
  );
}

// Deliberately does not require disabledReason === "approval". An out-of-band
// edit to a plugin the user had already disabled holds for approval carrying
// the prior "user" reason, and that combination matched no other predicate —
// the row offered no action at all and the user could only recover by
// restoring the old bytes. Approving from here keeps the disabled bit:
// PluginPipeline.approve reads the same reason and rebuilds without starting.
function canApprove(plugin: PluginStatusRecord): boolean {
  return (
    plugin.status === "disabled-pending-approval" &&
    plugin.approvedHash !== null &&
    plugin.sourceHash !== null &&
    plugin.sourceHash !== plugin.approvedHash
  );
}

// An installed, non-disabled plugin can open its web apps. openPluginWebApp
// re-reads and re-verifies the manifest in main, so this predicate only
// decides whether the control is worth showing.
function canOpenWebApps(plugin: PluginStatusRecord): boolean {
  return (
    plugin.valid &&
    plugin.approvedHash !== null &&
    plugin.webApps.length > 0 &&
    !plugin.status.startsWith("disabled") &&
    plugin.status !== "uninstalling"
  );
}

// Uninstall is the one action an installed plugin keeps once its manifest
// breaks: every other one needs the manifest the pipeline can no longer read,
// so it would fail on click (#779 round 8 D2).
function canDisable(plugin: PluginStatusRecord): boolean {
  return (
    plugin.valid &&
    plugin.approvedHash !== null &&
    plugin.status !== "disabled" &&
    plugin.status !== "disabled-pending-approval" &&
    plugin.status !== "disabled-pending-repair" &&
    plugin.status !== "uninstalling"
  );
}

// The id and the folder are the only names a plugin has here.
function matchesFilter(plugin: PluginStatusRecord, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    plugin.id.toLowerCase().includes(needle) ||
    plugin.directoryName.toLowerCase().includes(needle)
  );
}

export function PluginsView(props: { workspaceId: string }) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<Record<string, PluginAction | undefined>>({});
  const [openingWebApp, setOpeningWebApp] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  // The request token orders list responses. The workspace epoch invalidates
  // list and action responses after unmount or a workspace switch.
  const listRequestToken = useRef(0);
  const workspaceEpoch = useRef(0);
  // Status events can arrive while the initial list is in flight. Keep the
  // newest event for each plugin and merge it over that list before painting.
  const statusRevision = useRef(0);
  const pendingStatusEvents = useRef(new Map<string, PendingStatusEvent>());

  async function loadPlugins() {
    const requestToken = ++listRequestToken.current;
    const epoch = workspaceEpoch.current;
    const revisionAtStart = statusRevision.current;
    setLoad({ status: "loading" });
    try {
      const result = await bridge().listPlugins({ workspaceId: props.workspaceId });
      if (
        requestToken !== listRequestToken.current ||
        epoch !== workspaceEpoch.current
      ) {
        return;
      }
      if (!result.ok) {
        setLoad({
          status: "error",
          message: `Plugins could not load. ${result.error.message}`,
        });
        return;
      }
      const newerEvents = [...pendingStatusEvents.current.values()]
        .filter((pending) => pending.revision > revisionAtStart)
        .sort((left, right) => left.revision - right.revision);
      setLoad({
        status: "ready",
        plugins: applyStatusEvents(result.plugins, newerEvents),
      });
    } catch (error) {
      if (
        requestToken !== listRequestToken.current ||
        epoch !== workspaceEpoch.current
      ) {
        return;
      }
      const reason = error instanceof Error ? error.message : "Try again.";
      setLoad({
        status: "error",
        message: `Plugins could not load. ${reason}`,
      });
    }
  }

  useEffect(() => {
    const epoch = workspaceEpoch.current;
    setBusy({});
    setErrors({});
    setConfirmation(null);
    // An open still in flight for the workspace being left skips its own
    // cleanup on the epoch guard, so this workspace clears it. Without this
    // every Open control here stays disabled for the rest of the session.
    setOpeningWebApp(null);
    pendingStatusEvents.current.clear();
    statusRevision.current = 0;
    void loadPlugins();
    const unsubscribe = bridge().onPluginStatusChanged((event) => {
      if (
        epoch !== workspaceEpoch.current ||
        event.workspaceId !== props.workspaceId
      ) {
        return;
      }
      const pending = {
        revision: ++statusRevision.current,
        event,
      };
      const pluginId =
        event.kind === "changed" ? event.plugin.id : event.pluginId;
      pendingStatusEvents.current.set(pluginId, pending);
      setLoad((current) => {
        if (current.status !== "ready") return current;
        return {
          status: "ready",
          plugins: applyStatusEvents(current.plugins, [pending]),
        };
      });
    });
    return () => {
      unsubscribe();
      listRequestToken.current += 1;
      workspaceEpoch.current += 1;
      pendingStatusEvents.current.clear();
    };
    // Each workspace gets one guarded list and one scoped status listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  function replacePlugin(plugin: PluginStatusRecord) {
    setLoad((current) =>
      current.status === "ready"
        ? { status: "ready", plugins: upsertPlugin(current.plugins, plugin) }
        : current,
    );
  }

  // An action's own response can resolve with a snapshot older than one the
  // live onPluginStatusChanged listener already applied while the action was
  // still in flight (install/build progress keeps moving during a slow
  // request) — applying the response unconditionally would overwrite the
  // newer state with a stale one. revisionAtStart, captured before the
  // request began, is compared against this plugin's latest recorded event;
  // a newer one already reflects everything the response could tell us.
  function replacePluginUnlessSuperseded(
    plugin: PluginStatusRecord,
    revisionAtStart: number,
  ) {
    const newer = pendingStatusEvents.current.get(plugin.id);
    if (newer && newer.revision > revisionAtStart) return;
    replacePlugin(plugin);
  }

  async function runAction(
    plugin: PluginStatusRecord,
    action: Exclude<PluginAction, "preflight" | "uninstall">,
  ) {
    const epoch = workspaceEpoch.current;
    const revisionAtStart = statusRevision.current;
    setBusy((current) => ({ ...current, [plugin.id]: action }));
    setErrors((current) => ({ ...current, [plugin.id]: undefined }));
    try {
      const payload = { workspaceId: props.workspaceId, pluginId: plugin.id };
      const result =
        action === "install"
          ? await bridge().installPlugin(payload)
          : action === "disable"
            ? await bridge().disablePlugin(payload)
            : action === "enable"
              ? await bridge().enablePlugin(payload)
              : await bridge().approvePlugin(payload);
      if (epoch !== workspaceEpoch.current) return;
      if (result.ok) {
        replacePluginUnlessSuperseded(result.plugin, revisionAtStart);
      } else {
        if (result.plugin) replacePluginUnlessSuperseded(result.plugin, revisionAtStart);
        setErrors((current) => ({
          ...current,
          [plugin.id]: actionError(action, plugin.id, result.error),
        }));
      }
    } catch {
      if (epoch !== workspaceEpoch.current) return;
      setErrors((current) => ({
        ...current,
        [plugin.id]: `dohc could not ${action} ${plugin.id}. Try again.`,
      }));
    } finally {
      if (epoch === workspaceEpoch.current) {
        setBusy((current) => ({ ...current, [plugin.id]: undefined }));
      }
    }
  }

  // The tab opens from main and takes focus there. The panel sits beside the
  // editor rather than over it, so nothing has to get out of the way.
  async function openWebApp(plugin: PluginStatusRecord, webAppId: string) {
    const epoch = workspaceEpoch.current;
    const key = `${plugin.id}\0${webAppId}`;
    setOpeningWebApp(key);
    setErrors((current) => ({ ...current, [plugin.id]: undefined }));
    try {
      await bridge().openPluginWebApp({
        workspaceId: props.workspaceId,
        pluginRoot: plugin.rootPath,
        pluginId: plugin.id,
        webAppId,
      });
    } catch (error) {
      if (epoch !== workspaceEpoch.current) return;
      const reason = error instanceof Error ? error.message : "Try again.";
      setErrors((current) => ({
        ...current,
        [plugin.id]: `dohc could not open the app from ${plugin.id}. ${reason}`,
      }));
    } finally {
      if (epoch === workspaceEpoch.current) {
        setOpeningWebApp((current) => (current === key ? null : current));
      }
    }
  }

  async function prepareUninstall(plugin: PluginStatusRecord) {
    const epoch = workspaceEpoch.current;
    setBusy((current) => ({ ...current, [plugin.id]: "preflight" }));
    setErrors((current) => ({ ...current, [plugin.id]: undefined }));
    try {
      const result = await bridge().pluginUninstallPreflight({
        workspaceId: props.workspaceId,
        pluginId: plugin.id,
      });
      if (epoch !== workspaceEpoch.current) return;
      if (!result.ok) {
        setErrors((current) => ({
          ...current,
          [plugin.id]: `dohc could not check ${plugin.id} before uninstall. ${result.error.message}`,
        }));
        return;
      }
      setConfirmation({
        plugin,
        confirmationToken: result.confirmationToken,
        preflight: result.preflight,
      });
    } catch {
      if (epoch !== workspaceEpoch.current) return;
      setErrors((current) => ({
        ...current,
        [plugin.id]: `dohc could not check ${plugin.id} before uninstall. Try again.`,
      }));
    } finally {
      if (epoch === workspaceEpoch.current) {
        setBusy((current) => ({ ...current, [plugin.id]: undefined }));
      }
    }
  }

  async function confirmUninstall() {
    if (!confirmation) return;
    const currentConfirmation = confirmation;
    const pluginId = currentConfirmation.plugin.id;
    const epoch = workspaceEpoch.current;
    const revisionAtStart = statusRevision.current;
    setBusy((current) => ({ ...current, [pluginId]: "uninstall" }));
    try {
      const result = await bridge().uninstallPlugin({
        workspaceId: props.workspaceId,
        pluginId,
        confirmationToken: currentConfirmation.confirmationToken,
      });
      if (epoch !== workspaceEpoch.current) return;
      setConfirmation(null);
      if (result.ok) {
        setLoad((current) =>
          current.status === "ready"
            ? {
                status: "ready",
                plugins: current.plugins.filter((plugin) => plugin.id !== pluginId),
              }
            : current,
        );
      } else {
        if (result.plugin) replacePluginUnlessSuperseded(result.plugin, revisionAtStart);
        setErrors((current) => ({
          ...current,
          [pluginId]: `dohc could not uninstall ${pluginId}. ${result.error.message}`,
        }));
      }
    } catch {
      if (epoch !== workspaceEpoch.current) return;
      setConfirmation(null);
      setErrors((current) => ({
        ...current,
        [pluginId]: `dohc could not uninstall ${pluginId}. Run uninstall again.`,
      }));
    } finally {
      if (epoch === workspaceEpoch.current) {
        setBusy((current) => ({ ...current, [pluginId]: undefined }));
      }
    }
  }

  const plugins = load.status === "ready" ? load.plugins : [];
  const matched = useMemo(
    () => plugins.filter((plugin) => matchesFilter(plugin, filter)),
    [plugins, filter],
  );
  const installedPlugins = matched.filter((plugin) => plugin.approvedHash !== null);
  const candidatePlugins = matched.filter((plugin) => plugin.approvedHash === null);

  function renderRow(plugin: PluginStatusRecord) {
    const busyAction = busy[plugin.id];
    const disabled = busyAction !== undefined || isPipelineBusy(plugin);
    const installed = plugin.approvedHash !== null;
    return (
      <li
        key={plugin.id}
        data-testid="plugin-row"
        data-plugin-id={plugin.id}
        className="rounded-lg border border-line bg-panel p-2"
      >
        <div className="flex items-start gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-md border border-line bg-bg text-subtle">
            <Blocks size={15} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-ink" title={plugin.id}>
              {plugin.id}
            </div>
            <div
              data-testid="plugin-status"
              data-status={plugin.status}
              className={`mt-0.5 truncate text-[11px] ${statusTone(plugin)}`}
            >
              {statusText(plugin)}
            </div>
            {plugin.directoryName === plugin.id ? null : (
              <div className="mt-0.5 truncate font-mono text-[11px] text-subtle">
                {`plugins/${plugin.directoryName}`}
              </div>
            )}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap justify-end gap-1.5 empty:mt-0">
          {canOpenWebApps(plugin)
            ? plugin.webApps.map((webApp) => {
                const key = `${plugin.id}\0${webApp.id}`;
                return (
                  <button
                    key={webApp.id}
                    type="button"
                    data-testid="plugin-open-web-app"
                    data-web-app-id={webApp.id}
                    disabled={disabled || openingWebApp !== null}
                    onClick={() => void openWebApp(plugin, webApp.id)}
                    className={secondaryButton}
                  >
                    {openingWebApp === key
                      ? `Opening ${webApp.title}`
                      : `Open ${webApp.title}`}
                  </button>
                );
              })
            : null}
          {canInstall(plugin) ? (
            <button
              type="button"
              data-testid="plugin-install"
              disabled={disabled}
              onClick={() => void runAction(plugin, "install")}
              className={primaryButton}
            >
              {actionLabel("install", busyAction === "install")}
            </button>
          ) : null}
          {canRetryInstall(plugin) ? (
            <button
              type="button"
              data-testid="plugin-retry-install"
              disabled={disabled}
              onClick={() => void runAction(plugin, "install")}
              className={primaryButton}
            >
              {busyAction === "install" ? "Retrying install" : "Retry install"}
            </button>
          ) : null}
          {canDisable(plugin) ? (
            <button
              type="button"
              data-testid="plugin-disable"
              disabled={disabled}
              onClick={() => void runAction(plugin, "disable")}
              className={secondaryButton}
            >
              {actionLabel("disable", busyAction === "disable")}
            </button>
          ) : null}
          {canEnable(plugin) ? (
            <button
              type="button"
              data-testid="plugin-enable"
              disabled={disabled}
              onClick={() => void runAction(plugin, "enable")}
              className={secondaryButton}
            >
              {actionLabel("enable", busyAction === "enable")}
            </button>
          ) : null}
          {canApprove(plugin) ? (
            <button
              type="button"
              data-testid="plugin-approve"
              disabled={disabled}
              onClick={() => void runAction(plugin, "approve")}
              className={secondaryButton}
            >
              {actionLabel("approve", busyAction === "approve")}
            </button>
          ) : null}
          {installed ? (
            <button
              type="button"
              data-testid="plugin-uninstall"
              disabled={disabled}
              onClick={() => void prepareUninstall(plugin)}
              className={dangerButton}
            >
              {actionLabel("preflight", busyAction === "preflight")}
            </button>
          ) : null}
        </div>
        {plugin.error ? (
          <p className="m-0 mt-2 text-[11px] text-danger">{plugin.error.message}</p>
        ) : null}
        {errors[plugin.id] ? (
          <p
            data-testid="plugin-action-error"
            role="alert"
            className="m-0 mt-2 text-[11px] text-danger"
          >
            {errors[plugin.id]}
          </p>
        ) : null}
        {plugin.warnings.map((warning) => (
          <p key={warning} className="m-0 mt-2 text-[11px] text-warning">
            {warning}
          </p>
        ))}
      </li>
    );
  }

  return (
    <div data-testid="plugins-view" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line px-2 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-line bg-bg px-1.5 py-1 transition-colors focus-within:border-ink">
          <Search size={12} aria-hidden className="shrink-0 text-subtle" />
          <input
            type="text"
            data-testid="plugins-filter"
            aria-label="Search plugins"
            placeholder="Search plugins"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-subtle"
          />
        </div>
      </div>

      {load.status === "loading" ? (
        <div className="flex flex-1 items-center justify-center px-4 text-xs text-subtle">
          Loading plugins…
        </div>
      ) : load.status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <AlertTriangle size={18} aria-hidden className="text-warning" />
          <p data-testid="plugins-load-error" role="alert" className="m-0 text-[11px] text-danger">
            {load.message}
          </p>
          <button
            type="button"
            onClick={() => void loadPlugins()}
            className={secondaryButton}
          >
            Retry
          </button>
        </div>
      ) : plugins.length === 0 ? (
        <div data-testid="plugins-empty" className="flex min-h-0 flex-1 flex-col">
          <EmptyState
            icon={<Blocks size={22} aria-hidden className="text-line" />}
            title="No plugins yet"
            hint="Ask your agent to add a plugin folder under plugins/."
          />
        </div>
      ) : matched.length === 0 ? (
        <div data-testid="plugins-filter-empty" className="flex min-h-0 flex-1 flex-col">
          <EmptyState
            icon={<Blocks size={22} aria-hidden className="text-line" />}
            title={`No plugins match "${filter.trim()}"`}
            hint="Try a shorter search."
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {installedPlugins.length > 0 ? (
            <section data-testid="plugins-section-installed">
              <SectionLabel className="block px-1 pb-1.5">Installed</SectionLabel>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {installedPlugins.map(renderRow)}
              </ul>
            </section>
          ) : null}
          {candidatePlugins.length > 0 ? (
            <section
              data-testid="plugins-section-available"
              className={installedPlugins.length > 0 ? "mt-4" : undefined}
            >
              <SectionLabel className="block px-1 pb-1.5">
                Available in this workspace
              </SectionLabel>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {candidatePlugins.map(renderRow)}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      {confirmation ? (
        <Overlay
          onClose={() => {
            if (busy[confirmation.plugin.id] !== "uninstall") {
              setConfirmation(null);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugin-uninstall-title"
            data-testid="plugin-uninstall-dialog"
            className="dohc-elevated flex max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-line bg-panel"
          >
            <div className="min-h-0 overflow-auto p-5">
              <h2
                id="plugin-uninstall-title"
                className="m-0 text-sm font-semibold text-ink"
              >
                {`Uninstall ${confirmation.plugin.id}?`}
              </h2>
              <p className="m-0 mt-2 text-xs text-muted">
                This removes the plugin source and build files from this workspace.
              </p>
              {confirmation.preflight.warning ? (
                <div
                  data-testid="plugin-uninstall-warning"
                  className="mt-4 rounded-lg border border-warning/40 bg-warning/10 p-3"
                >
                  <div className="flex items-start gap-2 text-xs text-warning">
                    <AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
                    <p className="m-0">{confirmation.preflight.warning.summary}</p>
                  </div>
                  <ul className="mb-0 mt-2 space-y-1 pl-5 text-[11px] text-muted">
                    {confirmation.preflight.warning.details.map((detail) => (
                      <li key={detail}>{detail}</li>
                    ))}
                  </ul>
                  {confirmation.preflight.warning.notRecoverablePathSample.length > 0 ? (
                    <div className="mt-3">
                      <p className="m-0 text-[11px] font-medium text-danger">
                        dohc cannot confirm history holds these files:
                      </p>
                      <ul
                        data-testid="plugin-uninstall-not-recoverable"
                        className="mb-0 mt-1 list-none space-y-1 p-0"
                      >
                        {confirmation.preflight.warning.notRecoverablePathSample.map(
                          (path) => (
                            <li
                              key={path}
                              className="break-all rounded border border-danger/30 bg-bg px-2 py-1 font-mono text-[11px] text-danger"
                            >
                              {path}
                            </li>
                          ),
                        )}
                      </ul>
                      {confirmation.preflight.warning.counts.notRecoverableFromHistory >
                          confirmation.preflight.warning.notRecoverablePathSample.length
                        ? (
                          <p
                            data-testid="plugin-uninstall-not-recoverable-more"
                            className="m-0 mt-1 text-[11px] text-danger"
                          >
                            {`and ${
                              confirmation.preflight.warning.counts
                                .notRecoverableFromHistory -
                              confirmation.preflight.warning.notRecoverablePathSample
                                .length
                            } more`}
                          </p>
                        )
                        : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
              <button
                type="button"
                autoFocus
                disabled={busy[confirmation.plugin.id] === "uninstall"}
                onClick={() => setConfirmation(null)}
                className={secondaryButton}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="plugin-uninstall-confirm"
                disabled={busy[confirmation.plugin.id] === "uninstall"}
                onClick={() => void confirmUninstall()}
                className="rounded-md bg-danger px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
              >
                {actionLabel(
                  "uninstall",
                  busy[confirmation.plugin.id] === "uninstall",
                )}
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}
    </div>
  );
}
