import { useEffect, useRef, useState } from "react";
import type {
  OfferedPluginRecord,
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

type PluginAction =
  | "install"
  | "disable"
  | "enable"
  | "approve"
  | "rebuild"
  | "preflight"
  | "uninstall"
  | "add";

// install/disable/enable/approve go through runAction's shared dispatch and
// error composition; add has its own bridge call and its own error copy
// (named by the offer's title, not a pluginId), and preflight/uninstall
// already run their own dedicated flows below.
type RunnablePluginAction = Exclude<PluginAction, "preflight" | "uninstall" | "add">;

type PluginLoadState =
  | { status: "loading" }
  | { status: "ready"; plugins: PluginStatusRecord[] }
  | { status: "error"; message: string };

// Tagged with the workspace it was fetched for. usePluginCatalog's own
// epoch/token guards stop a stale response from a previous workspace being
// applied, but a re-render can still observe this hook's state one paint
// behind a workspaceId prop change (React commits the new props before the
// effect that resets this state runs) — the render-time reader below checks
// this tag against the current workspaceId argument rather than trusting
// that ordering.
type OfferedPluginLoadState =
  | { status: "loading" }
  | { status: "ready"; workspaceId: string; offers: OfferedPluginRecord[] }
  | { status: "error"; workspaceId: string; message: string };

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

// Drops any key not in `keys`, returning the same reference when nothing
// changed. An offer's directoryName can equal an installed plugin's id (a
// built-in's manifest name always does), so offer state prunes itself
// against its own list here rather than sharing a namespace an installed
// row also reads from.
function pruneToKeys<T>(
  map: Record<string, T>,
  keys: readonly string[],
): Record<string, T> {
  const keep = new Set(keys);
  const next: Record<string, T> = {};
  let changed = false;
  for (const [key, value] of Object.entries(map)) {
    if (keep.has(key)) {
      next[key] = value;
    } else {
      changed = true;
    }
  }
  return changed ? next : map;
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
      add: "Add",
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
    add: "Adding",
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

// The reverse of Add: a plugin the workspace has never approved has no
// running state to undo, only real workspace files to delete — Install
// requires a valid manifest to run, but undoing an add must not, or a
// broken copy would have no way back at all. This is the one action that
// mirrors Uninstall's confirm shape for a plugin Uninstall's own gate
// (approvedHash !== null) never reaches.
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
type PluginFilterRecord = Pick<
  PluginStatusRecord,
  "directoryName" | "displayName" | "description" | "publisher"
> & { id?: string };

export function matchesFilter(plugin: PluginFilterRecord, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [
    plugin.id ?? null,
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
  errors: Record<string, string | undefined>;
  confirmation: PluginUninstallConfirmation | null;
  /** The most recent rename the pipeline has reported, for a tab tracking
   * one open row to retarget on. Not accumulated as a queue — a consumer
   * only ever cares whether its own (pluginId, directoryName) matches
   * `from`, and this list's own row already moved. */
  renamed: PluginRenamedFact | null;
  /** Built-in driver plugins this workspace doesn't have yet. */
  offersLoad: OfferedPluginLoadState;
  /** Keyed by offer directoryName, never by a plugin id — an offer's error
   * and busy state must never leak onto an installed row that later claims
   * the same identity. */
  offerBusy: Record<string, boolean>;
  offerErrors: Record<string, string | undefined>;
  reload: () => void;
  runAction: (
    plugin: PluginStatusRecord,
    action: RunnablePluginAction,
  ) => void;
  addOffer: (offer: OfferedPluginRecord) => void;
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
  const [offersLoad, setOffersLoad] = useState<OfferedPluginLoadState>({ status: "loading" });
  const [offerBusy, setOfferBusy] = useState<Record<string, boolean>>({});
  const [offerErrors, setOfferErrors] = useState<Record<string, string | undefined>>({});
  // The request token orders list responses. The workspace epoch invalidates
  // list and action responses after unmount or a workspace switch. Offers
  // are a separate bridge call from the plugin list, so they order their own
  // responses against their own token, but share the one epoch — a single
  // workspace lifecycle governs both.
  const listRequestToken = useRef(0);
  const offersRequestToken = useRef(0);
  const workspaceEpoch = useRef(0);
  // Status events can arrive while the initial list is in flight. Keep the
  // newest event for each plugin and merge it over that list before painting.
  const statusRevision = useRef(0);
  const pendingStatusEvents = useRef(new Map<string, PendingStatusEvent>());
  // The authoritative offered set as of the last successful loadOffers —
  // read at Add's settle time, not captured in addOffer's own closure,
  // which would still hold whatever was current when Add was CALLED. An
  // offer can leave this list (added from elsewhere, its source deleted)
  // while Add is still in flight; a refused response settling after that
  // must not recreate an error key loadOffers already pruned for an offer
  // that no longer exists to show it against.
  const offeredDirectoryNames = useRef<ReadonlySet<string>>(new Set());

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

  async function loadOffers() {
    const requestToken = ++offersRequestToken.current;
    const epoch = workspaceEpoch.current;
    const forWorkspaceId = workspaceId;
    // A background refresh (a "changed"/"removed" status event, or a manual
    // reload while data already exists) keeps the current ready list on
    // screen instead of flashing to loading: setStatus emits several
    // "changed" events per action, and flipping the whole Built in section
    // to loading on each would hide its rows and Add controls repeatedly.
    // Only the very first load, with nothing to show yet for this
    // workspace, presents as loading.
    setOffersLoad((current) =>
      current.status === "ready" && current.workspaceId === forWorkspaceId
        ? current
        : { status: "loading" },
    );
    try {
      const result = await bridge().listOfferedPlugins({ workspaceId });
      if (
        requestToken !== offersRequestToken.current ||
        epoch !== workspaceEpoch.current
      ) {
        return;
      }
      if (!result.ok) {
        setOffersLoad({
          status: "error",
          workspaceId: forWorkspaceId,
          message: `Offers could not load. ${result.error.message}`,
        });
        return;
      }
      setOffersLoad({ status: "ready", workspaceId: forWorkspaceId, offers: result.offers });
      // An offer's error/busy state belongs to it only while it is still
      // offered — once a refresh's authoritative list no longer includes a
      // directoryName, whatever it recorded here is stale and must not
      // survive to be misread against whatever claims that identity next.
      const offeredNames = result.offers.map((offer) => offer.directoryName);
      offeredDirectoryNames.current = new Set(offeredNames);
      setOfferErrors((current) => pruneToKeys(current, offeredNames));
      setOfferBusy((current) => pruneToKeys(current, offeredNames));
    } catch (error) {
      if (
        requestToken !== offersRequestToken.current ||
        epoch !== workspaceEpoch.current
      ) {
        return;
      }
      const reason = error instanceof Error ? error.message : "Try again.";
      setOffersLoad({
        status: "error",
        workspaceId: forWorkspaceId,
        message: `Offers could not load. ${reason}`,
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
    setOffersLoad({ status: "loading" });
    setOfferBusy({});
    setOfferErrors({});
    offeredDirectoryNames.current = new Set();
    pendingStatusEvents.current.clear();
    statusRevision.current = 0;
    void loadPlugins();
    void loadOffers();
    const unsubscribe = bridge().onPluginStatusChanged((event) => {
      if (epoch !== workspaceEpoch.current || event.workspaceId !== workspaceId) {
        return;
      }
      if (event.kind === "discovery-changed") {
        // An invalid, never-installed candidate names no pluginId a
        // "changed"/"removed" event could carry, so it never joins
        // pendingStatusEvents/applyStatusEvents — those exist to merge one
        // plugin's own transition, and this names no plugin at all.
        // Discovery itself moved; both surfaces that read it directly
        // (list() shows an invalid row, offers hide behind or return to
        // one) re-check.
        void loadPlugins(true);
        void loadOffers();
        return;
      }
      if (event.kind === "renamed") {
        const oldKey = pluginKey({ id: event.pluginId, directoryName: event.from });
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
        } else {
          void loadPlugins(true);
        }
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
        return {
          status: "ready",
          plugins: applyStatusEvents(current.plugins, [pending]),
        };
      });
      if (event.kind === "removed" || event.kind === "changed") {
        // A plugin's identity can move either direction: an uninstall frees
        // a directory (removed) an offer might now fit again, and a fresh
        // discovery can claim an id a built-in offer was suppressing under
        // a different directory (changed) — a rename or a second copy this
        // hook never directly caused. Offers have no per-event incremental
        // merge the way plugins do, so any identity change re-fetches
        // rather than guessing which offer (if any) is affected.
        void loadOffers();
      }
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
      offersRequestToken.current += 1;
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
    const epoch = workspaceEpoch.current;
    const key = webAppKey(plugin.id, webAppId);
    setOpeningWebApp(key);
    setErrors((current) => ({ ...current, [pluginKey(plugin)]: undefined }));
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
        // Uninstall's own "removed" status event covers this too, but this
        // caller already knows the outcome — no reason to wait for the event
        // to round-trip back through main.
        void loadOffers();
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

  // addOffer runs its own bridge call, busy map, and error copy, entirely
  // separate from runAction's: an offer's directoryName can equal an
  // installed plugin's id (a built-in's manifest name always does), so
  // sharing busy/errors with plugin actions would let a refused Add's error
  // reappear under an unrelated installed row once the offer's identity
  // moved on.
  async function addOffer(offer: OfferedPluginRecord) {
    const epoch = workspaceEpoch.current;
    const revisionAtStart = statusRevision.current;
    const directoryName = offer.directoryName;
    const title = offer.displayName ?? directoryName;
    setOfferBusy((current) => ({ ...current, [directoryName]: true }));
    setOfferErrors((current) => ({ ...current, [directoryName]: undefined }));
    try {
      const result = await bridge().addOfferedPlugin({ workspaceId, directoryName });
      if (epoch !== workspaceEpoch.current) return;
      if (result.ok) {
        setOffersLoad((current) =>
          current.status === "ready" && current.workspaceId === workspaceId
            ? {
                status: "ready",
                workspaceId,
                offers: current.offers.filter(
                  (entry) => entry.directoryName !== directoryName,
                ),
              }
            : current,
        );
        // Upserted in the same tick the offer disappears, so the plugin
        // never spends a render in neither the offered nor the installed
        // section.
        replacePluginUnlessSuperseded(result.plugin, revisionAtStart);
      } else if (offeredDirectoryNames.current.has(directoryName)) {
        // Bound to the offer's presence at settle time, not addOffer's own
        // call-time closure: a refused response for an offer that already
        // left the authoritative list (added elsewhere, its source gone)
        // has no row left to show an error against, and setting one here
        // would resurrect a key loadOffers already pruned.
        setOfferErrors((current) => ({
          ...current,
          [directoryName]: `dohc could not add ${title}. ${result.error.message}`,
        }));
      }
    } catch (error) {
      if (epoch !== workspaceEpoch.current) return;
      if (offeredDirectoryNames.current.has(directoryName)) {
        const reason = error instanceof Error ? error.message : "Try again.";
        setOfferErrors((current) => ({
          ...current,
          [directoryName]: `dohc could not add ${title}. ${reason}`,
        }));
      }
    } finally {
      if (epoch === workspaceEpoch.current) {
        setOfferBusy((current) => ({ ...current, [directoryName]: false }));
      }
    }
  }

  // React commits a new workspaceId prop before this hook's own effect runs
  // to reset offersLoad — a render can observe this state one paint behind
  // the prop it was tagged for. Every non-"loading" variant carries the
  // workspaceId it was fetched for, so this checks it against the current
  // argument (always fresh — it's this render's own parameter) rather than
  // trusting that the effect already ran. The renderer invariant: exposed
  // data is for this workspace or it doesn't get exposed at all.
  const offersLoadForWorkspace: OfferedPluginLoadState =
    offersLoad.status !== "loading" && offersLoad.workspaceId !== workspaceId
      ? { status: "loading" }
      : offersLoad;

  return {
    load,
    busy,
    openingWebApp,
    errors,
    confirmation,
    renamed,
    offersLoad: offersLoadForWorkspace,
    offerBusy,
    offerErrors,
    reload: () => {
      void loadPlugins();
      void loadOffers();
    },
    runAction: (plugin, action) => void runAction(plugin, action),
    addOffer: (offer) => void addOffer(offer),
    openWebApp: (plugin, webAppId) => void openWebApp(plugin, webAppId),
    prepareUninstall: (plugin) => void prepareUninstall(plugin),
    confirmUninstall: () => void confirmUninstall(),
    cancelUninstall: () => setConfirmation(null),
  };
}
