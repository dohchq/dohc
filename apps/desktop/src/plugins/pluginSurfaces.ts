import {
  clearPluginWebAppPartition,
  createPluginWebAppGuest,
  type GuestBounds,
  type GuestViewLike,
  type GuestWebPreferences,
} from "./pluginWebAppGuest";
import { stopPluginPanelPreview, type PluginPanelPreview } from "./pluginPanelLifecycle";
import { recoverConsumedWebAppCredential } from "./pluginWebAppRecovery";
import {
  createPluginPanelSdkAuthorityRegistry,
  type PluginPanelSdkGrant,
} from "./pluginPanelSdkAuthority";
import { withKeyedStartLock } from "../workspaces/sitePreviewLifecycle";
import type {
  PluginHostPanelDeclaration,
  PluginHostRecordToken,
} from "./PluginHost";

export interface PluginSurfaceIdentity {
  workspaceId: string;
  pluginId: string;
}

export interface PluginPanelIdentity extends PluginSurfaceIdentity {
  panelId: string;
}

export interface PluginWebAppIdentity extends PluginSurfaceIdentity {
  webAppId: string;
  instanceKey: string | null;
}

export interface PluginSurfaceOwner {
  senderId: number;
  generation: number;
}

export interface PluginSurfaceHostLease {
  /** Starts through this exact lease and returns the spawn it admitted. */
  start(): Promise<string>;
  /** Reads the live spawn from the same host that owns this lease. */
  currentSpawnId(): string | undefined;
  release(): Promise<void>;
}

interface PluginPanelHostBinding {
  readonly spawnId: string;
  readonly hostRecord: PluginHostRecordToken;
  readonly panel: PluginHostPanelDeclaration;
}

export interface PluginPanelHostLease extends PluginSurfaceHostLease {
  /** Reads the exact host record that owns the live spawn. */
  currentRecord(): PluginHostRecordToken | undefined;
  startPanel(panelId: string): Promise<PluginPanelHostBinding>;
}

export interface PluginWebAppHostLease extends PluginSurfaceHostLease {
  startWebApp(): Promise<{ url: string; title?: string }>;
  unpair(expectedSpawnId: string): Promise<void>;
}

export interface PluginPanelStartRequest
  extends PluginPanelIdentity,
    PluginSurfaceOwner {
  placement: "editor" | "view";
}

export interface PluginPanelStartAdmission {
  assertAllowed(): void;
  acquireHostLease(): Promise<PluginPanelHostLease>;
  startPreview(
    panel: PluginHostPanelDeclaration,
  ): Promise<Omit<PluginPanelPreview, "releaseOrigin">>;
}

export interface PluginWebAppViewLike extends GuestViewLike {
  webContents: GuestViewLike["webContents"] & {
    isDestroyed(): boolean;
    close(): void;
    setZoomLevel(level: number): void;
  };
  setBounds(bounds: GuestBounds): void;
}

export interface PluginWebAppContainer<V extends PluginWebAppViewLike> {
  isDestroyed(): boolean;
  attach(view: V): void;
  detach(view: V): void;
}

export interface PluginWebAppStartRequest<V extends PluginWebAppViewLike>
  extends PluginWebAppIdentity,
    PluginSurfaceOwner {
  workspaceRoot: string;
  container: PluginWebAppContainer<V>;
}

export interface PluginWebAppStartAdmission {
  assertInstanceBudget(liveAndReservedOtherInstances: number): void;
  assertAllowed(): void;
  acquireHostLease(): Promise<PluginWebAppHostLease>;
}

export interface PluginPanelSdkAuthorizationRequest
  extends PluginPanelIdentity {
  senderId: number;
  currentGeneration(): number;
  activeWorkspaceId(): string | undefined;
  liveSpawnId(): string | undefined;
}

export interface PluginPanelSdkAuthorization {
  authority: PluginPanelSdkGrant;
  surfaceId: number;
  isPushLive(): boolean;
}

interface PluginPanelSdkGrantSuspension {
  restore(): Promise<void>;
  commit(): void;
}

export interface PluginWebAppBoundsRequest
  extends PluginWebAppIdentity,
    PluginSurfaceOwner {
  bounds: GuestBounds;
  visible: boolean;
  zoomFactor: number;
}

export type PluginSurfaceStopTarget =
  | ({ kind: "panel"; owner?: PluginSurfaceOwner } & PluginPanelIdentity)
  | ({ kind: "web-app"; owner?: PluginSurfaceOwner } & PluginWebAppIdentity)
  | { kind: "sender"; senderId: number }
  | ({
      kind: "plugin";
      clearPartition?: { workspaceRoot: string };
    } & PluginSurfaceIdentity)
  | { kind: "workspace"; workspaceId: string };

export type PluginSurfaceHostChange = {
  kind: "terminal";
} & PluginSurfaceIdentity;

export interface PluginSurfaceHostReady extends PluginSurfaceIdentity {
  spawnId: string;
  hostRecord: PluginHostRecordToken;
  declaredPanels: readonly PluginHostPanelDeclaration[];
}

export interface PluginSurfacesDependencies<V extends PluginWebAppViewLike> {
  ViewClass: new (options: { webPreferences: GuestWebPreferences }) => V;
  bindWebAppZoom(webContents: V["webContents"]): void;
  allowPanelOrigin(url: string): () => void;
  clearPanelStorage(options: { origin: string }): Promise<void>;
  clearGuestPartition(partition: string): Promise<void>;
  notifyWebAppFailed(input: PluginWebAppIdentity & PluginSurfaceOwner): void;
  notifyPanelInvalidated(
    input: PluginPanelIdentity & PluginSurfaceOwner & { surfaceId: number },
  ): void;
  onPanelAuthorityRevoked?(
    input: PluginPanelIdentity & { surfaceId: number },
  ): void;
  onError(error: unknown, context: string): void;
}

type PanelGrant = ReturnType<
  ReturnType<typeof createPluginPanelSdkAuthorityRegistry>["register"]
>;

interface OwnedLease<L extends PluginSurfaceHostLease = PluginSurfaceHostLease> {
  readonly lease: L;
  releasePromise: Promise<void> | null;
}

interface PanelRecord extends PluginPanelIdentity, PluginSurfaceOwner {
  placement: "editor" | "view";
  entry: string;
  hostRecord: PluginHostRecordToken;
  surfaceId: number;
  preview: PluginPanelPreview;
  ownedLease: OwnedLease<PluginPanelHostLease>;
  grant: PanelGrant;
  attempt: PanelAttempt;
  closed: boolean;
  disposed: boolean;
}

