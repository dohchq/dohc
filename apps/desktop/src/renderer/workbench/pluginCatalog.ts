import { useEffect, useRef, useState } from "react";
import type {
  PluginPipelineError,
  PluginStatusChangedEvent,
  PluginStatusRecord,
  PluginUninstallPreflightRecord,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { readError } from "../../ipc/errorWords";

// The plugin data layer, shared by the two surfaces that show a plugin: the
// side-panel list (PluginsView) and the details tab (PluginDetailsPage). The
// list decides which plugins to show and the page decides what one plugin can
// do, but the statuses, the busy bookkeeping, the action calls and the
// status-event merge are the same work — so they live here once.
//
// Each mount runs its own guarded list and its own scoped status listener.
// That is deliberate: a details tab restored on launch must load without the
// panel ever being opened.

type PluginAction =
  | "install"
  | "disable"
  | "enable"
  | "approve"
  | "rebuild"
  | "preflight"
  | "uninstall";

// install/disable/enable/approve/rebuild go through runAction's shared
// dispatch and error composition; preflight/uninstall run their own
// dedicated flows below.
type RunnablePluginAction = Exclude<PluginAction, "preflight" | "uninstall">;

type PluginLoadState =
  | { status: "loading" }
  | { status: "ready"; plugins: PluginStatusRecord[] }
  | { status: "error"; message: string };

type PluginUninstallConfirmation = {
  plugin: PluginStatusRecord;
  confirmationToken: string;
  preflight: PluginUninstallPreflightRecord;
};

type PendingStatusEvent = {
  revision: number;
  // Discovery reloads the list; a rename retires the old directory before moving the row.
  event: Exclude<PluginStatusChangedEvent, { kind: "discovery-changed" | "renamed" }>;
};

function upsertPlugin(
  plugins: readonly PluginStatusRecord[],
  plugin: PluginStatusRecord,
): PluginStatusRecord[] {
  const next = plugins.filter((entry) => entry.directoryName !== plugin.directoryName);
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
      const { pluginId, directoryName } = pending.event;
      return current.filter((plugin) => plugin.id !== pluginId || plugin.directoryName !== directoryName);
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
      rebuild: "Retry build",
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
    rebuild: "Retrying build",
    preflight: "Checking",
    uninstall: "Uninstalling",
  };
  return labels[action];
}

