import { useEffect, useRef, useState } from "react";
import type {
  PluginPipelineError,
  PluginStatusChangedEvent,
  PluginStatusRecord,
  PluginUninstallPreflightRecord,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

// The plugin data layer, shared by the two surfaces that show a plugin: the
// side-panel list (PluginsView) and the details tab (PluginDetailsPage). The
// list decides which plugins to show and the page decides what one plugin can
// do, but the statuses, the busy bookkeeping, the action calls and the
// status-event merge are the same work — so they live here once.
//
// Each mount runs its own guarded list and its own scoped status listener.
// That is deliberate: a details tab restored on launch must load without the
// panel ever being opened.

export type PluginAction =
  | "install"
  | "disable"
  | "enable"
  | "approve"
  | "preflight"
  | "uninstall";

export type PluginLoadState =
  | { status: "loading" }
  | { status: "ready"; plugins: PluginStatusRecord[] }
  | { status: "error"; message: string };

export type PluginUninstallConfirmation = {
  plugin: PluginStatusRecord;
  confirmationToken: string;
  preflight: PluginUninstallPreflightRecord;
};

type PendingStatusEvent = {
  revision: number;
  event: PluginStatusChangedEvent;
};

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

export function statusText(plugin: PluginStatusRecord): string {
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

// One label per plugin, colored by what the state costs the user: a broken
// plugin reads danger, a switched-off one warning, everything else quiet.
export function statusTone(plugin: PluginStatusRecord): string {
  if (["failed", "crashed", "invalid"].includes(plugin.status)) return "text-danger";
  if (plugin.status.startsWith("disabled")) return "text-warning";
  return "text-subtle";
}

export function actionLabel(action: PluginAction, busy: boolean): string {
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

export function isPipelineBusy(plugin: PluginStatusRecord): boolean {
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

export function isInstalled(plugin: PluginStatusRecord): boolean {
  return plugin.approvedHash !== null;
}

export function canInstall(plugin: PluginStatusRecord): boolean {
  return plugin.valid && plugin.status === "discovered" && plugin.approvedHash === null;
}

// A fresh install that never succeeded lands here with no approvedHash —
// none of the other action predicates match that combination, so without
// this the plugin has no control at all (CodeRabbit #779 R30). Retrying is the
// same installPlugin call as a first install; PluginPipeline's install()
// always runs a full fresh build regardless of prior state.
export function canRetryInstall(plugin: PluginStatusRecord): boolean {
  return (
    plugin.valid &&
    plugin.status === "disabled-pending-repair" &&
    plugin.approvedHash === null
  );
}

export function canEnable(plugin: PluginStatusRecord): boolean {
  return (
    plugin.status === "disabled" &&
    (plugin.disabledReason === "user" || plugin.disabledReason === "crash-loop")
  );
}

// Deliberately does not require disabledReason === "approval". An out-of-band
// edit to a plugin the user had already disabled holds for approval carrying
// the prior "user" reason, and that combination matched no other predicate —
// the plugin offered no action at all and the user could only recover by
// restoring the old bytes. Approving from here keeps the disabled bit:
// PluginPipeline.approve reads the same reason and rebuilds without starting.
export function canApprove(plugin: PluginStatusRecord): boolean {
  return (
    plugin.status === "disabled-pending-approval" &&
    plugin.approvedHash !== null &&
    plugin.sourceHash !== null &&
    plugin.sourceHash !== plugin.approvedHash
  );
}

/** The web apps this page may offer a button for: the ones that open a single
 * tab. A per-instance app needs an instance to open, and this page has none —
 * the plugin's own panel opens those. */
export function openableWebApps(
  plugin: PluginStatusRecord,
): PluginStatusRecord["webApps"] {
  return plugin.webApps.filter((webApp) => !webApp.instanced);
}

// An installed, non-disabled plugin can open its web apps. openPluginWebApp
// re-reads and re-verifies the manifest in main, so this predicate only
// decides whether the control is worth showing.
export function canOpenWebApps(plugin: PluginStatusRecord): boolean {
  return (
    plugin.valid &&
    plugin.approvedHash !== null &&
    openableWebApps(plugin).length > 0 &&
    !plugin.status.startsWith("disabled") &&
    plugin.status !== "uninstalling"
  );
}

// Uninstall is the one action an installed plugin keeps once its manifest
// breaks: every other one needs the manifest the pipeline can no longer read,
// so it would fail on click (#779 round 8 D2).
export function canDisable(plugin: PluginStatusRecord): boolean {
  return (
    plugin.valid &&
    plugin.approvedHash !== null &&
    plugin.status !== "disabled" &&
    plugin.status !== "disabled-pending-approval" &&
    plugin.status !== "disabled-pending-repair" &&
    plugin.status !== "uninstalling"
  );
}

/**
 * What to call a plugin on screen. A manifest may name the plugin for people;
 * where it does not, the id is the name, which is what every plugin surface
 * showed before manifests carried a display name.
 */
export function pluginTitle(plugin: PluginStatusRecord): string {
  return plugin.displayName ?? plugin.id;
}

// Every name a plugin answers to, plus what it says it does. A reader
// searching "agent" should find the plugin whose description says so, not
// only the one whose folder happens to spell it.
export function matchesFilter(plugin: PluginStatusRecord, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [
    plugin.id,
    plugin.directoryName,
    plugin.displayName,
    plugin.description,
    plugin.publisher,
  ].some((field) => field !== null && field.toLowerCase().includes(needle));
}

export interface PluginCatalog {
  load: PluginLoadState;
  busy: Record<string, PluginAction | undefined>;
  openingWebApp: string | null;
  errors: Record<string, string | undefined>;
  confirmation: PluginUninstallConfirmation | null;
  reload: () => void;
  runAction: (
    plugin: PluginStatusRecord,
    action: Exclude<PluginAction, "preflight" | "uninstall">,
  ) => void;
  openWebApp: (plugin: PluginStatusRecord, webAppId: string) => void;
  prepareUninstall: (plugin: PluginStatusRecord) => void;
  confirmUninstall: () => void;
  cancelUninstall: () => void;
}

export function webAppKey(pluginId: string, webAppId: string): string {
  return `${pluginId}\0${webAppId}`;
}

export function usePluginCatalog(workspaceId: string): PluginCatalog {
  const [load, setLoad] = useState<PluginLoadState>({ status: "loading" });
  const [busy, setBusy] = useState<Record<string, PluginAction | undefined>>({});
  const [openingWebApp, setOpeningWebApp] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [confirmation, setConfirmation] =
    useState<PluginUninstallConfirmation | null>(null);
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
      const result = await bridge().listPlugins({ workspaceId });
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
      if (epoch !== workspaceEpoch.current || event.workspaceId !== workspaceId) {
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
  }, [workspaceId]);

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
      const payload = { workspaceId, pluginId: plugin.id };
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

  // The tab opens from main and takes focus there.
  async function openWebApp(plugin: PluginStatusRecord, webAppId: string) {
    const epoch = workspaceEpoch.current;
    const key = webAppKey(plugin.id, webAppId);
    setOpeningWebApp(key);
    setErrors((current) => ({ ...current, [plugin.id]: undefined }));
    try {
      await bridge().openPluginWebApp({
        workspaceId,
        pluginRoot: plugin.rootPath,
        pluginId: plugin.id,
        webAppId,
        // The plugin's page has no instance to name. Per-instance apps are
        // opened by the plugin's own panel, which knows what its instances
        // are, and this page offers no button for one.
        instanceKey: null,
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
        workspaceId,
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
        workspaceId,
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

  return {
    load,
    busy,
    openingWebApp,
    errors,
    confirmation,
    reload: () => void loadPlugins(),
    runAction: (plugin, action) => void runAction(plugin, action),
    openWebApp: (plugin, webAppId) => void openWebApp(plugin, webAppId),
    prepareUninstall: (plugin) => void prepareUninstall(plugin),
    confirmUninstall: () => void confirmUninstall(),
    cancelUninstall: () => setConfirmation(null),
  };
}