interface PanelAttempt {
  readonly request: PluginPanelStartRequest;
  hostEpoch: number;
  ownedLease: OwnedLease<PluginPanelHostLease> | null;
  cancelled: boolean;
  active: boolean;
  record: PanelRecord | null;
}

interface SuspendedPanelGrant {
  readonly record: PanelRecord;
  readonly grant: PanelGrant;
  readonly hostEpoch: number;
  readonly spawnId: string | undefined;
  readonly hostRecord: PluginHostRecordToken | undefined;
  finalized: boolean;
}

interface WebAppRecord<V extends PluginWebAppViewLike>
  extends PluginWebAppIdentity,
    PluginSurfaceOwner {
  view: V;
  container: PluginWebAppContainer<V>;
  ownedLease: OwnedLease;
  attempt: WebAppAttempt<V>;
  closed: boolean;
  disposed: boolean;
}

interface PendingWebAppView<V extends PluginWebAppViewLike> {
  view: V;
  container: PluginWebAppContainer<V>;
}

interface WebAppAttempt<V extends PluginWebAppViewLike> {
  readonly request: PluginWebAppStartRequest<V>;
  readonly hostEpoch: number;
  ownedLease: OwnedLease<PluginWebAppHostLease> | null;
  spawnId: string | null;
  record: WebAppRecord<V> | null;
  pendingView: PendingWebAppView<V> | null;
  displaced: WebAppRecord<V>[];
  credentialConsumed: boolean;
  navigationSucceeded: boolean;
  recoveryQueued: boolean;
  notified: boolean;
  cancelled: boolean;
  live: boolean;
}

interface InstanceReservation {
  readonly group: string;
  readonly identity: string;
  active: boolean;
}

function panelKey(input: PluginPanelIdentity): string {
  return `${input.workspaceId}\0${input.pluginId}\0${input.panelId}`;
}

function webAppKey(input: PluginWebAppIdentity): string {
  return `${input.workspaceId}\0${input.pluginId}\0${input.webAppId}\0${input.instanceKey ?? ""}`;
}

function sameOwner(
  record: PluginSurfaceOwner,
  owner: PluginSurfaceOwner,
): boolean {
  return (
    record.senderId === owner.senderId && record.generation === owner.generation
  );
}

export class PluginSurfaces<V extends PluginWebAppViewLike> {
  readonly #dependencies: PluginSurfacesDependencies<V>;
  readonly #panelAuthorities = createPluginPanelSdkAuthorityRegistry();
  readonly #panels = new Map<string, PanelRecord>();
  readonly #webApps = new Map<string, WebAppRecord<V>>();
  readonly #panelLanes = new Map<string, Promise<void>>();
  readonly #webAppLanes = new Map<string, Promise<void>>();
  readonly #panelAttempts = new Set<PanelAttempt>();
  readonly #webAppAttempts = new Set<WebAppAttempt<V>>();
  readonly #instanceReservations = new Map<string, Map<string, number>>();
  readonly #pluginExclusions = new Map<string, Promise<void>>();
  readonly #hostEpochs = new Map<string, number>();
  readonly #hardenedGuestPartitions = new Set<string>();
  readonly #tentativePanelGrantRevocations = new WeakSet<AbortSignal>();
  #nextPanelSurfaceId = 1;
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(dependencies: PluginSurfacesDependencies<V>) {
    this.#dependencies = dependencies;
  }