function actionError(
  action: RunnablePluginAction,
  pluginId: string,
  error: PluginPipelineError,
): string {
  const verbs: Record<typeof action, string> = {
    install: "install",
    disable: "disable",
    enable: "enable",
    approve: "approve",
    rebuild: "rebuild",
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
// this the plugin has no control at all. Retrying is the same installPlugin
// call as a first install; PluginPipeline's install() always runs a full
// fresh build regardless of prior state.
export function canRetryInstall(plugin: PluginStatusRecord): boolean {
  return (
    plugin.valid &&
    plugin.status === "disabled-pending-repair" &&
    plugin.approvedHash === null
  );
}

// While hasFailedReplacement, Enable's own verify pass compares the live
// source against the durable approvedHash — the old bytes, since the
// failed replacement's edit never earned a new one — finds them changed,
// and holds for approval instead of restarting. That hold's stop clears
// recoveredManifests, destroying the exact fact Retry build needs and
// leaving neither action honest. Retry build already knows how to accept
// this same source (lastApprovedAttemptHash); Enable does not
// (round-10 finding 1).
export function canEnable(plugin: PluginStatusRecord): boolean {
  return (
    plugin.status === "disabled" &&
    (plugin.disabledReason === "user" || plugin.disabledReason === "crash-loop") &&
    !plugin.hasFailedReplacement
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

// hasFailedReplacement carries the fact through a crash-loop respawn that
// flips status back to "ready"/"crashed" between the failure and the fix —
// status === "failed" alone only covers the still-common case where nothing
// respawned (round-8 finding 3).
export function canRebuild(plugin: PluginStatusRecord): boolean {
  return (
    plugin.valid &&
    plugin.approvedHash !== null &&
    (plugin.status === "failed" || plugin.hasFailedReplacement)
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

/**
 * Whether this plugin can serve its surfaces right now: installed, approved,
 * and not on its way out. Main re-reads and re-verifies the manifest before
 * it serves anything, so this only decides what is worth showing.
 */
export function canServeSurfaces(plugin: PluginStatusRecord): boolean {
  return (
    plugin.valid &&
    plugin.approvedHash !== null &&
    !plugin.status.startsWith("disabled") &&
    plugin.status !== "uninstalling"
  );
}

// An installed, non-disabled plugin can open its web apps.
export function canOpenWebApps(plugin: PluginStatusRecord): boolean {
  return canServeSurfaces(plugin) && openableWebApps(plugin).length > 0;
}

// A plugin the workspace has never approved has no running state to undo,
// only real workspace files to delete. Install requires a valid manifest to
// run, but removing must not, or a broken copy would have no way out at all.
// This is the one action that mirrors Uninstall's confirm shape for a plugin
// Uninstall's own gate (approvedHash !== null) never reaches.
export function canRemove(plugin: PluginStatusRecord): boolean {
  return plugin.approvedHash === null;
}

// Uninstall is the one action an installed plugin keeps once its manifest
// breaks: every other one needs the manifest the pipeline can no longer read,
// so it would fail on click.
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

/** A rename the pipeline has proven, not guessed — a fresh object every
 * time it fires, so a consumer's effect keyed on it runs exactly once per
 * rename even when the same (pluginId, from, to) repeats. */
export interface PluginRenamedFact {
  pluginId: string;
  from: string;
  to: string;
}

interface PluginCatalog {
  load: PluginLoadState;
  busy: Record<string, PluginAction | undefined>;
  openingWebApp: string | null;
  webAppRootPending: (plugin: PluginStatusRecord) => boolean;
  errors: Record<string, string | undefined>;
  confirmation: PluginUninstallConfirmation | null;
  /** The most recent rename the pipeline has reported, for a tab tracking
   * one open row to retarget on. Not accumulated as a queue — a consumer
   * only ever cares whether its own (pluginId, directoryName) matches
   * `from`, and this list's own row already moved. */
  renamed: PluginRenamedFact | null;
  reload: () => void;
  runAction: (
    plugin: PluginStatusRecord,
    action: RunnablePluginAction,
  ) => void;
  openWebApp: (plugin: PluginStatusRecord, webAppId: string) => void;
  prepareUninstall: (plugin: PluginStatusRecord) => void;
  confirmUninstall: () => void;
  cancelUninstall: () => void;
}

export function pluginKey(plugin: Pick<PluginStatusRecord, "id" | "directoryName">): string {
  return `${plugin.id}\0${plugin.directoryName}`;
}

export function webAppKey(pluginId: string, webAppId: string): string {
  return `${pluginId}\0${webAppId}`;
}

// Callers may take the default only when their mount necessarily follows the
// workspace-open invoke reaching main: PluginsView and PluginDetailsPage
// mount after the async UI-state restore, and main registers the sender
// synchronously at the open invoke. A mount that can race that invoke, like
// the shell's rail, must pass its own readiness signal.
export function usePluginCatalog(
  workspaceId: string,
  enabled: boolean = true,
): PluginCatalog {
  const [load, setLoad] = useState<PluginLoadState>({ status: "loading" });
  // Mirrors `load`, written on every render rather than through an effect —
  // synchronously current the moment a later event fires, unlike the
  // closure a status listener set up in an earlier effect would otherwise
  // read stale. Only ever read outside React's own update cycle, where
  // functional setState updaters give no ordering guarantee about when
  // they actually run relative to the code right after the setState call.
  const loadRef = useRef(load);
  loadRef.current = load;
  const [busy, setBusy] = useState<Record<string, PluginAction | undefined>>({});
  const [openingWebApp, setOpeningWebApp] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [confirmation, setConfirmation] =
    useState<PluginUninstallConfirmation | null>(null);
  // A fresh object every time, even when the same (pluginId, from, to)
  // repeats — the identity change is what lets a consumer's effect fire
  // exactly once per rename, the same "adjusting state when props change"
  // shape React's own docs use refs for.
  const [renamed, setRenamed] = useState<PluginRenamedFact | null>(null);
  // The request token orders list responses. The workspace epoch invalidates
  // list and action responses after unmount or a workspace switch.
  const listRequestToken = useRef(0);
  const workspaceEpoch = useRef(0);
  // Status events can arrive while the initial list is in flight. Keep the
  // newest event for each plugin and merge it over that list before painting.
  const statusRevision = useRef(0);
  const pendingStatusEvents = useRef(new Map<string, PendingStatusEvent>());
  // A rename supplies the new directory identity, but no authoritative root.
  const pendingWebAppRoots = useRef(new Set<string>());

  // silent keeps whatever is already on screen while the fresh list is in
  // flight instead of resetting to "loading" first.
  async function loadPlugins(silent = false) {
    const requestToken = ++listRequestToken.current;
    const epoch = workspaceEpoch.current;
    const revisionAtStart = statusRevision.current;
    if (!silent) setLoad({ status: "loading" });
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
      pendingWebAppRoots.current.clear();
      const ready = {
        status: "ready" as const,
        plugins: applyStatusEvents(result.plugins, newerEvents),
      };
      loadRef.current = ready;
      setLoad(ready);
    } catch (error) {
      if (
        requestToken !== listRequestToken.current ||
        epoch !== workspaceEpoch.current
      ) {
        return;
      }
      const reason = readError(error).words ?? "Try again.";
      setLoad({
        status: "error",
        message: `Plugins could not load. ${reason}`,
      });
    }
  }

  useEffect(() => {
    if (!enabled) return;
    const epoch = workspaceEpoch.current;
    setBusy({});
    setErrors({});
    setConfirmation(null);
    setRenamed(null);
    // An open still in flight for the workspace being left skips its own
    // cleanup on the epoch guard, so this workspace clears it. Without this
    // every Open control here stays disabled for the rest of the session.
    setOpeningWebApp(null);
    pendingStatusEvents.current.clear();
    pendingWebAppRoots.current.clear();
    statusRevision.current = 0;
    void loadPlugins();
    const unsubscribe = bridge().onPluginStatusChanged((event) => {
      if (epoch !== workspaceEpoch.current || event.workspaceId !== workspaceId) {
        return;
      }
      if (event.kind === "discovery-changed") {
        // An invalid, never-installed candidate names no pluginId a
        // "changed"/"removed" event could carry, so it never joins
        // pendingStatusEvents/applyStatusEvents — those exist to merge one
        // plugin's own transition, and this names no plugin at all.
        // Discovery itself moved, and list() shows an invalid row directly
        // from it, so the list re-checks.
        void loadPlugins(true);
        return;
      }
      if (event.kind === "renamed") {
        const oldKey = pluginKey({ id: event.pluginId, directoryName: event.from });
        pendingWebAppRoots.current.delete(oldKey);
        pendingWebAppRoots.current.add(
          pluginKey({ id: event.pluginId, directoryName: event.to }),
        );
        pendingStatusEvents.current.set(oldKey, {
          revision: ++statusRevision.current,
          event: {
            kind: "removed",
            workspaceId,
            pluginId: event.pluginId,
            directoryName: event.from,
          },
        });
        setBusy((current) => ({ ...current, [oldKey]: undefined }));
        setErrors((current) => ({ ...current, [oldKey]: undefined }));
        setConfirmation((current) =>
          current && pluginKey(current.plugin) === oldKey ? null : current,
        );
        // Only a proven rename moves a row between directory identities.
        if (loadRef.current.status === "ready") {
          const moved = {
            status: "ready" as const,
            plugins: loadRef.current.plugins.map((plugin) =>
              plugin.id === event.pluginId && plugin.directoryName === event.from
                ? { ...plugin, directoryName: event.to }
                : plugin
            ),
          };
          // A status event can follow the rename before React renders.
          loadRef.current = moved;
          setLoad(moved);
        }
        void loadPlugins(true);
        setRenamed({ pluginId: event.pluginId, from: event.from, to: event.to });
        return;
      }
      const pending = {
        revision: ++statusRevision.current,
        event,
      };
      const key = event.kind === "changed"
        ? pluginKey(event.plugin)
        : pluginKey({ id: event.pluginId, directoryName: event.directoryName });
      pendingStatusEvents.current.set(key, pending);
      setLoad((current) => {
        if (current.status !== "ready") return current;
        const ready = {
          status: "ready" as const,
          plugins: applyStatusEvents(current.plugins, [pending]),
        };
        pendingWebAppRoots.current.delete(key);
        loadRef.current = ready;
        return ready;
      });
      if (event.kind === "changed") {
        // Installing this exact row invalidates a confirmation for an uninstalled copy.
        setConfirmation((current) =>
          current &&
          current.plugin.id === event.plugin.id &&
          current.plugin.directoryName === event.plugin.directoryName &&
          !isInstalled(current.plugin) &&
          isInstalled(event.plugin)
            ? null
            : current,
        );
      }
    });
    return () => {
      unsubscribe();
      listRequestToken.current += 1;
      workspaceEpoch.current += 1;
      pendingStatusEvents.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, enabled]);

  function replacePlugin(plugin: PluginStatusRecord) {
    setLoad((current) =>
      current.status === "ready"
        ? { status: "ready", plugins: upsertPlugin(current.plugins, plugin) }
        : current,
    );
  }

  // Status events outrank action responses captured before them.
  function replacePluginUnlessSuperseded(
    plugin: PluginStatusRecord,
    revisionAtStart: number,
  ) {
    const newer = pendingStatusEvents.current.get(pluginKey(plugin));
    if (newer && newer.revision > revisionAtStart) return;
    replacePlugin(plugin);
  }

  async function runAction(
    plugin: PluginStatusRecord,
    action: RunnablePluginAction,
  ) {
    const epoch = workspaceEpoch.current;
    const revisionAtStart = statusRevision.current;
    setBusy((current) => ({ ...current, [pluginKey(plugin)]: action }));
    setErrors((current) => ({ ...current, [pluginKey(plugin)]: undefined }));
    try {
      const payload = { workspaceId, pluginId: plugin.id };
      const result =
        action === "install"
          ? await bridge().installPlugin(payload)
          : action === "disable"
            ? await bridge().disablePlugin(payload)
            : action === "enable"
              ? await bridge().enablePlugin(payload)
              : action === "approve"
                ? await bridge().approvePlugin(payload)
                : await bridge().rebuildPlugin(payload);
      if (epoch !== workspaceEpoch.current) return;
      if (result.ok) {
        replacePluginUnlessSuperseded(result.plugin, revisionAtStart);
      } else {
        if (result.plugin) replacePluginUnlessSuperseded(result.plugin, revisionAtStart);
        setErrors((current) => ({
          ...current,
          [pluginKey(plugin)]: actionError(action, plugin.id, result.error),
        }));
      }
    } catch {
      if (epoch !== workspaceEpoch.current) return;
      setErrors((current) => ({
        ...current,
        [pluginKey(plugin)]: `dohc could not ${action} ${plugin.id}. Try again.`,
      }));
    } finally {
      if (epoch === workspaceEpoch.current) {
        setBusy((current) => ({ ...current, [pluginKey(plugin)]: undefined }));
      }
    }
  }

  // The tab opens from main and takes focus there.
  async function openWebApp(plugin: PluginStatusRecord, webAppId: string) {
    if (pendingWebAppRoots.current.has(pluginKey(plugin))) return;
    const current = loadRef.current.status === "ready"
      ? loadRef.current.plugins.find((row) => pluginKey(row) === pluginKey(plugin))
      : undefined;
    if (!current) return;
    const epoch = workspaceEpoch.current;
    const key = webAppKey(plugin.id, webAppId);
    setOpeningWebApp(key);
    setErrors((current) => ({ ...current, [pluginKey(plugin)]: undefined }));
    try {
      await bridge().openPluginWebApp({
        workspaceId,
        pluginRoot: current.rootPath,
        pluginId: plugin.id,
        webAppId,
        // The plugin's page has no instance to name. Per-instance apps are
        // opened by the plugin's own panel, which knows what its instances
        // are, and this page offers no button for one.
        instanceKey: null,
      });
    } catch (error) {
      if (epoch !== workspaceEpoch.current) return;
      const reason = readError(error).words ?? "Try again.";
      setErrors((current) => ({
        ...current,
        [pluginKey(plugin)]: `dohc could not open the app from ${plugin.id}. ${reason}`,
      }));
    } finally {
      if (epoch === workspaceEpoch.current) {
        setOpeningWebApp((current) => (current === key ? null : current));
      }
    }
  }

  async function prepareUninstall(plugin: PluginStatusRecord) {
    const epoch = workspaceEpoch.current;
    const revisionAtStart = statusRevision.current;
    setBusy((current) => ({ ...current, [pluginKey(plugin)]: "preflight" }));
    setErrors((current) => ({ ...current, [pluginKey(plugin)]: undefined }));
    try {
      // A broken manifest can give an unrelated directory the same plugin id.
      const result = await bridge().pluginUninstallPreflight({
        workspaceId,
        pluginId: plugin.id,
        directoryName: plugin.directoryName,
      });
      if (epoch !== workspaceEpoch.current) return;
      if (!result.ok) {
        setErrors((current) => ({
          ...current,
          [pluginKey(plugin)]: `dohc could not check ${plugin.id} before uninstall. ${result.error.message}`,
        }));
        return;
      }
      // Removal, rename, or installation makes the captured preflight obsolete.
      const newer = pendingStatusEvents.current.get(pluginKey(plugin));
      const stalePreflight =
        newer &&
        newer.revision > revisionAtStart &&
        (newer.event.kind === "removed" ||
          (newer.event.kind === "changed" &&
            !isInstalled(plugin) &&
            isInstalled(newer.event.plugin)));
      if (stalePreflight) return;
      setConfirmation({
        plugin,
        confirmationToken: result.confirmationToken,
        preflight: result.preflight,
      });
    } catch {
      if (epoch !== workspaceEpoch.current) return;
      setErrors((current) => ({
        ...current,
        [pluginKey(plugin)]: `dohc could not check ${plugin.id} before uninstall. Try again.`,
      }));
    } finally {
      if (epoch === workspaceEpoch.current) {
        setBusy((current) => ({ ...current, [pluginKey(plugin)]: undefined }));
      }
    }
  }

  async function confirmUninstall() {
    if (!confirmation) return;
    const currentConfirmation = confirmation;
    const pluginId = currentConfirmation.plugin.id;
    const key = pluginKey(currentConfirmation.plugin);
    const epoch = workspaceEpoch.current;
    const revisionAtStart = statusRevision.current;
    setBusy((current) => ({ ...current, [key]: "uninstall" }));
    try {
      const result = await bridge().uninstallPlugin({
        workspaceId,
        pluginId,
        directoryName: currentConfirmation.plugin.directoryName,
        confirmationToken: currentConfirmation.confirmationToken,
      });
      if (epoch !== workspaceEpoch.current) return;
      setConfirmation(null);
      if (result.ok) {
        // The confirmation authorizes removal of this directory only.
        const removedDirectoryName = currentConfirmation.plugin.directoryName;
        setLoad((current) =>
          current.status === "ready"
            ? {
                status: "ready",
                plugins: current.plugins.filter(
                  (plugin) =>
                    !(plugin.id === pluginId
                      && plugin.directoryName === removedDirectoryName),
                ),
              }
            : current,
        );
      } else {
        if (result.plugin) replacePluginUnlessSuperseded(result.plugin, revisionAtStart);
        setErrors((current) => ({
          ...current,
          [key]: `dohc could not uninstall ${pluginId}. ${result.error.message}`,
        }));
      }
    } catch {
      if (epoch !== workspaceEpoch.current) return;
      setConfirmation(null);
      setErrors((current) => ({
        ...current,
        [key]: `dohc could not uninstall ${pluginId}. Run uninstall again.`,
      }));
    } finally {
      if (epoch === workspaceEpoch.current) {
        setBusy((current) => ({ ...current, [key]: undefined }));
      }
    }
  }

  return {
    load,
    busy,
    openingWebApp,
    webAppRootPending: (plugin) => pendingWebAppRoots.current.has(pluginKey(plugin)),
    errors,
    confirmation,
    renamed,
    reload: () => void loadPlugins(),
    runAction: (plugin, action) => void runAction(plugin, action),
    openWebApp: (plugin, webAppId) => void openWebApp(plugin, webAppId),
    prepareUninstall: (plugin) => void prepareUninstall(plugin),
    confirmUninstall: () => void confirmUninstall(),
    cancelUninstall: () => setConfirmation(null),
  };
}