  startPanel(
    request: PluginPanelStartRequest,
    admission: PluginPanelStartAdmission,
  ): Promise<{ url: string; title: string; surfaceId: number }> {
    this.#assertOpen();
    const key = panelKey(request);
    // Register before entering the lane so a scope stop can include starts
    // that it accepted but that have not installed a record yet.
    const attempt: PanelAttempt = {
      request,
      hostEpoch: this.#hostEpoch(request),
      ownedLease: null,
      cancelled: false,
      active: true,
      record: null,
    };
    this.#panelAttempts.add(attempt);
    const pluginBarrier = this.#pluginExclusions.get(this.#pluginKey(request));
    return this.#inPanelLane(request, async () => {
      await pluginBarrier?.catch(() => undefined);
      let ownedLease: OwnedLease<PluginPanelHostLease> | null = null;
      let hostBinding: PluginPanelHostBinding | null = null;
      let preview: Omit<PluginPanelPreview, "releaseOrigin"> | null = null;
      let installed: PanelRecord | null = null;
      try {
        this.#assertPanelStartActive(attempt);
        admission.assertAllowed();
        ownedLease = this.#ownLease(await admission.acquireHostLease());
        attempt.ownedLease = ownedLease;
        this.#assertPanelStartActive(attempt);
        hostBinding = await ownedLease.lease.startPanel(request.panelId);
        this.#assertPanelStartActive(attempt);
        if (
          hostBinding.panel.id !== request.panelId ||
          hostBinding.panel.placement !== request.placement
        ) {
          throw new Error(
            `Plugin "${request.pluginId}" panel "${request.panelId}" has placement ` +
              `"${hostBinding.panel.placement}", so it cannot open with placement ` +
              `"${request.placement}".`,
          );
        }
        preview = await admission.startPreview(hostBinding.panel);
        this.#assertPanelStartActive(attempt);
        admission.assertAllowed();
        this.#assertPanelStartActive(attempt);
        this.#assertPanelHostCurrent(attempt, ownedLease, hostBinding);
        const releaseOrigin = this.#dependencies.allowPanelOrigin(preview.url);
        this.#assertPanelStartActive(attempt);
        const surfaceId = this.#nextPanelSurfaceId;
        this.#nextPanelSurfaceId += 1;
        const grant = this.#registerPanelGrant({ ...request, surfaceId });
        const next: PanelRecord = {
          ...request,
          entry: hostBinding.panel.entry,
          hostRecord: hostBinding.hostRecord,
          surfaceId,
          preview: { ...preview, releaseOrigin },
          ownedLease,
          grant,
          attempt,
          closed: false,
          disposed: false,
        };
        const previous = this.#panels.get(key);
        this.#panels.set(key, next);
        installed = next;
        attempt.record = next;
        preview = null;
        this.#assertPanelStartActive(attempt);
        if (previous) await this.#disposePanel(previous);
        this.#assertPanelStartActive(attempt);
        this.#assertPanelHostCurrent(attempt, ownedLease, hostBinding);
        return {
          url: next.preview.url,
          title: hostBinding.panel.title,
          surfaceId,
        };
      } catch (error) {
        if (installed && this.#panels.get(key) === installed) {
          this.#panels.delete(key);
          this.#panelAuthorities.revokePanel(
            installed.workspaceId,
            installed.pluginId,
            installed.panelId,
          );
          await this.#disposePanel(installed);
        } else {
          if (preview) {
            await this.#disposeLoosePanelPreview(preview, request);
          }
          if (ownedLease) {
            await this.#releaseLease(ownedLease, request.pluginId);
          }
          this.#retirePanelAttempt(attempt);
        }
        throw error;
      }
    });
  }

  async startWebApp(
    request: PluginWebAppStartRequest<V>,
    admission: PluginWebAppStartAdmission,
  ): Promise<{ origin: string; title?: string }> {
    this.#assertOpen();
    const key = webAppKey(request);
    // Different instances use different lanes. Reserve across all of them
    // synchronously so two starts cannot both claim the last process slot.
    const reservation = this.#reserveInstance(request, admission);
    const attempt: WebAppAttempt<V> = {
      request,
      hostEpoch: this.#hostEpoch(request),
      ownedLease: null,
      spawnId: null,
      record: null,
      pendingView: null,
      displaced: [],
      credentialConsumed: false,
      navigationSucceeded: false,
      recoveryQueued: false,
      notified: false,
      cancelled: false,
      live: true,
    };
    this.#webAppAttempts.add(attempt);
    const pluginBarrier = this.#pluginExclusions.get(this.#pluginKey(request));
    return this.#inWebAppLane(request, async () => {
      await pluginBarrier?.catch(() => undefined);
      try {
        this.#assertWebAppStartActive(attempt);
        admission.assertAllowed();
        const ownedLease = this.#ownLease(await admission.acquireHostLease());
        attempt.ownedLease = ownedLease;
        this.#assertWebAppStartActive(attempt);
        const spawnId = await ownedLease.lease.start();
        attempt.spawnId = spawnId;
        this.#assertWebAppStartActive(attempt);
        await this.#retirePendingWebAppPredecessor(request);
        this.#assertWebAppStartActive(attempt);
        const started = await ownedLease.lease.startWebApp();
        attempt.credentialConsumed = true;
        this.#assertWebAppStartActive(attempt);
        this.#assertWebAppHostCurrent(attempt, ownedLease, spawnId);
        admission.assertAllowed();
        this.#assertWebAppStartActive(attempt);
        if (request.container.isDestroyed()) {
          throw new Error("The plugin web app request has no open window.");
        }
        this.#assertWebAppStartActive(attempt);
        const guest = createPluginWebAppGuest({
          workspaceRoot: request.workspaceRoot,
          pluginId: request.pluginId,
          url: started.url,
          hardenedPartitions: this.#hardenedGuestPartitions,
          ViewClass: this.#dependencies.ViewClass,
          onViewCreated: (view) => {
            attempt.pendingView = { view, container: request.container };
          },
          attach: (view) => {
            this.#dependencies.bindWebAppZoom(view.webContents);
            this.#assertWebAppStartActive(attempt);
            request.container.attach(view);
            this.#assertWebAppStartActive(attempt);
            const next: WebAppRecord<V> = {
              workspaceId: request.workspaceId,
              pluginId: request.pluginId,
              webAppId: request.webAppId,
              instanceKey: request.instanceKey,
              senderId: request.senderId,
              generation: request.generation,
              view,
              container: request.container,
              ownedLease,
              attempt,
              closed: false,
              disposed: false,
            };
            const previous = this.#webApps.get(key);
            if (previous) {
              previous.closed = true;
              this.#retireWebAppAttempt(previous.attempt);
              attempt.displaced.push(previous);
            }
            this.#webApps.set(key, next);
            attempt.record = next;
            attempt.pendingView = null;
            this.#releaseInstanceReservation(reservation);
          },
          onLoadFailure: () => this.#queueRecovery(attempt),
          onLoadSuccess: () => {
            attempt.navigationSucceeded = true;
          },
        });
        for (const displaced of attempt.displaced.splice(0)) {
          await this.#disposeWebApp(displaced);
        }
        this.#assertWebAppStartActive(attempt);
        this.#assertWebAppHostCurrent(attempt, ownedLease, spawnId);
        return { origin: guest.origin, title: started.title };
      } catch (error) {
        if (
          attempt.cancelled &&
          attempt.credentialConsumed &&
          !attempt.navigationSucceeded
        ) {
          // Cancellation can overtake either credential delivery or displaced
          // record cleanup before navigation succeeds. Recover while this
          // attempt still owns the identity lane; its queued stop would
          // otherwise retire the attempt before detached recovery can unpair.
          await this.#recoverCancelledConsumedAttempt(attempt);
        } else if (
          attempt.credentialConsumed &&
          this.#attemptMayRecover(attempt)
        ) {
          this.#queueRecovery(attempt);
        } else {
          await this.#disposeAttempt(attempt);
        }
        throw error;
      }
    }).finally(() => this.#releaseInstanceReservation(reservation));
  }

  authorizePanelSdk(
    request: PluginPanelSdkAuthorizationRequest,
  ): PluginPanelSdkAuthorization {
    const key = panelKey(request);
    const record = this.#panels.get(key);
    const generation = request.currentGeneration();
    const liveSpawnId = request.liveSpawnId();
    const authority = this.#panelAuthorities.authorize({
      senderId: request.senderId,
      generation,
      activeWorkspaceId: request.activeWorkspaceId(),
      workspaceId: request.workspaceId,
      pluginId: request.pluginId,
      panelId: request.panelId,
      panelRunning: Boolean(
        record &&
          !record.closed &&
          record.senderId === request.senderId &&
          record.generation === generation,
      ),
      liveSpawnId,
    });
    if (!record || record.grant.signal !== authority.signal) {
      throw new Error("Plugin panel SDK authority is stale.");
    }
    const hostEpoch = this.#hostEpoch(record);
    return {
      authority,
      surfaceId: record.surfaceId,
      // files.watch retains this predicate after the SDK call returns. A
      // failed host stop replaces the grant in the same host epoch, so that
      // subscription resumes; a real host change advances the epoch and the
      // old subscription stays dead after successor readiness.
      isPushLive: () =>
        Boolean(
          this.#panels.get(key) === record &&
            !record.closed &&
            !record.grant.signal.aborted &&
            this.#hostEpoch(record) === hostEpoch &&
            record.senderId === request.senderId &&
            record.generation === request.currentGeneration() &&
            request.activeWorkspaceId() === request.workspaceId &&
            request.liveSpawnId() === record.ownedLease.lease.currentSpawnId(),
        ),
    };
  }

  applyWebAppBounds(request: PluginWebAppBoundsRequest): boolean {
    const record = this.#webApps.get(webAppKey(request));
    if (!record || record.closed || !sameOwner(record, request)) return false;
    record.view.setBounds({
      x: Math.round(request.bounds.x * request.zoomFactor),
      y: Math.round(request.bounds.y * request.zoomFactor),
      width: Math.round(request.bounds.width * request.zoomFactor),
      height: Math.round(request.bounds.height * request.zoomFactor),
    });
    record.view.setVisible(request.visible);
    return true;
  }

  applyWebAppZoom(level: number): void {
    for (const record of this.#webApps.values()) {
      if (!record.closed && !record.view.webContents.isDestroyed()) {
        record.view.webContents.setZoomLevel(level);
      }
    }
  }

  revokePluginSdkGrants(identity: PluginSurfaceIdentity): void {
    if (this.#closed) return;
    for (const record of this.#panels.values()) {
      if (
        record.workspaceId !== identity.workspaceId ||
        record.pluginId !== identity.pluginId
      ) {
        continue;
      }
      this.#panelAuthorities.revokePanel(
        record.workspaceId,
        record.pluginId,
        record.panelId,
      );
    }
  }

  async withPluginSdkGrantSuspensions<
    Result extends { readonly ok: boolean },
  >(
    run: (
      suspend: (identity: PluginSurfaceIdentity) => void,
    ) => Promise<Result>,
  ): Promise<Result> {
    const suspensions: PluginPanelSdkGrantSuspension[] = [];
    const restore = () =>
      Promise.all(suspensions.map((suspension) => suspension.restore()));
    try {
      const result = await run((identity) => {
        suspensions.push(this.#suspendPluginSdkGrants(identity));
      });
      if (result.ok) {
        for (const suspension of suspensions) suspension.commit();
      } else {
        await restore();
      }
      return result;
    } catch (error) {
      await restore();
      throw error;
    }
  }

  #suspendPluginSdkGrants(
    identity: PluginSurfaceIdentity,
  ): PluginPanelSdkGrantSuspension {
    if (this.#closed) {
      return { commit: () => undefined, restore: () => Promise.resolve() };
    }
    // Capture the whole rollback set before revoking anything. If one lease
    // cannot report its spawn, the caller receives no suspension handle, so a
    // partial revocation here would have no reverse path.
    const suspended = [...this.#panels.values()]
      .filter(
        (record) =>
          record.workspaceId === identity.workspaceId &&
          record.pluginId === identity.pluginId &&
          !record.closed &&
          record.attempt.active &&
          !record.grant.signal.aborted,
      )
      .map((record): SuspendedPanelGrant => ({
        record,
        grant: record.grant,
        hostEpoch: this.#hostEpoch(record),
        spawnId: record.ownedLease.lease.currentSpawnId(),
        hostRecord: record.ownedLease.lease.currentRecord(),
        finalized: false,
      }));
    for (const { record, grant } of suspended) {
      // Subscription cleanup is destructive and cannot be reconstructed from
      // a grant. Defer it until the action's result says whether this abort is
      // permanent; the aborted grant still blocks calls and event delivery.
      this.#tentativePanelGrantRevocations.add(grant.signal);
      this.#panelAuthorities.revokePanel(
        record.workspaceId,
        record.pluginId,
        record.panelId,
      );
    }

    let restorePromise: Promise<void> | null = null;
    return {
      commit: () => {
        for (const snapshot of suspended) {
          this.#finalizeSuspendedPanelGrant(snapshot);
        }
      },
      restore: () => {
        if (restorePromise) return restorePromise;
        restorePromise = Promise.all(
          suspended.map((snapshot) => {
            const { record, grant, hostEpoch, spawnId, hostRecord } = snapshot;
            return this.#inPanelLane(record, async () => {
              if (
                this.#closed ||
                record.closed ||
                !record.attempt.active ||
                record.attempt.cancelled ||
                this.#panels.get(panelKey(record)) !== record ||
                record.grant !== grant ||
                !grant.signal.aborted ||
                this.#hostEpoch(record) !== hostEpoch ||
                spawnId === undefined ||
                hostRecord === undefined ||
                record.ownedLease.lease.currentSpawnId() !== spawnId ||
                record.ownedLease.lease.currentRecord() !== hostRecord
              ) {
                this.#finalizeSuspendedPanelGrant(snapshot);
                return;
              }
              record.grant = this.#registerPanelGrant(record);
            }).catch((error) => {
              this.#finalizeSuspendedPanelGrant(snapshot);
              this.#report(
                error,
                `restore suspended plugin panel authority for "${record.pluginId}"`,
              );
            });
          }),
        ).then(() => undefined);
        return restorePromise;
      },
    };
  }

  hostChanged(change: PluginSurfaceHostChange): void {
    if (this.#closed) return;
    this.#advanceHostEpoch(change);
    this.revokePluginSdkGrants(change);
    const webAppAttempts = this.#webAppAttemptsForStop({
      kind: "plugin",
      workspaceId: change.workspaceId,
      pluginId: change.pluginId,
    });
    // Notify before either cleanup path enters a lane. A recovery already
    // queued ahead of the host stop can observe the new epoch and retire the
    // attempt before that stop gets its turn.
    for (const attempt of webAppAttempts) {
      if (attempt.record && this.#attemptOwnsSurface(attempt)) {
        this.#notifyWebAppFailed(attempt);
      }
    }
    void this.#settleCleanup(
      webAppAttempts.map((attempt) => this.#stopWebAppAttempt(attempt, false)),
      `stop plugin web apps after host change for "${change.pluginId}"`,
    );
  }

  hostReady(identity: PluginSurfaceHostReady): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const readyEpoch = this.#hostEpoch(identity);
    const panels = [...this.#panels.values()].filter(
      (record) =>
        record.workspaceId === identity.workspaceId &&
        record.pluginId === identity.pluginId &&
        record.grant.signal.aborted,
    );
    const declaredPanels = new Map(
      identity.declaredPanels.map((panel) => [panel.id, panel]),
    );
    return Promise.all(
      panels.map((record) => {
        const declaration = declaredPanels.get(record.panelId);
        if (
          !declaration ||
          identity.hostRecord !== record.hostRecord ||
          declaration.placement !== record.placement ||
          declaration.entry !== record.entry
        ) {
          // Stop the exact retained attempt. A newly admitted panel with the
          // same key can already be queued behind it after the catalog update;
          // that successor was checked against the new declaration and must
          // not be cancelled with the stale record.
          if (!record.attempt.cancelled) {
            record.attempt.cancelled = true;
            this.#notifyPanelInvalidated(record);
          }
          return this.#stopPanelAttempt(record.attempt);
        }
        return this.#inPanelLane(record, async () => {
          // A later host end, stop, replacement, or close supersedes this
          // queued ready event. Recheck the grant too so repeated ready
          // events cannot replace a grant the first event already restored.
          if (
            this.#closed ||
            record.attempt.cancelled ||
            this.#hostEpoch(record) !== readyEpoch ||
            this.#panels.get(panelKey(record)) !== record ||
            record.closed ||
            !record.grant.signal.aborted ||
            record.ownedLease.lease.currentSpawnId() !== identity.spawnId ||
            record.ownedLease.lease.currentRecord() !== identity.hostRecord
          ) {
            return;
          }
          record.attempt.hostEpoch = readyEpoch;
          record.grant = this.#registerPanelGrant(record);
        });
      }),
    ).then(() => undefined).catch((error) => {
      this.#report(
        error,
        `regrant plugin panels after host ready for "${identity.pluginId}"`,
      );
    });
  }

  stop(target: PluginSurfaceStopTarget): Promise<void> {
    const ownerError = this.#exactOwnerError(target);
    if (ownerError) return Promise.reject(ownerError);
    this.#revokeForStop(target);
    const panelAttempts = this.#panelAttemptsForStop(target);
    const webAppAttempts = this.#webAppAttemptsForStop(target);
    // Cancellation is the scope cutoff. Lane cleanup comes later, but an
    // accepted start crossing any await after this point cannot commit.
    this.#cancelAttempts(panelAttempts, webAppAttempts);
    if (target.kind === "plugin") {
      return this.#stopPluginUnderExclusion(
        target,
        panelAttempts,
        webAppAttempts,
      );
    }
    return this.#settleCleanup(
      [
        ...panelAttempts.map((attempt) => this.#stopPanelAttempt(attempt)),
        ...webAppAttempts.map((attempt) => this.#stopWebAppAttempt(attempt, false)),
      ],
      `stop plugin surfaces for ${target.kind}`,
    );
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#panelAuthorities.revokeAll();
    for (const attempt of this.#webAppAttempts) {
      this.#advanceHostEpoch(attempt.request);
    }
    const panelAttempts = [...this.#panelAttempts];
    const webAppAttempts = [...this.#webAppAttempts];
    this.#cancelAttempts(panelAttempts, webAppAttempts);
    const pluginExclusions = [...this.#pluginExclusions.values()];
    this.#closePromise = this.#settleCleanup(
      [
        ...pluginExclusions,
        ...panelAttempts.map((attempt) => this.#stopPanelAttempt(attempt)),
        ...webAppAttempts.map((attempt) => this.#stopWebAppAttempt(attempt, false)),
      ],
      "close plugin surfaces",
    );
    return this.#closePromise;
  }

  #registerPanelGrant(
    record: PluginPanelIdentity & PluginSurfaceOwner & { surfaceId: number },
  ): PanelGrant {
    const grant = this.#panelAuthorities.register({
      senderId: record.senderId,
      generation: record.generation,
      workspaceId: record.workspaceId,
      pluginId: record.pluginId,
      panelId: record.panelId,
    });
    grant.signal.addEventListener(
      "abort",
      () => {
        try {
          if (this.#tentativePanelGrantRevocations.delete(grant.signal)) return;
          this.#dependencies.onPanelAuthorityRevoked?.({
            workspaceId: record.workspaceId,
            pluginId: record.pluginId,
            panelId: record.panelId,
            surfaceId: record.surfaceId,
          });
        } catch (error) {
          this.#report(error, `revoke plugin panel authority for "${record.pluginId}"`);
        }
      },
      { once: true },
    );
    return grant;
  }

  #finalizeSuspendedPanelGrant(snapshot: SuspendedPanelGrant): void {
    if (snapshot.finalized) return;
    snapshot.finalized = true;
    try {
      this.#dependencies.onPanelAuthorityRevoked?.({
        workspaceId: snapshot.record.workspaceId,
        pluginId: snapshot.record.pluginId,
        panelId: snapshot.record.panelId,
        surfaceId: snapshot.record.surfaceId,
      });
    } catch (error) {
      this.#report(
        error,
        `revoke plugin panel authority for "${snapshot.record.pluginId}"`,
      );
    }
  }

  #queueRecovery(attempt: WebAppAttempt<V>): void {
    if (attempt.recoveryQueued || !this.#attemptOwnsSurface(attempt)) return;
    attempt.recoveryQueued = true;
    // The load failure can fire while startWebApp still owns this lane. Queue
    // recovery behind it; awaiting the lane here would wait on itself.
    void this.#inWebAppLane(attempt.request, async () => {
      if (!this.#attemptOwnsSurface(attempt)) return;
      if (attempt.hostEpoch !== this.#hostEpoch(attempt.request)) {
        await this.#disposeAttempt(attempt);
        return;
      }
      await recoverConsumedWebAppCredential({
        notifyFailed: () => this.#notifyWebAppFailed(attempt),
        withTeardownLock: (teardown) => teardown(),
        unpair: () => this.#unpairExactAttempt(attempt),
        stopView: () => this.#disposeAttempt(attempt),
        onError: (stage, error) =>
          this.#report(
            error,
            `${stage} failed plugin web app "${attempt.request.pluginId}"`,
          ),
      });
    }).catch((error) => {
      this.#report(error, `recover failed plugin web app "${attempt.request.pluginId}"`);
    });
  }

  async #recoverCancelledConsumedAttempt(
    attempt: WebAppAttempt<V>,
  ): Promise<void> {
    await recoverConsumedWebAppCredential({
      // The rejected start response is the intentional-cancellation signal;
      // the failure event is only for a guest that had already answered ok.
      notifyFailed: () => undefined,
      withTeardownLock: (teardown) => teardown(),
      unpair: () => this.#unpairExactAttempt(attempt),
      stopView: () => this.#disposeAttempt(attempt),
      onError: (stage, error) =>
        this.#report(
          error,
          `${stage} cancelled plugin web app "${attempt.request.pluginId}"`,
        ),
    });
  }

  #unpairExactAttempt(attempt: WebAppAttempt<V>): Promise<void> {
    const spawnId = attempt.spawnId;
    const ownedLease = attempt.ownedLease;
    if (
      !spawnId ||
      !ownedLease ||
      attempt.hostEpoch !== this.#hostEpoch(attempt.request) ||
      ownedLease.lease.currentSpawnId() !== spawnId
    ) {
      return Promise.resolve();
    }
    return ownedLease.lease.unpair(spawnId);
  }

  #attemptOwnsSurface(attempt: WebAppAttempt<V>): boolean {
    if (
      attempt.cancelled ||
      !attempt.live ||
      !this.#webAppAttempts.has(attempt)
    ) {
      return false;
    }
    if (attempt.record) {
      return (
        !attempt.record.closed &&
        this.#webApps.get(webAppKey(attempt.request)) === attempt.record
      );
    }
    return true;
  }

  #attemptMayRecover(attempt: WebAppAttempt<V>): boolean {
    return Boolean(
      this.#attemptOwnsSurface(attempt) &&
        attempt.spawnId &&
        attempt.hostEpoch === this.#hostEpoch(attempt.request),
    );
  }

  async #disposeAttempt(attempt: WebAppAttempt<V>): Promise<void> {
    if (!attempt.live && !attempt.pendingView && attempt.displaced.length === 0) {
      return;
    }
    this.#retireWebAppAttempt(attempt);
    if (
      attempt.record &&
      this.#webApps.get(webAppKey(attempt.request)) === attempt.record
    ) {
      this.#webApps.delete(webAppKey(attempt.request));
      await this.#disposeWebApp(attempt.record);
    }
    attempt.record = null;
    if (attempt.pendingView) {
      const pending = attempt.pendingView;
      attempt.pendingView = null;
      this.#destroyWebAppView(pending.view, pending.container, attempt.request.pluginId);
    }
    for (const displaced of attempt.displaced.splice(0)) {
      await this.#disposeWebApp(displaced);
    }
    if (attempt.ownedLease) {
      await this.#releaseLease(attempt.ownedLease, attempt.request.pluginId);
    }
  }

  async #stopPanelAttempt(
    attempt: PanelAttempt,
    barrier?: Promise<void>,
  ): Promise<void> {
    await this.#inPanelLane(attempt.request, async () => {
      await barrier?.catch(() => undefined);
      if (!attempt.active || !this.#panelAttempts.has(attempt)) return;
      const record = attempt.record;
      if (!record || this.#panels.get(panelKey(record)) !== record) {
        this.#retirePanelAttempt(attempt);
        return;
      }
      await this.#removePanelRecord(record);
    });
  }

  async #stopWebAppAttempt(
    attempt: WebAppAttempt<V>,
    notify: boolean,
    barrier?: Promise<void>,
  ): Promise<void> {
    await this.#inWebAppLane(attempt.request, async () => {
      await barrier?.catch(() => undefined);
      if (!attempt.live || !this.#webAppAttempts.has(attempt)) return;
      const record = attempt.record;
      if (!record || this.#webApps.get(webAppKey(record)) !== record) {
        await this.#disposeAttempt(attempt);
        return;
      }
      await this.#recoverPendingNavigationBeforeStop(attempt);
      await this.#removeWebAppRecord(record, notify);
    });
  }

  async #recoverPendingNavigationBeforeStop(
    attempt: WebAppAttempt<V>,
  ): Promise<void> {
    if (!attempt.credentialConsumed || attempt.navigationSucceeded) return;
    try {
      await this.#unpairExactAttempt(attempt);
    } catch (error) {
      this.#report(
        error,
        `unpair stopped plugin web app "${attempt.request.pluginId}"`,
      );
    }
  }

  async #retirePendingWebAppPredecessor(
    request: PluginWebAppIdentity,
  ): Promise<void> {
    const predecessor = this.#webApps.get(webAppKey(request));
    if (
      !predecessor ||
      predecessor.closed ||
      predecessor.attempt.navigationSucceeded
    ) {
      return;
    }
    let unpairFailed = false;
    let unpairError: unknown;
    try {
      await this.#unpairExactAttempt(predecessor.attempt);
    } catch (error) {
      unpairFailed = true;
      unpairError = error;
      this.#report(
        error,
        `unpair replaced plugin web app "${predecessor.pluginId}"`,
      );
    }
    if (this.#webApps.get(webAppKey(request)) === predecessor) {
      await this.#removeWebAppRecord(predecessor, false);
    }
    if (unpairFailed) throw unpairError;
  }

  async #removePanelRecord(record: PanelRecord): Promise<void> {
    this.#panelAuthorities.revokePanel(
      record.workspaceId,
      record.pluginId,
      record.panelId,
    );
    this.#panels.delete(panelKey(record));
    await this.#disposePanel(record);
  }

  async #removeWebAppRecord(
    record: WebAppRecord<V>,
    notify: boolean,
  ): Promise<void> {
    if (notify) this.#notifyWebAppFailed(record.attempt);
    this.#webApps.delete(webAppKey(record));
    await this.#disposeWebApp(record);
  }

  #notifyWebAppFailed(attempt: WebAppAttempt<V>): void {
    if (attempt.notified) return;
    attempt.notified = true;
    try {
      this.#dependencies.notifyWebAppFailed({
        workspaceId: attempt.request.workspaceId,
        pluginId: attempt.request.pluginId,
        webAppId: attempt.request.webAppId,
        instanceKey: attempt.request.instanceKey,
        senderId: attempt.request.senderId,
        generation: attempt.request.generation,
      });
    } catch (error) {
      this.#report(
        error,
        `notify failed plugin web app "${attempt.request.pluginId}"`,
      );
    }
  }

  #notifyPanelInvalidated(record: PanelRecord): void {
    try {
      this.#dependencies.notifyPanelInvalidated({
        workspaceId: record.workspaceId,
        pluginId: record.pluginId,
        panelId: record.panelId,
        senderId: record.senderId,
        generation: record.generation,
        surfaceId: record.surfaceId,
      });
    } catch (error) {
      this.#report(
        error,
        `notify invalidated plugin panel "${record.pluginId}"`,
      );
    }
  }

  #exactOwnerError(target: PluginSurfaceStopTarget): Error | null {
    if (target.kind === "panel" && target.owner) {
      const owner = target.owner;
      const record = this.#panels.get(panelKey(target));
      const attempts = [...this.#panelAttempts].filter(
        (attempt) =>
          attempt.active && this.#matchesStop(attempt.request, target),
      );
      const hasClaimant =
        Boolean(record && !record.closed) || attempts.length > 0;
      const hasMatchingOwner = Boolean(
        (record && !record.closed && sameOwner(record, owner)) ||
          attempts.some((attempt) => sameOwner(attempt.request, owner)),
      );
      if (hasClaimant && !hasMatchingOwner) {
        return new Error(
          "The plugin panel stop request does not belong to this renderer.",
        );
      }
    }
    if (target.kind === "web-app" && target.owner) {
      const owner = target.owner;
      const record = this.#webApps.get(webAppKey(target));
      const attempts = [...this.#webAppAttempts].filter(
        (attempt) =>
          attempt.live && this.#matchesStop(attempt.request, target),
      );
      const hasClaimant =
        Boolean(record && !record.closed) || attempts.length > 0;
      const hasMatchingOwner = Boolean(
        (record && !record.closed && sameOwner(record, owner)) ||
          attempts.some((attempt) => sameOwner(attempt.request, owner)),
      );
      if (hasClaimant && !hasMatchingOwner) {
        return new Error(
          "The plugin web app stop request does not belong to this renderer.",
        );
      }
    }
    return null;
  }

  #cancelAttempts(
    panels: readonly PanelAttempt[],
    webApps: readonly WebAppAttempt<V>[],
  ): void {
    for (const attempt of panels) {
      attempt.cancelled = true;
      if (!attempt.record && attempt.ownedLease) {
        void this.#releaseLease(attempt.ownedLease, attempt.request.pluginId);
      }
    }
    for (const attempt of webApps) {
      attempt.cancelled = true;
      if (!attempt.record && attempt.ownedLease) {
        void this.#releaseLease(attempt.ownedLease, attempt.request.pluginId);
      }
    }
  }

  #assertPanelStartActive(attempt: PanelAttempt): void {
    if (!attempt.cancelled) return;
    throw new Error("Plugin panel start was cancelled because its scope stopped.");
  }

  #assertWebAppStartActive(attempt: WebAppAttempt<V>): void {
    if (!attempt.cancelled) return;
    throw new Error("Plugin web app start was cancelled because its scope stopped.");
  }

  #assertPanelHostCurrent(
    attempt: PanelAttempt,
    ownedLease: OwnedLease<PluginPanelHostLease>,
    binding: PluginPanelHostBinding,
  ): void {
    if (
      ownedLease.lease.currentSpawnId() === binding.spawnId &&
      ownedLease.lease.currentRecord() === binding.hostRecord &&
      this.#hostEpoch(attempt.request) === attempt.hostEpoch
    ) {
      return;
    }
    throw new Error(
      `Plugin "${attempt.request.pluginId}" restarted while its panel was starting. Try again.`,
    );
  }

  #assertWebAppHostCurrent(
    attempt: WebAppAttempt<V>,
    ownedLease: OwnedLease,
    spawnId: string,
  ): void {
    if (
      ownedLease.lease.currentSpawnId() === spawnId &&
      this.#hostEpoch(attempt.request) === attempt.hostEpoch
    ) {
      return;
    }
    throw new Error(
      `Plugin "${attempt.request.pluginId}" restarted while its web app was starting. Try again.`,
    );
  }

  #revokeForStop(target: PluginSurfaceStopTarget): void {
    if (target.kind === "sender") {
      this.#panelAuthorities.revokeSender(target.senderId);
      return;
    }
    if (target.kind === "panel") {
      const record = this.#panels.get(panelKey(target));
      if (record && (!target.owner || sameOwner(record, target.owner))) {
        this.#panelAuthorities.revokePanel(
          record.workspaceId,
          record.pluginId,
          record.panelId,
        );
      }
      return;
    }
    if (target.kind === "web-app") return;
    for (const record of this.#panels.values()) {
      if (!this.#matchesStop(record, target)) continue;
      this.#panelAuthorities.revokePanel(
        record.workspaceId,
        record.pluginId,
        record.panelId,
      );
    }
  }

  #panelAttemptsForStop(target: PluginSurfaceStopTarget): PanelAttempt[] {
    if (target.kind === "web-app") return [];
    return [...this.#panelAttempts].filter(
      (attempt) =>
        attempt.active &&
        this.#matchesStop(attempt.request, target) &&
        (target.kind !== "panel" ||
          !target.owner ||
          sameOwner(attempt.request, target.owner)),
    );
  }

  #webAppAttemptsForStop(target: PluginSurfaceStopTarget): WebAppAttempt<V>[] {
    if (target.kind === "panel") return [];
    return [...this.#webAppAttempts].filter(
      (attempt) =>
        attempt.live &&
        this.#matchesStop(attempt.request, target) &&
        (target.kind !== "web-app" ||
          !target.owner ||
          sameOwner(attempt.request, target.owner)),
    );
  }

  #matchesStop(
    record: PluginSurfaceIdentity & Partial<PluginSurfaceOwner>,
    target: PluginSurfaceStopTarget,
  ): boolean {
    switch (target.kind) {
      case "panel":
        return (
          "panelId" in record &&
          record.workspaceId === target.workspaceId &&
          record.pluginId === target.pluginId &&
          record.panelId === target.panelId
        );
      case "web-app":
        return (
          "webAppId" in record &&
          record.workspaceId === target.workspaceId &&
          record.pluginId === target.pluginId &&
          record.webAppId === target.webAppId &&
          "instanceKey" in record &&
          record.instanceKey === target.instanceKey
        );
      case "sender":
        return record.senderId === target.senderId;
      case "plugin":
        return (
          record.workspaceId === target.workspaceId &&
          record.pluginId === target.pluginId
        );
      case "workspace":
        return record.workspaceId === target.workspaceId;
    }
  }

  #reserveInstance(
    request: PluginWebAppIdentity,
    admission: PluginWebAppStartAdmission,
  ): InstanceReservation {
    const group = `${request.workspaceId}\0${request.pluginId}\0${request.webAppId}`;
    const identity = webAppKey(request);
    const occupied = new Set<string>();
    for (const [key, record] of this.#webApps) {
      if (
        !record.closed &&
        record.workspaceId === request.workspaceId &&
        record.pluginId === request.pluginId &&
        record.webAppId === request.webAppId
      ) {
        occupied.add(key);
      }
    }
    for (const reservedIdentity of this.#instanceReservations.get(group)?.keys() ?? []) {
      occupied.add(reservedIdentity);
    }
    occupied.delete(identity);
    admission.assertInstanceBudget(occupied.size);
    const reservations = this.#instanceReservations.get(group) ?? new Map();
    reservations.set(identity, (reservations.get(identity) ?? 0) + 1);
    this.#instanceReservations.set(group, reservations);
    return { group, identity, active: true };
  }

  #releaseInstanceReservation(reservation: InstanceReservation): void {
    if (!reservation.active) return;
    reservation.active = false;
    const reservations = this.#instanceReservations.get(reservation.group);
    if (!reservations) return;
    const count = reservations.get(reservation.identity) ?? 0;
    if (count <= 1) reservations.delete(reservation.identity);
    else reservations.set(reservation.identity, count - 1);
    if (reservations.size === 0) {
      this.#instanceReservations.delete(reservation.group);
    }
  }

  #stopPluginUnderExclusion(
    target: Extract<PluginSurfaceStopTarget, { kind: "plugin" }>,
    panelAttempts: PanelAttempt[],
    webAppAttempts: WebAppAttempt<V>[],
  ): Promise<void> {
    const key = this.#pluginKey(target);
    const previous = this.#pluginExclusions.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Publish the barrier before queuing teardown. Starts accepted after this
    // point wait until both exact-attempt cleanup and partition clearing end.
    const queued = previous.catch(() => undefined).then(() => current);
    this.#pluginExclusions.set(key, queued);

    const tasks = [
      previous,
      ...panelAttempts.map((attempt) =>
        this.#stopPanelAttempt(attempt, previous),
      ),
      ...webAppAttempts.map((attempt) =>
        this.#stopWebAppAttempt(attempt, true, previous),
      ),
    ];
    return this.#settleCleanup(
      tasks,
      `stop plugin surfaces for "${target.pluginId}"`,
    )
      .then(() =>
        target.clearPartition
          ? this.#clearPartition({
              workspaceRoot: target.clearPartition.workspaceRoot,
              pluginId: target.pluginId,
            })
          : undefined,
      )
      .catch((error) => {
        this.#report(error, `settle plugin stop for "${target.pluginId}"`);
      })
      .finally(() => {
        release();
        if (this.#pluginExclusions.get(key) === queued) {
          this.#pluginExclusions.delete(key);
        }
      });
  }

  #clearPartition(input: {
    workspaceRoot: string;
    pluginId: string;
  }): Promise<void> {
    return clearPluginWebAppPartition({
      ...input,
      hardenedPartitions: this.#hardenedGuestPartitions,
      fromPartition: (partition) => ({
        clearStorageData: () => this.#dependencies.clearGuestPartition(partition),
      }),
      onError: (error) =>
        this.#report(error, `clear plugin web app partition for "${input.pluginId}"`),
    });
  }

  #settleCleanup(
    tasks: Promise<unknown>[],
    context: string,
  ): Promise<void> {
    return Promise.all(
      tasks.map((task) =>
        task.catch((error) => {
          this.#report(error, context);
        }),
      ),
    ).then(() => undefined);
  }

  async #disposePanel(record: PanelRecord): Promise<void> {
    if (record.disposed) return;
    record.disposed = true;
    record.closed = true;
    this.#retirePanelAttempt(record.attempt);
    try {
      await stopPluginPanelPreview(
        record.preview,
        this.#dependencies.clearPanelStorage,
        (error) =>
          this.#report(error, `clear plugin panel storage for "${record.pluginId}"`),
      );
    } catch (error) {
      this.#report(error, `stop plugin panel preview for "${record.pluginId}"`);
    }
    await this.#releaseLease(record.ownedLease, record.pluginId);
  }

  async #disposeLoosePanelPreview(
    preview: Omit<PluginPanelPreview, "releaseOrigin">,
    identity: PluginPanelIdentity,
  ): Promise<void> {
    try {
      await stopPluginPanelPreview(
        { ...preview, releaseOrigin: () => undefined },
        this.#dependencies.clearPanelStorage,
        (error) =>
          this.#report(error, `clear refused plugin panel storage for "${identity.pluginId}"`),
      );
    } catch (error) {
      this.#report(error, `stop refused plugin panel preview for "${identity.pluginId}"`);
    }
  }

  async #disposeWebApp(record: WebAppRecord<V>): Promise<void> {
    if (record.disposed) return;
    record.disposed = true;
    record.closed = true;
    this.#retireWebAppAttempt(record.attempt);
    this.#destroyWebAppView(record.view, record.container, record.pluginId);
    await this.#releaseLease(record.ownedLease, record.pluginId);
  }

  #destroyWebAppView(
    view: V,
    container: PluginWebAppContainer<V>,
    pluginId: string,
  ): void {
    try {
      if (!container.isDestroyed()) container.detach(view);
    } catch (error) {
      this.#report(error, `detach plugin web app view for "${pluginId}"`);
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch (error) {
      this.#report(error, `close plugin web app view for "${pluginId}"`);
    }
  }

  #ownLease<L extends PluginSurfaceHostLease>(lease: L): OwnedLease<L> {
    return { lease, releasePromise: null };
  }

  #releaseLease(owned: OwnedLease, pluginId: string): Promise<void> {
    if (owned.releasePromise) return owned.releasePromise;
    const settlement = Promise.withResolvers<void>();
    owned.releasePromise = settlement.promise;
    try {
      void owned.lease.release().then(
        settlement.resolve,
        (error: unknown) => {
          this.#report(
            error,
            `release plugin surface host lease for "${pluginId}"`,
          );
          settlement.resolve();
        },
      );
    } catch (error) {
      this.#report(error, `release plugin surface host lease for "${pluginId}"`);
      settlement.resolve();
    }
    return settlement.promise;
  }

  #inPanelLane<T>(
    identity: PluginPanelIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withKeyedStartLock(this.#panelLanes, panelKey(identity), operation);
  }

  #inWebAppLane<T>(
    identity: PluginWebAppIdentity,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withKeyedStartLock(this.#webAppLanes, webAppKey(identity), operation);
  }

  #retirePanelAttempt(attempt: PanelAttempt): void {
    attempt.active = false;
    this.#panelAttempts.delete(attempt);
  }

  #retireWebAppAttempt(attempt: WebAppAttempt<V>): void {
    attempt.live = false;
    this.#webAppAttempts.delete(attempt);
  }

  #pluginKey(input: PluginSurfaceIdentity): string {
    return `${input.workspaceId}\0${input.pluginId}`;
  }

  #hostEpoch(input: PluginSurfaceIdentity): number {
    return this.#hostEpochs.get(this.#pluginKey(input)) ?? 0;
  }

  #advanceHostEpoch(input: PluginSurfaceIdentity): number {
    const key = this.#pluginKey(input);
    const epoch = (this.#hostEpochs.get(key) ?? 0) + 1;
    this.#hostEpochs.set(key, epoch);
    return epoch;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Plugin surfaces are closed.");
  }

  #report(error: unknown, context: string): void {
    try {
      this.#dependencies.onError(error, context);
    } catch {
      // Cleanup and revocation must continue even if diagnostics fail.
    }
  }
}
