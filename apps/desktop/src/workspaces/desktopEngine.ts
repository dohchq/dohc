import { installedReaderConfig } from "./installedReaderConfig";
import { catchUpFromJournal, OwnerJournalPending, type OwnerJournalRead } from "./ownerJournal";
import {
  reconcileOwnerLiveStops,
  releaseRetiredOwnerNotes,
  type OwnerLiveStop,
  type OwnerStopRetirementTarget,
} from "./ownerLiveStop";
import { waitForEnginePublicationGate } from "./testEnginePublicationGate";
import { settleOwnerLivePauses, type OwnerLivePause, type RelayLivePause } from "./ownerLivePause";
import type { App, Dialog } from "electron";
import {
  EngineWorkspaceSessions,
  type EngineDaemonLifecycle,
  type EngineWorkspace,
  type createRustEngineDaemon as createRustEngineDaemonImplementation,
  type defaultEngineBinaryPath as defaultEngineBinaryPathImplementation,
} from "@dohc/workspace-engine-client/daemon";
import {
  EngineRelayClient,
  type EngineRelayClientOptions,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import {
  CAPTURE_INITIAL_SETTLED_EVENT,
  CAPTURE_MOMENT_RECORDED_EVENT,
  COLLECTIONS_PROJECTED_EVENT,
  bridgeCaptureEventsToRenderer,
  bridgeNoAtomicPlacement,
  bridgeWriteDeferred,
  scopeOf,
} from "./captureActivityBridge";
import { bridgeAutomationClaimsToExecutors } from "./automationClaimsBridge";
import type { BackgroundLiveStart } from "./backgroundLiveStart";
import type { WorkspaceActivityScope } from "../ipc/workspaceActivityBroadcast";
import type { RegistryEntry } from "./registryStore";
import { shareViewIsPresent } from "./shareViewMarker";
import { readLocalStateFrom } from "./workspaceLocalState";
import type {
  WorkspaceAuthorityOperation,
  WorkspaceAuthorityLease,
} from "./workspaceAuthorityOwner";
import type { launchMarks as launchMarksImplementation } from "../performance/launchMarks";
import type { desktopMarks as desktopMarksImplementation } from "../performance/desktopMarks";
import { EngineClient, EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import type { ExistingOwnerDeviceConfig } from "@dohc/sync-relay/device-host";
import type { readDesktopOwnerHostConfig, startDesktopOwnerHost } from "./desktopOwnerHost";

import type { DesktopOwnerDeliveryConfig, startDesktopOwnerDelivery } from "./desktopOwnerDelivery";
import type { OwnerKnownRefusals } from "./ownerYDocOutbox";
import { relayUrlsMatch } from "./syncCode";
import {
  catchUpOwnerDocuments,
  listedOwnerDeliveryPaths,
  readyOwnerDeliveryDocuments,
  startServerOwnerDelivery,
  type ListedOwnerDeliveryDocument,
} from "./serverOwnerDelivery";
import { OwnerLiveDiscoveryError } from "./serverOwnerConnection";
import type { LiveDocumentPath } from "./moveAcceptedEditsGuard";
import {
  readOwnerLiveQuarantines,
  readOwnerLiveQueue,
  readServerKeptEdits,
  readServerKeptEditsQueue,
  retryOwnerLiveQuarantine,
  sameGeneration,
  ServerKeptEditsConflict,
  type OwnerLiveHeadCache,
  type OwnerLiveQuarantineRecord,
  type ServerKeptEdits,
} from "./ownerLiveQuarantine";
import type { JsonValue } from "@dohc/workspace-engine-client";
import {
  keptEarlierError,
  keptEarlierRelease,
  recoverySnapshot,
  sameBinding,
  sameRelease,
  type UnwrittenRelease,
  type UnwrittenReleases,
} from "./ownerLiveReleases";
import type { LiveRecoveryFiles, LiveRecoveryPackage } from "./ownerLiveRecoveryCopy";
import type { DocumentProjection } from "./documentProjection";
import { createDurableFile } from "./workspaceFiles";
import type { OwnerLiveQuarantine } from "../ipc/bridgeContract";
import type { LiveObjectBinding } from "@dohc/workspace-engine-client";

export interface ServerOwnerDelivery {
  prepare(): Promise<Omit<DesktopOwnerDeliveryConfig, "relayUrl" | "documents">>;
  workspaceIds(): string[];
  hasRefusals(workspaceId: string): boolean | undefined;
  connect(
    workspace: RegistryEntry,
    signal: AbortSignal,
  ): Promise<{
    bearer: string;
    accountId: string;
    relayUrl: string;
    signal: AbortSignal;
    assertCurrent(): void;
    refusals(attempt: AbortSignal): Promise<void>;
    /** The server's list of the workspace's hosted documents. `fresh` skips one read before this call. */
    documents(signal: AbortSignal, fresh?: boolean): Promise<unknown>;
    retire(binding: OwnerStopRetirementTarget, signal: AbortSignal): Promise<number | null>;
    /** A page of a retired note's saves after `after`, for its owner's release. */
    journal(
      binding: LiveObjectBinding,
      after: number,
      signal: AbortSignal,
    ): ReturnType<OwnerJournalRead>;
    /**
     * The owner's page read, Try again or confirmed copy of edits the server
     * keeps, by the refusal the owner saw. A page read continues after the
     * previous page's `cursor`, and a confirmed copy names the checkpoint it
     * read. Throws ServerKeptEditsConflict when the server answers that the
     * refusal changed, or that it cannot reach its edits now.
     */
    keptEdits(
      input:
        | { action: "page"; outboxId: string; generation: number; cursor?: JsonValue }
        | { action: "retry"; outboxId: string; generation: number }
        | {
            action: "copied";
            outboxId: string;
            generation: number;
            checkpointDigest: string | null;
          },
      signal: AbortSignal,
    ): Promise<unknown>;
    /** A later page of the edits the server keeps, after the cursor the previous page named. */
    keptEditsPage(after: number, signal: AbortSignal): Promise<unknown>;
    /**
     * The owner's open of a document this computer holds an owner binding for
     * and the server does not list as ready. `refused` when only the owner can
     * change the server's answer.
     */
    open(path: string, signal: AbortSignal): Promise<"hosted" | "refused">;
    /** The notes the server paused for good, oldest first. */
    livePauses(signal: AbortSignal): Promise<RelayLivePause[]>;
    /** A pause's copy of its room, read to the length its list gave. */
    livePauseCopy(pauseId: string, byteLength: number, signal: AbortSignal): Promise<Uint8Array>;
    /** The copy is written next to the note, so the server deletes its own. */
    livePauseCopyWritten(pauseId: string, sha256: string, signal: AbortSignal): Promise<void>;
    resumeLivePause(pauseId: string, signal: AbortSignal): Promise<void>;
  } | null>;
}
type ServerOwnerSession = NonNullable<Awaited<ReturnType<ServerOwnerDelivery["connect"]>>>;
/** How often each live note opens its connection even when the server's list says nothing changed. */
export const OWNER_FULL_PASS_MS = 5 * 60_000;
/**
 * Whether this workspace has no ordinary sync configured: Stop sync saved a
 * pause, or the folder was attached again as local work. Sign-out, a lost
 * connection and a detach keep its remote.
 */
export function hasNoOrdinarySync(entry: RegistryEntry | null): boolean {
  return (
    entry !== null &&
    !entry.remote &&
    entry.joinBootstrapPending !== true &&
    !shareViewIsPresent(entry.shareView)
  );
}

export type OwnerLiveDeliveryStatus = "preparing" | "active" | "retrying";
type OwnerLiveDeliveryReason =
  | "document-unavailable"
  | "workspace-changed"
  | "session-host-refused"
  | "session-host-diverged"
  | "live-document-without-lineage"
  | "live-edit-unadmitted"
  | "conflict-parent-withheld"
  | "live-history-over-budget"
  | "live-start-failing"
  | "note-format-off"
  | "restart-required"
  | "unsent-edits-limit"
  | OwnerLiveDiscoveryError["reason"];

type EngineAuthorityState = {
  collectionAutomations: CollectionAutomationsLifecycle;
};

/** The Collection automation executor's part in an engine restart. */
interface CollectionAutomationsLifecycle {
  notifyClaimed(): void;
  failuresChanged(): void;
  pauseForEngineRestart(): void;
  resumeAfterEngineRestart(): void;
}

interface DesktopEngineDependencies<State extends EngineAuthorityState> {
  resourcesBasePath(): string;
  onWorkspaceOpened?(workspaceId: string): void;
  onRefusalsChanged?: () => void;
  onShareViewPullProgress?: EngineRelayClientOptions["onShareViewPullProgress"];
  serverOwnerDelivery?: ServerOwnerDelivery;
  /** Stops that took refused edits out of their queue but did not write the file. */
  ownerLiveReleases: UnwrittenReleases;
  localPersonId(): string;
  /** Builds a recovery copy's Markdown off main. */
  documentProjection: DocumentProjection;
  ownerDeliveryCredentials?(): {
    bearer: string;
    accountId: string;
    relayUrl: string;
    signal: AbortSignal;
  } | null;
  existingOwnerFor?: ExistingOwnerDeviceConfig["ownerFor"];
  findWorkspace(workspaceId: string): RegistryEntry | null;
  app: Pick<App, "isPackaged" | "getAppPath">;
  dialog: Pick<Dialog, "showErrorBox">;
  process: { env: NodeJS.ProcessEnv; resourcesPath?: string; platform: NodeJS.Platform };
  createRustEngineDaemon: typeof createRustEngineDaemonImplementation;
  defaultEngineBinaryPath: typeof defaultEngineBinaryPathImplementation;
  isQuitting(): boolean;
  // Keeps an engine failure in the crash report on this computer.
  recordEngineProblem(error: unknown, stage: "restarting" | "stopped" | "startup"): void;
  workspaceAuthorities: {
    workspaceIds(): string[];
    withOperation?<Result>(
      workspaceId: string,
      work: (
        operation: WorkspaceAuthorityOperation<RegistryEntry, State>,
      ) => Result | Promise<Result>,
    ): Promise<Result>;
    withAuthority<Result>(
      workspaceId: string,
      work: (lease: WorkspaceAuthorityLease<RegistryEntry, State>) => Result | Promise<Result>,
    ): Promise<Result>;
  };
  collectionAutomations: {
    current(
      workspaceId: string,
    ): Pick<CollectionAutomationsLifecycle, "notifyClaimed" | "failuresChanged"> | undefined;
  };
  notifyRenderer(scope?: WorkspaceActivityScope): void;
  // The engine announced that a workspace's drive has no rename that refuses
  // to replace a file.
  noteNoAtomicPlacement(workspaceId: string): void;
  noteWriteDeferred(workspaceId: string, path: string): void;
  backgroundLiveStart?: Pick<BackgroundLiveStart, "note" | "pause" | "resume">;
  notifyOwnerDeliveryChanged?(workspaceId: string): void;
  // The notes waiting for the server may differ from the last read: the server accepted or
  // refused a document's edits, or a workspace this computer owns opened.
  notifyOwnerDraftsChanged?(workspaceId: string): void;
  // The shared notes whose edits wait on this computer for the server, as last read.
  ownerPendingPaths?(workspaceId: string): readonly string[];
  // Whether an editor here has the shared note at `path` open as its owner.
  ownerHasOpen?(workspaceId: string, path: string): boolean;
  // A Stop the owner-delivery pass sent again finished, as a Stop from the renderer reports.
  notifyOwnerLiveStopped?(workspaceId: string, objectId: string, path: string): void;
  // Opens and closes a note with no window, which starts its live history on this computer.
  startOwnerLiveHistory?(workspaceId: string, path: string): Promise<void>;
  // Runs `leave` between the edits of the editors here that edit the note at `path` live, given their unsent edits.
  // `late` gets the edits that reached them while `leave` ran.
  leaveLiveEditing?<T>(
    workspaceId: string,
    path: string,
    leave: (unsent: Uint8Array[]) => Promise<T>,
    late?: (edits: Uint8Array) => void,
  ): Promise<T>;
  launchMarks: Pick<typeof launchMarksImplementation, "daemonReady">;
  desktopMarks: Pick<typeof desktopMarksImplementation, "markOnce">;
  logLaunchMarksOnce(): void;
}

// A pass starts a document's live history again after this wait, doubled after each start.
const OWNER_HISTORY_START_WAIT_MS = 30_000;
const OWNER_HISTORY_START_MAX_WAIT_MS = 10 * 60_000;
// After this many starts the server still lists, the owner sees why it can't start.
const OWNER_HISTORY_QUIET_STARTS = 3;

export function createDesktopEngine<State extends EngineAuthorityState>(
  dependencies: DesktopEngineDependencies<State>,
) {
  const {
    app,
    dialog,
    process,
    createRustEngineDaemon,
    defaultEngineBinaryPath,
    isQuitting,
    recordEngineProblem,
    workspaceAuthorities,
    notifyRenderer,
    launchMarks,
    desktopMarks,
    logLaunchMarksOnce,
  } = dependencies;

  let rustEngineDaemon: EngineDaemonLifecycle | null = null;
  // A failure since the engine last launched is already in the crash report.
  let engineProblemRecorded = false;
  let rustEngineWorkspaceSessions: EngineWorkspaceSessions | null = null;
  // Writers of this computer's state, and on Windows its readers, ask the
  // current binding, so readiness ends when its open closes, rebinds or fails.
  readLocalStateFrom({
    currentBinding: (workspace) => rustEngineWorkspaceSessions?.currentBinding(workspace) ?? null,
    openInProgress: (workspace) => rustEngineWorkspaceSessions?.openInProgress(workspace) ?? null,
    localStateOpenAt: async (rootPath) =>
      (await rustEngineWorkspaceSessions?.localStateOpenAt(rootPath)) ?? null,
  });
  let rustEngineRelayClient: EngineRelayClient | null = null;
  let rustEngineSessionSource: RelayConfiguredDaemonClientSource | null = null;
  let ownerHost: ReturnType<typeof startDesktopOwnerHost> | undefined;
  let ownerHostConfig: ReturnType<typeof readDesktopOwnerHostConfig> | undefined;
  let ownerHostModule: typeof import("./desktopOwnerHost") | undefined;
  let ownerHostGeneration = 0;
  let ownerWorkspaceCloses = 0;
  let ownerDelivery:
    | (ReturnType<typeof startDesktopOwnerDelivery> & {
        retry?(workspaceId: string): void;
        catchUp?(
          workspaceId: string,
          objectIds: readonly string[],
          signal: AbortSignal,
        ): Promise<boolean>;
      })
    | undefined;
  let ownerDeliveryConfig: DesktopOwnerDeliveryConfig | undefined;
  let ownerDeliveryModule: typeof import("./desktopOwnerDelivery") | undefined;
  let nativeOwnerDeliveryModule: typeof import("./nativeOwnerDelivery") | undefined;
  // Outlives every owner delivery pass and connection.
  let ownerRefusals: OwnerKnownRefusals | undefined;
  let ownerDeliverySettled = Promise.resolve();
  let ownerDeliveryGeneration = 0;
  let serverOwnerConfig: Awaited<ReturnType<ServerOwnerDelivery["prepare"]>> | undefined;
  const ownerDeliveryStatus = new Map<string, OwnerLiveDeliveryStatus>();
  let serverOwnerUnavailable = false;
  let activeOwnerWorkspace: string | undefined;
  const failedOwnerDocuments = new Map<string, Set<string>>();
  const frozenOwnerDocuments = new Map<string, Set<string>>();
  // When each listed note last ran a pass that opened its connection, by workspace and object.
  const fullOwnerPasses = new Map<string, Map<string, number>>();
  // Notes that take no edits because too many wait to reach the server. The engine lifts it once a pass delivers them.
  const pausedOwnerDocuments = new Map<string, Set<string>>();
  const ownerDeliveryReason = new Map<string, OwnerLiveDeliveryReason>();
  const ownerStopFailures = new Map<
    string,
    Map<string, { objectId: string; path: string; detail: string }>
  >();
  // Notes the server paused for good that this computer holds as paused, from each
  // workspace's last complete read. They take no room until their owner resumes them.
  const ownerLivePauses = new Map<string, OwnerLivePause[]>();
  const ownerLivePausesTried = new Map<string, { objectId: string; state: Uint8Array | null }>();
  // Counts each workspace's Resumes, so a pass that read the pauses before one keeps its answer to itself.
  const ownerLivePauseResumes = new Map<string, number>();
  // A note the server paused takes no room and no delivery turn until its owner resumes it.
  const withoutServerPauses = (workspaceId: string, documents: ListedOwnerDeliveryDocument[]) => {
    const paused = new Set((ownerLivePauses.get(workspaceId) ?? []).map((row) => row.objectId));
    return documents.filter((document) => !paused.has(document.binding.objectId));
  };
  // The ready documents from each workspace's last complete live-host list, for the move guard.
  const liveDocumentPaths = new Map<string, LiveDocumentPath[]>();
  // The owner's open. Each workspace's documents its last list named live or
  // starting; those its owner opened here, in the order of `ownerOpenClock`,
  // which a pass asks the server to host unless a list read after the open
  // names them live or starting; and those whose open the server refused. No
  // pass asks for a refused one again until its owner opens it, or a list
  // names it live after a Resume. These outlive a pass and a restart of delivery.
  const hostedOwnerPaths = new Map<string, Set<string>>();
  const ownerOpened = new Map<string, Map<string, number>>();
  const ownerOpenRefused = new Map<string, Set<string>>();
  // Orders each owner open against the lists passes read.
  let ownerOpenClock = 0;
  // Documents the server cannot host until their live history starts, which a
  // pass starts here with no window. Each waits twice as long after each
  // start, and stops hiding its reason after a failed start or after a few
  // starts the server still lists.
  const ownerHistoryStarts = new Map<
    string,
    Map<string, { starts: number; failures: number; nextAt: number; running: boolean }>
  >();
  const pathsOf = (paths: Map<string, Set<string>>, workspaceId: string) => {
    let set = paths.get(workspaceId);
    if (!set) paths.set(workspaceId, (set = new Set()));
    return set;
  };
  // Documents whose edits the server refused for good, read from the engine's
  // durable queues, so a restart shows them again. Each Try again the owner
  // asked for counts by queue, so a refusal after it is a new incident.
  const ownerQuarantines = new Map<string, OwnerLiveQuarantineRecord[]>();
  const ownerQuarantineReads = new Map<string, number>();
  const ownerQuarantineAttempts = new Map<string, number>();
  const ownerQuarantineHeads = new Map<string, OwnerLiveHeadCache>();
  // Each shared note its owner has open here joins its live room: one connection
  // that carries each edit as it lands and puts the room's unsaved edits on the
  // owner's screen. The pass loop starts and ends rooms, by workspace and object.
  interface OwnerRoom {
    binding: LiveObjectBinding;
    // The room's queue is empty and it waits for an edit.
    idle: boolean;
    // Sends the queue's head now, for entries the engine adds without an edit landing.
    wake?: () => void;
    // The relay took an edit since the room last waited.
    acknowledged: boolean;
    end: AbortController;
    ended: Promise<void>;
  }
  const ownerRooms = new Map<string, Map<string, OwnerRoom>>();
  // A room that closed on its own opens again after this time, by object.
  const ownerRoomRetryAt = new Map<string, number>();
  // Notes a Stop release or a move's catch-up holds: no room opens for them.
  const ownerRoomsHeld = new Map<string, number>();
  // The owner's edits that reached a queue for the server, by workspace.
  const ownerEdits = new Map<string, { count: number; waiters: Set<() => void> }>();
  const ownerEditsOf = (workspaceId: string) => {
    let edits = ownerEdits.get(workspaceId);
    if (!edits) ownerEdits.set(workspaceId, (edits = { count: 0, waiters: new Set() }));
    return edits;
  };
  function endOwnerRooms(workspaceId?: string, objectIds?: readonly string[]): Promise<void> {
    const ending: Promise<void>[] = [];
    for (const [id, rooms] of ownerRooms)
      if (workspaceId === undefined || id === workspaceId)
        for (const [objectId, room] of rooms)
          if (!objectIds || objectIds.includes(objectId)) {
            room.end.abort();
            ending.push(room.ended);
          }
    return Promise.all(ending).then(() => undefined);
  }
  /** Ends the rooms of `objectIds` and keeps them closed while `work` runs. */
  async function withoutOwnerRooms<Result>(
    workspaceId: string,
    objectIds: readonly string[],
    work: () => Promise<Result>,
  ): Promise<Result> {
    for (const id of objectIds) ownerRoomsHeld.set(id, (ownerRoomsHeld.get(id) ?? 0) + 1);
    try {
      await endOwnerRooms(workspaceId, objectIds);
      return await work();
    } finally {
      for (const id of objectIds) {
        const held = (ownerRoomsHeld.get(id) ?? 1) - 1;
        if (held) ownerRoomsHeld.set(id, held);
        else ownerRoomsHeld.delete(id);
      }
    }
  }
  const releaseIncident = (row: Pick<UnwrittenRelease, "objectId" | "binding">) =>
    row.binding
      ? `release:${row.binding.lineageClaimId}:${row.binding.restoreFenceGeneration}`
      : `release:${row.objectId}`;
  const quarantineIncident = (row: OwnerLiveQuarantineRecord) =>
    row.recovery === "unreadable"
      ? `unreadable:${row.outboxId}`
      : row.outboxId !== null
        ? `${row.outboxId}:${row.headDeliveryId}:${ownerQuarantineAttempts.get(row.outboxId) ?? 0}`
        : releaseIncident(row);
  // Refused queues the server keeps for documents it hosts, as each pass last
  // read them from the server's live document list.
  const serverQuarantines = new Map<string, ServerKeptEdits[]>();
  const serverIncident = (row: ServerKeptEdits) => `server:${row.outboxId}:${row.generation}`;
  const setServerQuarantines = (workspaceId: string, rows: ServerKeptEdits[]) => {
    if (JSON.stringify(rows) === JSON.stringify(serverQuarantines.get(workspaceId) ?? [])) return;
    if (rows.length) serverQuarantines.set(workspaceId, rows);
    else serverQuarantines.delete(workspaceId);
    notifyRenderer({ workspaceId });
  };
  const serverQuarantinesOf = (workspaceId: string) =>
    dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId)
      ? (serverQuarantines.get(workspaceId) ?? [])
      : [];
  // A server action on a row the server answers changed drops the row until
  // the next pass lists the current one. A Try again it refuses for an earlier
  // copy's edits marks the row earlier and keeps its copy status.
  async function serverKeptEditsAction<Result>(
    workspaceId: string,
    row: ServerKeptEdits,
    work: () => Promise<Result>,
  ): Promise<Result> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ServerKeptEditsConflict)
        setServerQuarantines(
          workspaceId,
          serverQuarantinesOf(workspaceId).flatMap((candidate) =>
            candidate.generation !== row.generation
              ? [candidate]
              : error.earlier
                ? [{ ...candidate, earlier: true as const }]
                : [],
          ),
        );
      throw error;
    }
  }
  // One request to the server as the workspace's owner.
  async function withServerSession<Result>(
    workspaceId: string,
    work: (
      session: NonNullable<Awaited<ReturnType<ServerOwnerDelivery["connect"]>>>,
      signal: AbortSignal,
    ) => Promise<Result>,
  ) {
    const server = dependencies.serverOwnerDelivery;
    const unreachable = () =>
      new Error(
        "dohc could not reach your kept edits on the server. Check that you are signed in, then try again.",
      );
    if (
      !server ||
      !workspaceAuthorities.withOperation ||
      !server.workspaceIds().includes(workspaceId)
    )
      throw unreachable();
    return workspaceAuthorities.withOperation(workspaceId, async (operation) => {
      const session = await server.connect(operation.workspace, operation.signal);
      if (!session) throw unreachable();
      return work(session, AbortSignal.any([operation.signal, session.signal]));
    });
  }
  // Returns its own rows, which the caller can trust even when a later read owns the cache.
  // A queue `strict` names must be read, or the read fails and the cache keeps the last answer.
  async function readOwnerQuarantinesInto(
    workspaceId: string,
    client: EngineClient,
    workspaceHandle: string,
    strict?: (binding: LiveObjectBinding) => boolean,
  ): Promise<OwnerLiveQuarantineRecord[]> {
    const read = (ownerQuarantineReads.get(workspaceId) ?? 0) + 1;
    ownerQuarantineReads.set(workspaceId, read);
    const heads = ownerQuarantineHeads.get(workspaceId) ?? new Map();
    ownerQuarantineHeads.set(workspaceId, heads);
    const rows = await readOwnerLiveQuarantines(client, workspaceHandle, {
      heads,
      unwritten: await dependencies.ownerLiveReleases.list(workspaceId),
      ...(strict ? { strict } : {}),
    });
    // A later read owns the answer.
    if (ownerQuarantineReads.get(workspaceId) !== read) return rows;
    const before = JSON.stringify(ownerQuarantines.get(workspaceId) ?? []);
    if (rows.length) ownerQuarantines.set(workspaceId, rows);
    else ownerQuarantines.delete(workspaceId);
    if (JSON.stringify(rows) !== before) notifyRenderer({ workspaceId });
    return rows;
  }
  /**
   * Releases a Stop's queue into the document. For refused edits, a recovery
   * package and a record are written first: once the release commits, the
   * queue is gone, and they keep the notice, its Try again and Save recovery
   * copy until the file holds the edits, or a recovery copy does. With the
   * server's `journal`, the saves this computer has not applied come first,
   * so the release writes every one through `acceptedCursor`.
   */
  async function releaseOwnerLiveStop(
    workspaceId: string,
    client: EngineClient,
    workspaceHandle: string,
    binding: LiveObjectBinding,
    acceptedCursor: number,
    signal?: AbortSignal,
    journal?: OwnerJournalRead,
  ) {
    return withoutOwnerRooms(workspaceId, [binding.objectId], () =>
      releaseHeld(workspaceId, client, workspaceHandle, binding, acceptedCursor, signal, journal),
    );
  }
  async function releaseHeld(
    workspaceId: string,
    client: EngineClient,
    workspaceHandle: string,
    binding: LiveObjectBinding,
    acceptedCursor: number,
    signal?: AbortSignal,
    journal?: OwnerJournalRead,
  ) {
    if (journal) {
      const request = { id: 0, workspace: workspaceHandle, deadlineMs: 30_000 };
      const stop = (await client.ownerYDocStopList(request, signal)).find((row) =>
        sameBinding(row.binding ?? null, binding),
      );
      // Released before the server's last save, the note would wait for Resume.
      if (
        stop &&
        (await catchUpFromJournal({
          client,
          workspaceHandle,
          target: { binding, relayDatabaseNamespace: stop.relayDatabaseNamespace },
          read: journal,
          signal: signal ?? AbortSignal.any([]),
          through: acceptedCursor,
        })) === null
      )
        throw new OwnerJournalPending();
    }
    // Only the queue of the generation this release takes. If the engine refuses
    // to read this document's queue head, the release fails: nothing would keep its edits.
    const kept = (
      await readOwnerQuarantinesInto(
        workspaceId,
        client,
        workspaceHandle,
        (queue) => queue.objectId === binding.objectId && sameGeneration(queue, binding),
      )
    ).find(
      (row) =>
        row.objectId === binding.objectId &&
        !row.saveOnly &&
        row.outboxId !== null &&
        sameGeneration(row.binding, binding),
    );
    if (kept?.recovery === "unreadable")
      throw new Error(`dohc could not read the edits it kept for ${kept.path}.`);
    let keptSnapshot: string | undefined;
    if (kept?.outboxId) {
      const release = {
        workspaceId,
        objectId: binding.objectId,
        path: kept.path,
        reason: kept.reason,
        binding,
        headDeliveryId: kept.headDeliveryId,
        retry: true,
      };
      // Checked before the whole queue is read; the put checks its edits too, under its lock.
      const earlier = keptEarlierRelease(
        await dependencies.ownerLiveReleases.list(workspaceId),
        release,
      );
      if (earlier) throw keptEarlierError(earlier.path);
      const { liveRecoveryPackage } = await import("./ownerLiveRecoveryCopy");
      const queue = await readOwnerLiveQueue(client, workspaceHandle, kept);
      keptSnapshot = recoverySnapshot(queue);
      await dependencies.ownerLiveReleases.put(
        { ...release, snapshot: keptSnapshot },
        JSON.stringify(
          liveRecoveryPackage(queue, {
            path: kept.path,
            reason: kept.reason,
            storedOn: "this-computer",
          }),
        ),
      );
    }
    // The engine's Stop keeps the snapshot of the edits its release took, which names this record.
    const released = await client.ownerYDocRelease(
      { id: 0, workspace: workspaceHandle, deadlineMs: 30_000 },
      binding,
      dependencies.localPersonId(),
      { acceptedCursor, ...(keptSnapshot === undefined ? {} : { keptSnapshot }) },
      signal,
    );
    // A written file ends the record of the edits this release took. A deferred
    // release leaves them in their queue, whose row hides the record until it ends.
    if (released.materialized === true)
      await dependencies.ownerLiveReleases.written(workspaceId, binding.objectId, {
        binding,
        snapshot: released.keptSnapshot ?? null,
      });
    return released;
  }
  function refreshOwnerLiveQuarantines(workspace: EngineWorkspace): Promise<void> {
    const daemon = rustEngineDaemon,
      sessions = rustEngineWorkspaceSessions;
    if (!daemon || !sessions) return Promise.resolve();
    return sessions.run(workspace, async (binding) => {
      const client = daemon.currentClient();
      if (client instanceof EngineClient)
        await readOwnerQuarantinesInto(workspace.workspaceId, client, binding.workspace);
    });
  }
  async function withEngineClient<Result>(
    workspace: EngineWorkspace,
    work: (client: EngineClient, workspaceHandle: string) => Promise<Result>,
  ): Promise<Result> {
    const daemon = rustEngineDaemon,
      sessions = rustEngineWorkspaceSessions;
    if (!daemon || !sessions)
      throw new Error("dohc could not change live editing. Restart dohc and try again.");
    return sessions.run(workspace, async (binding) => {
      const client = daemon.currentClient();
      if (!(client instanceof EngineClient))
        throw new Error("dohc could not change live editing. Restart dohc and try again.");
      return work(client, binding.workspace);
    });
  }
  // A failed read keeps the last answer: the queues are still on this computer.
  const readQuarantinesAfterPass = (
    workspaceId: string,
    client: EngineClient,
    workspaceHandle: string,
  ) =>
    readOwnerQuarantinesInto(workspaceId, client, workspaceHandle).catch((error) =>
      console.error("[desktop] owner live quarantine read failed:", error),
    );
  // A refusal starts or renews a quarantine; one already read as waiting stays
  // as read. An acceptance can end only a quarantine already read.
  const quarantinesMayChange = (workspaceId: string, objectId: string, outcome: string) => {
    const recovery = ownerQuarantines
      .get(workspaceId)
      ?.find((row) => row.objectId === objectId && !row.saveOnly)?.recovery;
    return outcome === "frozen"
      ? recovery === undefined || recovery === "retrying"
      : outcome === "acknowledged" && recovery !== undefined;
  };
  const refusedPaths = (workspaceId: string) =>
    new Set(
      (ownerQuarantines.get(workspaceId) ?? [])
        .filter((row) => !row.saveOnly)
        .map((row) => row.path),
    );
  const setOwnerDeliveryStatus = (
    workspaceId: string,
    status: OwnerLiveDeliveryStatus | undefined,
    reason?: OwnerLiveDeliveryReason,
    logCause?: string,
  ) => {
    if (
      ownerDeliveryStatus.get(workspaceId) === status &&
      ownerDeliveryReason.get(workspaceId) === reason
    )
      return;
    if (status === "retrying")
      console.warn(
        `[desktop] owner live editing of workspace ${workspaceId} is retrying: ${reason ?? logCause ?? "unknown"}`,
      );
    if (status) ownerDeliveryStatus.set(workspaceId, status);
    else ownerDeliveryStatus.delete(workspaceId);
    if (reason) ownerDeliveryReason.set(workspaceId, reason);
    else ownerDeliveryReason.delete(workspaceId);
    dependencies.notifyOwnerDeliveryChanged?.(workspaceId);
  };
  function stopOwnerDelivery(): Promise<void> {
    ownerDeliveryGeneration += 1;
    for (const id of ownerDeliveryStatus.keys()) setOwnerDeliveryStatus(id, undefined);
    failedOwnerDocuments.clear();
    frozenOwnerDocuments.clear();
    fullOwnerPasses.clear();
    pausedOwnerDocuments.clear();
    ownerStopFailures.clear();
    liveDocumentPaths.clear();
    ownerHistoryStarts.clear();
    ownerRoomRetryAt.clear();
    const previous = ownerDelivery;
    ownerDelivery = undefined;
    const rooms = [...ownerRooms.values()].some((open) => open.size) ? endOwnerRooms() : undefined;
    if (previous || rooms)
      ownerDeliverySettled = Promise.all([ownerDeliverySettled, rooms, previous?.stop()]).then(
        () => undefined,
      );
    return ownerDeliverySettled;
  }
  function startOwnerDelivery(): void {
    const settled = stopOwnerDelivery(),
      generation = ownerDeliveryGeneration;
    void settled
      .then(() => {
        const server = dependencies.serverOwnerDelivery;
        if (
          server &&
          serverOwnerConfig &&
          rustEngineDaemon &&
          rustEngineWorkspaceSessions &&
          rustEngineSessionSource &&
          generation === ownerDeliveryGeneration &&
          !isQuitting() &&
          !ownerWorkspaceCloses
        ) {
          const daemon = rustEngineDaemon,
            sessions = rustEngineWorkspaceSessions,
            source = rustEngineSessionSource;
          const profile = serverOwnerConfig;
          // At most one owner open per pass, of a document this computer holds an
          // owner binding for and the list names neither live nor starting: first
          // one its owner opened before the list was read, then one whose edits
          // wait here. The next pass reads the list it changed.
          const ownerOpenTurn = async (
            workspaceId: string,
            session: ServerOwnerSession,
            rows: readonly { path: string; status: string }[],
            listedAt: number,
            signal: AbortSignal,
            check: () => void,
          ) => {
            const current = server.workspaceIds();
            for (const paths of [hostedOwnerPaths, ownerOpened, ownerOpenRefused])
              for (const id of paths.keys()) if (!current.includes(id)) paths.delete(id);
            const hosted = new Set(
              rows
                .filter((row) => row.status === "ready" || row.status === "preparing")
                .map((row) => row.path),
            );
            hostedOwnerPaths.set(workspaceId, hosted);
            const refused = pathsOf(ownerOpenRefused, workspaceId),
              opened = ownerOpened.get(workspaceId) ?? new Map<string, number>();
            for (const path of refused) if (hosted.has(path)) refused.delete(path);
            // An open made after this list was read waits for the next list.
            for (const [path, at] of opened)
              if (at < listedAt && (hosted.has(path) || refused.has(path))) opened.delete(path);
            let path = [...opened].find(([, at]) => at < listedAt)?.[0];
            path ??= (dependencies.ownerPendingPaths?.(workspaceId) ?? []).find(
              (candidate) => !hosted.has(candidate) && !refused.has(candidate),
            );
            if (path === undefined) return;
            const at = opened.get(path);
            const answer = await session.open(path, signal);
            check();
            // The owner opened it again while this was asked: that open stays, and this answer records nothing.
            const now = ownerOpened.get(workspaceId);
            if (now?.get(path) !== at) return;
            now?.delete(path);
            if (answer === "refused") refused.add(path);
          };
          // Starts one due document's live history, without waiting for it. Answers the
          // documents a start may still help, whose "can't start" reason the owner doesn't see.
          const ownerHistoryTurn = (
            workspaceId: string,
            rows: readonly { path: string; status: string; reason?: unknown }[],
          ) => {
            const start = dependencies.startOwnerLiveHistory;
            const states =
              ownerHistoryStarts.get(workspaceId) ??
              new Map<
                string,
                { starts: number; failures: number; nextAt: number; running: boolean }
              >();
            ownerHistoryStarts.set(workspaceId, states);
            const waiting = new Set(
              rows
                .filter(
                  (row) =>
                    row.status === "unavailable" && row.reason === "live-document-without-lineage",
                )
                .map((row) => row.path),
            );
            for (const path of states.keys()) if (!waiting.has(path)) states.delete(path);
            if (!start) return new Set<string>();
            const now = Date.now();
            for (const path of waiting)
              if (!states.has(path))
                states.set(path, { starts: 0, failures: 0, nextAt: 0, running: false });
            const due = [...waiting].find((path) => {
              const state = states.get(path)!;
              return !state.running && state.nextAt <= now;
            });
            if (due !== undefined) {
              const path = due,
                state = states.get(path)!;
              state.running = true;
              state.starts++;
              void start(workspaceId, path)
                .catch((error: unknown) => {
                  state.failures++;
                  console.error("[desktop] owner live history start failed:", error);
                })
                .finally(() => {
                  state.running = false;
                  state.nextAt =
                    Date.now() +
                    Math.min(
                      OWNER_HISTORY_START_WAIT_MS * 2 ** (state.starts - 1),
                      OWNER_HISTORY_START_MAX_WAIT_MS,
                    );
                });
            }
            return new Set(
              [...waiting].filter((path) => {
                const state = states.get(path)!;
                return (
                  state.failures === 0 &&
                  (state.running || state.starts < OWNER_HISTORY_QUIET_STARTS)
                );
              }),
            );
          };
          // A note's room runs beside the pass loop. It takes the workspace session one
          // engine call at a time, so closing the workspace never waits for it.
          const startOwnerRoom = (
            workspaceId: string,
            document: ListedOwnerDeliveryDocument,
            documents: ListedOwnerDeliveryDocument[],
          ) => {
            const withOperation = workspaceAuthorities.withOperation?.bind(workspaceAuthorities);
            if (!withOperation) return;
            const objectId = document.binding.objectId,
              end = new AbortController(),
              room: OwnerRoom = {
                binding: document.binding,
                idle: false,
                acknowledged: false,
                end,
                ended: Promise.resolve(),
              };
            const rooms = ownerRooms.get(workspaceId) ?? new Map<string, OwnerRoom>();
            ownerRooms.set(workspaceId, rooms.set(objectId, room));
            const ended = () => new Error("This live editing session ended.");
            const waited = () => {
              // A room that waits for an edit has sent every one, so its note takes edits again.
              // A pass can't see this: its turn wakes the room before it looks.
              const unpaused =
                room.idle &&
                pausedOwnerDocuments.get(workspaceId)?.delete(document.binding.currentPath);
              // The next pass sets the workspace's status without the pause.
              if (unpaused) ownerDelivery?.retry?.(workspaceId);
              if (!room.acknowledged && !unpaused) return;
              notifyRenderer({ workspaceId });
              if (!room.acknowledged) return;
              room.acknowledged = false;
              dependencies.notifyOwnerDraftsChanged?.(workspaceId);
            };
            room.ended = (async () => {
              try {
                await withOperation(workspaceId, async (operation) => {
                  const session = await server.connect(
                    operation.workspace,
                    AbortSignal.any([end.signal, operation.signal]),
                  );
                  if (!session) return;
                  const signal = AbortSignal.any([end.signal, operation.signal, session.signal]);
                  const native = (nativeOwnerDeliveryModule ??=
                    await import("./nativeOwnerDelivery"));
                  const opened = await sessions.runIfOpen(operation.workspace, async (binding) => ({
                    binding,
                    client: daemon.currentClient(),
                  }));
                  if (!opened || !(opened.client instanceof EngineClient)) return;
                  const { binding, client } = opened;
                  const assertCurrent = () => {
                    signal.throwIfAborted();
                    operation.assertCurrent();
                    session.assertCurrent();
                    sessions.assertCurrentBinding(operation.workspace, binding);
                    if (
                      generation !== ownerDeliveryGeneration ||
                      isQuitting() ||
                      daemon.currentClient() !== client ||
                      binding.client !== source.currentClient()
                    )
                      throw ended();
                  };
                  const hold = async <T>(work: () => Promise<T>): Promise<T> => {
                    let ran = false;
                    const result = await sessions.runIfOpen(operation.workspace, (current) => {
                      if (current !== binding) throw ended();
                      ran = true;
                      return work();
                    });
                    if (!ran) throw ended();
                    return result as T;
                  };
                  assertCurrent();
                  const outcome = await native.runNativeOwnerDeliveryPass({
                    client,
                    workspaceHandle: binding.workspace,
                    document,
                    config: { ...profile, relayUrl: session.relayUrl, documents },
                    refusals: (ownerRefusals ??= new native.OwnerKnownRefusals()),
                    signal,
                    bearer: session.bearer,
                    accountId: session.accountId,
                    assertCurrent,
                    hold,
                    lasting: {
                      count: () => ownerEditsOf(workspaceId).count,
                      landed: (seen, landedSignal) =>
                        new Promise<void>((resolve, reject) => {
                          const edits = ownerEditsOf(workspaceId);
                          if (edits.count > seen) return resolve();
                          landedSignal.throwIfAborted();
                          room.idle = true;
                          waited();
                          const wake = () => {
                            room.idle = false;
                            room.wake = undefined;
                            edits.waiters.delete(wake);
                            landedSignal.removeEventListener("abort", stop);
                            resolve();
                          };
                          const stop = () => {
                            room.idle = false;
                            room.wake = undefined;
                            edits.waiters.delete(wake);
                            reject(landedSignal.reason);
                          };
                          edits.waiters.add(wake);
                          room.wake = wake;
                          landedSignal.addEventListener("abort", stop, { once: true });
                        }),
                      acknowledged: () => {
                        room.acknowledged = true;
                      },
                    },
                  });
                  waited();
                  if (quarantinesMayChange(workspaceId, objectId, outcome))
                    await hold(() =>
                      readQuarantinesAfterPass(workspaceId, client, binding.workspace),
                    );
                });
              } catch (error) {
                if (!end.signal.aborted) console.error("[desktop] owner live room failed:", error);
              } finally {
                if (rooms.get(objectId) === room) rooms.delete(objectId);
                // A room that closed on its own waits, and a pass takes its note meanwhile.
                if (!end.signal.aborted && generation === ownerDeliveryGeneration) {
                  ownerRoomRetryAt.set(objectId, Date.now() + profile.retryDelayMs * 5);
                  ownerDelivery?.retry?.(workspaceId);
                }
              }
            })();
          };
          // Rooms for the listed notes their owner has open here, except those refused or held.
          const syncOwnerRooms = (
            workspaceId: string,
            documents: ListedOwnerDeliveryDocument[],
          ) => {
            const ownerHasOpen = dependencies.ownerHasOpen;
            if (!ownerHasOpen) return;
            const refused = refusedPaths(workspaceId),
              frozen = frozenOwnerDocuments.get(workspaceId),
              now = Date.now();
            const wanted = (document: ListedOwnerDeliveryDocument) => {
              const path = document.binding.currentPath;
              return (
                !ownerRoomsHeld.has(document.binding.objectId) &&
                !refused.has(path) &&
                !frozen?.has(path) &&
                ownerHasOpen(workspaceId, path)
              );
            };
            const rooms = ownerRooms.get(workspaceId);
            for (const [objectId, room] of rooms ?? []) {
              const listed = documents.find((document) => document.binding.objectId === objectId);
              if (!listed || !sameBinding(listed.binding, room.binding) || !wanted(listed))
                room.end.abort();
            }
            for (const document of documents) {
              const objectId = document.binding.objectId,
                retryAt = ownerRoomRetryAt.get(objectId) ?? 0;
              if (retryAt > now || ownerRooms.get(workspaceId)?.has(objectId)) continue;
              ownerRoomRetryAt.delete(objectId);
              if (wanted(document)) startOwnerRoom(workspaceId, document, documents);
            }
          };
          ownerDelivery = startServerOwnerDelivery({
            workspaceIds: () => server.workspaceIds(),
            ...profile,
            onError: (error) => console.error("[desktop] server owner delivery failed:", error),
            runPass: async (workspaceId, index, lifetime) => {
              if (!workspaceAuthorities.withOperation)
                throw new Error("This build is missing a dependency required for live editing.");
              activeOwnerWorkspace = workspaceId;
              try {
                return await workspaceAuthorities.withOperation(workspaceId, async (operation) => {
                  const session = await server.connect(
                    operation.workspace,
                    AbortSignal.any([lifetime, operation.signal]),
                  );
                  if (!session) {
                    setOwnerDeliveryStatus(workspaceId, undefined);
                    return { documentCount: 0, acknowledged: false };
                  }
                  const signal = AbortSignal.any([lifetime, operation.signal, session.signal]);
                  const check = () => {
                    signal.throwIfAborted();
                    operation.assertCurrent();
                    session.assertCurrent();
                    if (generation !== ownerDeliveryGeneration || isQuitting())
                      throw new Error("This live editing session ended.");
                  };
                  check();
                  try {
                    try {
                      await session.refusals(signal);
                    } catch (error) {
                      check();
                      console.error("[desktop] owner live refusal discovery failed:", error);
                    }
                    try {
                      await sessions.run(operation.workspace, async (binding) => {
                        const client = daemon.currentClient();
                        if (!(client instanceof EngineClient))
                          throw new Error("Owner Stop requires the desktop daemon client.");
                        let stopsChanged = false;
                        await reconcileOwnerLiveStops({
                          client,
                          workspaceHandle: binding.workspace,
                          workspaceId,
                          signal,
                          release: (target, acceptedCursor, releaseSignal) =>
                            releaseOwnerLiveStop(
                              workspaceId,
                              client,
                              binding.workspace,
                              target,
                              acceptedCursor,
                              releaseSignal,
                              (after, pageSignal) => session.journal(target, after, pageSignal),
                            ),
                          onError: (row, error) => {
                            stopsChanged = true;
                            const failures = ownerStopFailures.get(workspaceId) ?? new Map();
                            const detail = error instanceof Error ? error.message : String(error);
                            failures.set(row.document.objectId, {
                              objectId: row.document.objectId,
                              path: row.document.currentPath,
                              detail,
                            });
                            ownerStopFailures.set(workspaceId, failures);
                            notifyRenderer({ workspaceId });
                          },
                          onComplete: (row) => {
                            stopsChanged = true;
                            dependencies.notifyOwnerLiveStopped?.(
                              workspaceId,
                              row.document.objectId,
                              row.document.currentPath,
                            );
                            if (ownerStopFailures.get(workspaceId)?.delete(row.document.objectId))
                              notifyRenderer({ workspaceId });
                          },
                          retire: session.retire,
                          assertCurrent: () => {
                            check();
                            sessions.assertCurrentBinding(operation.workspace, binding);
                          },
                        });
                        // A Stop that finished or failed in the background changes what the
                        // notices say, even when no live document remains to deliver.
                        if (stopsChanged)
                          await readQuarantinesAfterPass(workspaceId, client, binding.workspace);
                      });
                    } catch (error) {
                      check();
                      console.error("[desktop] owner Stop discovery failed:", error);
                    }
                    // A pass holding an owner's open reads a list made after it.
                    const listedAt = ++ownerOpenClock;
                    const response = await session.documents(
                      signal,
                      (ownerOpened.get(workspaceId)?.size ?? 0) > 0,
                    );
                    check();
                    // A scan that does not complete keeps the last complete answer: the edits are still on the server.
                    try {
                      const kept = await readServerKeptEdits(response, (after) =>
                        session.keptEditsPage(after, signal),
                      );
                      check();
                      setServerQuarantines(workspaceId, kept);
                    } catch (error) {
                      check();
                      console.error("[desktop] server kept edits list failed:", error);
                    }
                    const listed = readyOwnerDeliveryDocuments(response, workspaceId);
                    check();
                    liveDocumentPaths.set(workspaceId, listedOwnerDeliveryPaths(response, listed));
                    try {
                      const resumes = ownerLivePauseResumes.get(workspaceId) ?? 0;
                      const pauses = await session.livePauses(signal);
                      check();
                      const { existsInWorkspace } = await import("./ownerLiveRecoveryCopy");
                      await sessions.run(operation.workspace, async (binding) => {
                        const client = daemon.currentClient();
                        if (!(client instanceof EngineClient))
                          throw new Error("Owner Stop requires the desktop daemon client.");
                        const settled = await settleOwnerLivePauses({
                          pauses,
                          previous: ownerLivePauses.get(workspaceId) ?? [],
                          tried: ownerLivePausesTried,
                          documents: listed,
                          client,
                          workspaceHandle: binding.workspace,
                          relay: {
                            copy: (pause, copySignal) =>
                              session.livePauseCopy(
                                pause.pauseId,
                                pause.copy?.byteLength ?? 0,
                                copySignal,
                              ),
                            copyWritten: session.livePauseCopyWritten,
                          },
                          writes: {
                            exists: existsInWorkspace(operation.workspace),
                            create: (relative, text) =>
                              createDurableFile(operation.workspace.rootPath, relative, text),
                          },
                          leaveLiveEditing: (path, leave, late) =>
                            dependencies.leaveLiveEditing
                              ? dependencies.leaveLiveEditing(workspaceId, path, leave, late)
                              : leave([]),
                          render: (state) =>
                            dependencies.documentProjection.run({ kind: "file", state }),
                          signal,
                          onError: (pause, error) =>
                            console.error("[desktop] a paused note could not be settled:", error),
                        });
                        check();
                        if (
                          resumes === (ownerLivePauseResumes.get(workspaceId) ?? 0) &&
                          JSON.stringify(settled) !==
                            JSON.stringify(ownerLivePauses.get(workspaceId) ?? [])
                        ) {
                          ownerLivePauses.set(workspaceId, settled);
                          notifyRenderer({ workspaceId });
                        }
                      });
                    } catch (error) {
                      check();
                      console.error("[desktop] paused notes discovery failed:", error);
                    }
                    const documents = withoutServerPauses(workspaceId, listed);
                    syncOwnerRooms(workspaceId, documents);
                    const { documents: listedRows, diverged } = response as {
                      documents: {
                        path: string;
                        status: string;
                        reason?: unknown;
                        objectId?: unknown;
                      }[];
                      diverged?: unknown;
                    };
                    // Before the open turn, which would host again a note it still holds.
                    try {
                      await sessions.run(operation.workspace, async (binding) => {
                        const client = daemon.currentClient();
                        if (!(client instanceof EngineClient))
                          throw new Error("Owner Stop requires the desktop daemon client.");
                        let released = false;
                        await releaseRetiredOwnerNotes({
                          client,
                          workspaceHandle: binding.workspace,
                          workspaceId,
                          signal,
                          listed: new Set(
                            listedRows.flatMap((row) =>
                              typeof row.objectId === "string" ? [row.objectId] : [],
                            ),
                          ),
                          journal: session.journal,
                          release: (target, acceptedCursor, releaseSignal) =>
                            releaseOwnerLiveStop(
                              workspaceId,
                              client,
                              binding.workspace,
                              target,
                              acceptedCursor,
                              releaseSignal,
                            ),
                          assertCurrent: () => {
                            check();
                            sessions.assertCurrentBinding(operation.workspace, binding);
                          },
                          onComplete: (row) => {
                            released = true;
                            dependencies.notifyOwnerLiveStopped?.(
                              workspaceId,
                              row.document.objectId,
                              row.document.currentPath,
                            );
                          },
                        });
                        if (released)
                          await readQuarantinesAfterPass(workspaceId, client, binding.workspace);
                      });
                    } catch (error) {
                      check();
                      console.error("[desktop] owner release of retired notes failed:", error);
                    }
                    try {
                      await ownerOpenTurn(
                        workspaceId,
                        session,
                        listedRows,
                        listedAt,
                        signal,
                        check,
                      );
                    } catch (error) {
                      check();
                      console.error("[desktop] owner live open failed:", error);
                    }
                    // A document whose live history this computer is starting reads as starting.
                    const starting = ownerHistoryTurn(workspaceId, listedRows);
                    const rows = listedRows.map((row) =>
                      starting.has(row.path) && row.status === "unavailable"
                        ? { path: row.path, status: "preparing" }
                        : row,
                    );
                    const preparing = rows.some((row) => row.status === "preparing");
                    // The server reports a diverged copy even after its owner stopped every document.
                    const unavailable =
                      diverged === true || rows.some((row) => row.status === "unavailable");
                    const unavailableFor = (reason: OwnerLiveDeliveryReason) =>
                      rows.some((row) => row.status === "unavailable" && row.reason === reason);
                    const reason =
                      diverged === true || unavailableFor("session-host-diverged")
                        ? "session-host-diverged"
                        : unavailableFor("note-format-off")
                          ? "note-format-off"
                          : unavailableFor("live-document-without-lineage")
                            ? "live-document-without-lineage"
                            : unavailableFor("session-host-refused")
                              ? "session-host-refused"
                              : unavailableFor("live-edit-unadmitted")
                                ? "live-edit-unadmitted"
                                : unavailableFor("conflict-parent-withheld")
                                  ? "conflict-parent-withheld"
                                  : unavailableFor("live-history-over-budget")
                                    ? "live-history-over-budget"
                                    : unavailableFor("live-start-failing")
                                      ? "live-start-failing"
                                      : unavailableFor("workspace-changed")
                                        ? "workspace-changed"
                                        : unavailableFor("document-unavailable")
                                          ? "document-unavailable"
                                          : undefined;
                    const ownerMustAct =
                      reason === "session-host-diverged" ||
                      reason === "note-format-off" ||
                      reason === "live-document-without-lineage" ||
                      reason === "session-host-refused" ||
                      reason === "live-edit-unadmitted" ||
                      reason === "conflict-parent-withheld" ||
                      reason === "live-history-over-budget";
                    const failures = failedOwnerDocuments.get(workspaceId) ?? new Set<string>();
                    const frozen = frozenOwnerDocuments.get(workspaceId) ?? new Set<string>();
                    for (const path of failures)
                      if (!documents.some((document) => document.binding.currentPath === path))
                        failures.delete(path);
                    for (const path of frozen)
                      if (!documents.some((document) => document.binding.currentPath === path))
                        frozen.delete(path);
                    const paused = pausedOwnerDocuments.get(workspaceId) ?? new Set<string>();
                    // The renderer keeps a paused note read-only until it reads the list again.
                    // A size check would miss one leaving while another pauses during the pass.
                    let unpaused = false;
                    for (const path of paused)
                      if (!documents.some((document) => document.binding.currentPath === path)) {
                        paused.delete(path);
                        unpaused = true;
                      }
                    failedOwnerDocuments.set(workspaceId, failures);
                    frozenOwnerDocuments.set(workspaceId, frozen);
                    if (!documents.length) {
                      if (unpaused) notifyRenderer({ workspaceId });
                      setOwnerDeliveryStatus(
                        workspaceId,
                        unavailable ? "retrying" : preparing ? "preparing" : undefined,
                        reason,
                      );
                      return { documentCount: 0, acknowledged: false };
                    }
                    const document = documents[index % documents.length]!;
                    const fullPasses =
                      fullOwnerPasses.get(workspaceId) ?? new Map<string, number>();
                    for (const objectId of fullPasses.keys())
                      if (!documents.some((listed) => listed.binding.objectId === objectId))
                        fullPasses.delete(objectId);
                    fullOwnerPasses.set(workspaceId, fullPasses);
                    // A head the list got wrong lasts until the note's first turn after
                    // OWNER_FULL_PASS_MS: that turn, and any turn after a failed pass, opens the connection.
                    const passStartedMs = Date.now(),
                      sinceFullMs =
                        passStartedMs - (fullPasses.get(document.binding.objectId) ?? -Infinity);
                    const fullPass =
                      failures.has(document.binding.currentPath) ||
                      !(sinceFullMs >= 0 && sinceFullMs < OWNER_FULL_PASS_MS);
                    nativeOwnerDeliveryModule ??= await import("./nativeOwnerDelivery");
                    check();
                    const native = nativeOwnerDeliveryModule;
                    const room = ownerRooms.get(workspaceId)?.get(document.binding.objectId);
                    const roomUp = room?.end.signal.aborted === false;
                    // A note in its room delivers there. Its turn wakes the room for an entry the
                    // engine queued itself, such as a Collection adoption.
                    if (roomUp) room.wake?.();
                    const result = roomUp
                      ? ("room" as const)
                      : await sessions.run(operation.workspace, async (binding) => {
                          const client = daemon.currentClient();
                          if (!(client instanceof EngineClient))
                            throw new Error("Owner delivery requires the desktop daemon client.");
                          const assertCurrent = () => {
                            check();
                            sessions.assertCurrentBinding(operation.workspace, binding);
                            if (
                              daemon.currentClient() !== client ||
                              binding.client !== source.currentClient()
                            )
                              throw new Error("This live editing session ended.");
                          };
                          assertCurrent();
                          const outcome = await native.runNativeOwnerDeliveryPass({
                            client,
                            workspaceHandle: binding.workspace,
                            document,
                            config: { ...profile, relayUrl: session.relayUrl, documents },
                            refusals: (ownerRefusals ??= new native.OwnerKnownRefusals()),
                            signal,
                            bearer: session.bearer,
                            accountId: session.accountId,
                            assertCurrent,
                            onEnrolled: async () => {
                              await readQuarantinesAfterPass(
                                workspaceId,
                                client,
                                binding.workspace,
                              );
                            },
                            ...(fullPass || document.head === undefined
                              ? {}
                              : { serverHead: document.head }),
                          });
                          if (quarantinesMayChange(workspaceId, document.binding.objectId, outcome))
                            await readQuarantinesAfterPass(workspaceId, client, binding.workspace);
                          return outcome;
                        });
                    check();
                    // A document the server refused names itself in its own notice. It
                    // is not retrying, and the rest of the workspace keeps delivering.
                    const path = document.binding.currentPath;
                    if (fullPass && result !== "retry")
                      fullPasses.set(document.binding.objectId, passStartedMs);
                    const blocked = result === "frozen" && !refusedPaths(workspaceId).has(path);
                    if (result === "retry" || blocked) failures.add(path);
                    else failures.delete(path);
                    if (blocked) frozen.add(path);
                    else if (result !== "retry") frozen.delete(path);
                    // A pass delivers one waiting edit, so only an empty queue takes edits again,
                    // as does a room's that waits for an edit.
                    // A refused queue, which this pass may have found, has its own notice.
                    const idleRooms = new Set(
                      [...(ownerRooms.get(workspaceId)?.values() ?? [])].flatMap((room) =>
                        room.idle ? [room.binding.currentPath] : [],
                      ),
                    );
                    for (const pausedPath of paused)
                      if (
                        (pausedPath === path && result === "empty") ||
                        idleRooms.has(pausedPath) ||
                        refusedPaths(workspaceId).has(pausedPath)
                      ) {
                        paused.delete(pausedPath);
                        unpaused = true;
                      }
                    if (result === "acknowledged" || result === "frozen") {
                      notifyRenderer({ workspaceId });
                      dependencies.notifyOwnerDraftsChanged?.(workspaceId);
                    } else if (unpaused) notifyRenderer({ workspaceId });
                    setOwnerDeliveryStatus(
                      workspaceId,
                      failures.size || paused.size || unavailable
                        ? "retrying"
                        : preparing
                          ? "preparing"
                          : "active",
                      frozen.size && !ownerMustAct
                        ? "document-unavailable"
                        : paused.size && !reason
                          ? "unsent-edits-limit"
                          : reason,
                      unavailable
                        ? "the server lists a document it can't host now"
                        : "a document's delivery asks to retry",
                    );
                    return {
                      documentCount: documents.length,
                      acknowledged: result === "acknowledged",
                    };
                  } catch (error) {
                    if (
                      !operation.signal.aborted &&
                      !session.signal.aborted &&
                      generation === ownerDeliveryGeneration &&
                      !isQuitting()
                    ) {
                      const previous = ownerDeliveryReason.get(workspaceId);
                      setOwnerDeliveryStatus(
                        workspaceId,
                        "retrying",
                        error instanceof OwnerLiveDiscoveryError
                          ? error.reason
                          : previous === "live-hosting-unavailable" ||
                              previous === "server-unreachable"
                            ? undefined
                            : previous,
                        error instanceof Error ? error.message : "a pass failed",
                      );
                    }
                    throw error;
                  }
                });
              } finally {
                activeOwnerWorkspace = undefined;
              }
            },
            runTargetedPass: async (workspaceId, objectIds, lifetime) => {
              if (!workspaceAuthorities.withOperation) return false;
              activeOwnerWorkspace = workspaceId;
              try {
                return await workspaceAuthorities.withOperation(workspaceId, async (operation) => {
                  const session = await server.connect(
                    operation.workspace,
                    AbortSignal.any([lifetime, operation.signal]),
                  );
                  if (!session) return false;
                  const signal = AbortSignal.any([lifetime, operation.signal, session.signal]);
                  const check = () => {
                    signal.throwIfAborted();
                    operation.assertCurrent();
                    session.assertCurrent();
                    if (generation !== ownerDeliveryGeneration || isQuitting())
                      throw new Error("This live editing session ended.");
                  };
                  const documents = withoutServerPauses(
                    workspaceId,
                    readyOwnerDeliveryDocuments(await session.documents(signal), workspaceId),
                  );
                  check();
                  const native = (nativeOwnerDeliveryModule ??=
                    await import("./nativeOwnerDelivery"));
                  return await withoutOwnerRooms(workspaceId, objectIds, () =>
                    catchUpOwnerDocuments(
                      documents,
                      objectIds,
                      (document) =>
                        sessions.run(operation.workspace, async (binding) => {
                          const client = daemon.currentClient();
                          if (!(client instanceof EngineClient)) return "retry";
                          const assertCurrent = () => {
                            check();
                            sessions.assertCurrentBinding(operation.workspace, binding);
                            if (
                              daemon.currentClient() !== client ||
                              binding.client !== source.currentClient()
                            )
                              throw new Error("This live editing session ended.");
                          };
                          assertCurrent();
                          const result = await native.runNativeOwnerDeliveryPass({
                            client,
                            workspaceHandle: binding.workspace,
                            document,
                            config: { ...profile, relayUrl: session.relayUrl, documents },
                            refusals: (ownerRefusals ??= new native.OwnerKnownRefusals()),
                            signal,
                            bearer: session.bearer,
                            accountId: session.accountId,
                            assertCurrent,
                            observedOnly: true,
                          });
                          if (quarantinesMayChange(workspaceId, document.binding.objectId, result))
                            await readQuarantinesAfterPass(workspaceId, client, binding.workspace);
                          if (result === "acknowledged" || result === "frozen")
                            dependencies.notifyOwnerDraftsChanged?.(workspaceId);
                          return result;
                        }),
                      check,
                    ),
                  );
                });
              } finally {
                activeOwnerWorkspace = undefined;
              }
            },
          });
          return;
        }
        if (
          generation !== ownerDeliveryGeneration ||
          isQuitting() ||
          ownerWorkspaceCloses ||
          !ownerDeliveryConfig ||
          !ownerDeliveryModule ||
          !nativeOwnerDeliveryModule ||
          !rustEngineDaemon ||
          !rustEngineWorkspaceSessions ||
          !rustEngineSessionSource
        )
          return;
        const config = ownerDeliveryConfig,
          daemon = rustEngineDaemon,
          sessions = rustEngineWorkspaceSessions,
          source = rustEngineSessionSource,
          native = nativeOwnerDeliveryModule;
        ownerDelivery = ownerDeliveryModule.startDesktopOwnerDelivery({
          config,
          onError: (error) => console.error("[desktop] owner delivery failed:", error),
          runPass: async (document, lifetime) => {
            const credentials = dependencies.ownerDeliveryCredentials?.();
            const workspace = dependencies.findWorkspace(document.binding.workspaceId);
            if (
              !credentials ||
              !relayUrlsMatch(credentials.relayUrl, config.relayUrl) ||
              !workspace ||
              workspace.pausedRemote
            )
              return "retry";
            if (!workspaceAuthorities.withOperation)
              throw new Error("This build is missing a dependency required for live editing.");
            return workspaceAuthorities.withOperation(document.binding.workspaceId, (operation) =>
              sessions.run(operation.workspace, async (binding) => {
                const client = daemon.currentClient();
                if (!(client instanceof EngineClient))
                  throw new Error("Owner delivery requires the desktop daemon client.");
                const signal = AbortSignal.any([lifetime, operation.signal, credentials.signal]);
                const assertCurrent = () => {
                  signal.throwIfAborted();
                  operation.assertCurrent();
                  sessions.assertCurrentBinding(operation.workspace, binding);
                  if (
                    generation !== ownerDeliveryGeneration ||
                    isQuitting() ||
                    daemon.currentClient() !== client ||
                    binding.client !== source.currentClient()
                  )
                    throw new Error("This live editing session ended.");
                };
                assertCurrent();
                const result = await native.runNativeOwnerDeliveryPass({
                  client,
                  workspaceHandle: binding.workspace,
                  document,
                  config,
                  refusals: (ownerRefusals ??= new native.OwnerKnownRefusals()),
                  signal,
                  bearer: credentials.bearer,
                  accountId: credentials.accountId,
                  assertCurrent,
                  onEnrolled: async () => {
                    await readQuarantinesAfterPass(
                      document.binding.workspaceId,
                      client,
                      binding.workspace,
                    );
                  },
                });
                assertCurrent();
                if (
                  quarantinesMayChange(
                    document.binding.workspaceId,
                    document.binding.objectId,
                    result,
                  )
                )
                  await readQuarantinesAfterPass(
                    document.binding.workspaceId,
                    client,
                    binding.workspace,
                  );
                if (result === "acknowledged" || result === "frozen") {
                  notifyRenderer({ workspaceId: document.binding.workspaceId });
                  dependencies.notifyOwnerDraftsChanged?.(document.binding.workspaceId);
                }
                return result;
              }),
            );
          },
        });
      })
      .catch((error) => console.error("[desktop] owner delivery startup failed:", error));
  }
  const ownerUsesWorkspace = (workspaceId: string) =>
    ownerHostConfig?.workspaceIds.includes(workspaceId) === true ||
    activeOwnerWorkspace === workspaceId ||
    (serverOwnerConfig !== undefined &&
      dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId) === true) ||
    ownerDeliveryConfig?.documents.some(
      (document) => document.binding.workspaceId === workspaceId,
    ) === true;
  const stopOwnerHost = () => {
    ownerHostGeneration += 1;
    const previous = ownerHost;
    ownerHost = undefined;
    previous?.stop();
  };
  const startOwnerHost = () => {
    stopOwnerHost();
    if (
      isQuitting() ||
      ownerWorkspaceCloses ||
      !ownerHostModule ||
      !ownerHostConfig ||
      !rustEngineDaemon ||
      !rustEngineWorkspaceSessions ||
      !rustEngineSessionSource ||
      !dependencies.existingOwnerFor
    )
      return;
    const daemon = rustEngineDaemon,
      sessions = rustEngineWorkspaceSessions,
      source = rustEngineSessionSource,
      config = ownerHostConfig;
    const generation = ownerHostGeneration;
    ownerHost = ownerHostModule.startDesktopOwnerHost({
      config,
      ownerFor: dependencies.existingOwnerFor,
      onError: (error) => console.error("[desktop] owner host connection failed:", error),
      bindings: async () => {
        const client = daemon.currentClient();
        if (!(client instanceof EngineClient))
          throw new Error("Owner host requires the desktop daemon client.");
        const workspaces = [];
        const bindingChecks: (() => void)[] = [];
        for (const workspaceId of config.workspaceIds) {
          const entry = dependencies.findWorkspace(workspaceId);
          if (!entry || entry.pausedRemote) continue;
          workspaces.push(
            await workspaceAuthorities.withAuthority(workspaceId, async (lease) => {
              lease.assertCurrent();
              const workspace = {
                workspaceId,
                rootPath: lease.binding.canonicalRootPath,
                attachmentId: lease.binding.attachmentId,
              };
              return sessions.run(workspace, async (binding) => {
                lease.assertCurrent();
                if (daemon.currentClient() !== client || binding.client !== source.currentClient())
                  throw new Error("Owner host daemon changed.");
                bindingChecks.push(() => sessions.assertCurrentBinding(workspace, binding));
                return { workspaceId, workspaceHandle: binding.workspace };
              });
            }),
          );
        }
        if (!workspaces.length) throw new Error("Owner host has no registered workspaces.");
        return {
          client,
          workspaces,
          assertCurrent: () => {
            if (
              isQuitting() ||
              ownerHostGeneration !== generation ||
              daemon.currentClient() !== client
            )
              throw new Error("This live editing session ended.");
            for (const check of bindingChecks) check();
          },
        };
      },
    });
  };
  // Settles with the daemon handshake (false = startup failed and the app will
  // quit). The whenReady continuation creates the window while the daemon
  // starts, so a fast renderer can ask for the engine before the handshake
  // settles; boot-time paths that need engine sessions await this first instead
  // of throwing the broken-invariant error at it.
  let engineDaemonStartup: Promise<boolean> = Promise.resolve(false);
  // A workspace that opens proves the engine's workspace work, so the startup
  // smoke runs only when none has opened by the time the launch settles.
  const startupSmoke = Promise.withResolvers<"run" | "skip">();
  const relayTransportRoutes = new RelayTransportRouteGuard();

  // Narrowing for the engine-access gates. The invariant is real:
  // every boot-time path that can reach the engine awaits engineDaemonStartup
  // first (openWorkspaceActivityWith, cloudStatus, the share-view file and
  // mount lanes), and a failed handshake
  // quits the app; this handle is nulled only on that
  // failure path. A later startup-smoke failure restarts the daemon without
  // nulling it. A throw here would mean that invariant broke, which must be
  // loud, not a silent drop to the legacy engine.
  function requireEngineSessions(): EngineWorkspaceSessions {
    if (!rustEngineWorkspaceSessions) {
      throw new Error("Rust engine workspace sessions are unavailable.");
    }
    return rustEngineWorkspaceSessions;
  }

  async function withOwnerHostPaused<Result>(
    pause: boolean,
    work: () => Promise<Result>,
  ): Promise<Result> {
    if (!pause) return work();
    ownerWorkspaceCloses += 1;
    try {
      stopOwnerHost();
      await stopOwnerDelivery();
      return await work();
    } finally {
      ownerWorkspaceCloses -= 1;
      if (!ownerWorkspaceCloses) {
        startOwnerHost();
        startOwnerDelivery();
      }
    }
  }

  async function closeRelayTransportWorkspace(workspace: string | EngineWorkspace): Promise<void> {
    const workspaceId = typeof workspace === "string" ? workspace : workspace.workspaceId;
    const reconnectOwner = ownerUsesWorkspace(workspaceId);
    await withOwnerHostPaused(reconnectOwner, async () => {
      if (rustEngineRelayClient) {
        await rustEngineRelayClient.closeWorkspace(workspace);
        return;
      }
      await rustEngineWorkspaceSessions?.closeWorkspace(workspace);
      relayTransportRoutes.releaseWorkspace(workspaceId);
    });
  }

  async function closeAllRelayTransportWorkspaces(options?: {
    accountChanged?: boolean;
  }): Promise<void> {
    await withOwnerHostPaused(true, async () => {
      if (rustEngineRelayClient) {
        await rustEngineRelayClient.closeAll(options);
        return;
      }
      await rustEngineWorkspaceSessions?.closeAll();
      for (const workspaceId of relayTransportRoutes.workspaceIds()) {
        relayTransportRoutes.releaseWorkspace(workspaceId);
      }
    });
  }

  // Test-only daemon restart seam (hermetic E2E: the daemon-kill spec needs the
  // outage to outlive the transport retry window, which production restarts far
  // too fast to reach). Ignored outside DOHC_DESKTOP_TEST like every other
  // DOHC_TEST_* seam.
  function testEngineRestartOverrides(): {
    initialBackoffMs?: number;
    maxBackoffMs?: number;
  } {
    if (process.env.DOHC_DESKTOP_TEST !== "1" || app.isPackaged) return {};
    const backoff = Number(process.env.DOHC_TEST_ENGINE_RESTART_BACKOFF_MS);
    if (!Number.isFinite(backoff) || backoff <= 0) return {};
    return { initialBackoffMs: backoff, maxBackoffMs: backoff };
  }

  async function startRustEngineDaemon(): Promise<boolean> {
    const restartingCollectionAutomations = new Set<CollectionAutomationsLifecycle>();
    // Everything, including resolving the binary path, runs inside the try: a
    // throw while building the options would otherwise reject this whenReady
    // callback and leave the user with no dialog, on the one path whose job is
    // to explain that the engine could not start.
    try {
      if (process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG) {
        if (!dependencies.existingOwnerFor)
          throw new Error("This build is missing a dependency required for live editing.");
        ownerHostModule = await import("./desktopOwnerHost");
        ownerHostConfig = ownerHostModule.readDesktopOwnerHostConfig(
          process.env.DOHC_DESKTOP_OWNER_HOST_CONFIG,
        );
      }
      if (process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG) {
        if (!dependencies.ownerDeliveryCredentials || !workspaceAuthorities.withOperation)
          throw new Error("This build is missing a dependency required for live editing.");
        ownerDeliveryModule = await import("./desktopOwnerDelivery");
        nativeOwnerDeliveryModule = await import("./nativeOwnerDelivery");
        ownerDeliveryConfig = ownerDeliveryModule.readDesktopOwnerDeliveryConfig(
          process.env.DOHC_DESKTOP_OWNER_DELIVERY_CONFIG,
        );
      }
      if (!ownerHostConfig && !ownerDeliveryConfig && dependencies.serverOwnerDelivery) {
        if (!workspaceAuthorities.withOperation)
          throw new Error("This build is missing a dependency required for live editing.");
        try {
          serverOwnerConfig = await dependencies.serverOwnerDelivery.prepare();
          serverOwnerUnavailable = false;
        } catch (error) {
          serverOwnerConfig = undefined;
          serverOwnerUnavailable = true;
          console.error("[desktop] owner live setup unavailable:", error);
        }
      }
      const hostIngress = ownerHostConfig && {
        configPath: ownerHostConfig.nativeConfigPath,
        client: {
          aggregateBytes: ownerHostConfig.transport.aggregateBytes,
          maxUploads: ownerHostConfig.transport.maxUploads,
        },
      };
      const peerIngress = ownerDeliveryConfig && {
        configPath: ownerDeliveryConfig.nativeConfigPath,
        client: ownerDeliveryConfig.nativeClient,
      };
      if (
        hostIngress &&
        peerIngress &&
        (hostIngress.configPath !== peerIngress.configPath ||
          hostIngress.client.aggregateBytes !== peerIngress.client.aggregateBytes ||
          hostIngress.client.maxUploads !== peerIngress.client.maxUploads)
      )
        throw new Error(
          "Private owner modes require the same native ingress configuration and client budget.",
        );
      const ingress =
        hostIngress ??
        peerIngress ??
        (serverOwnerConfig && {
          configPath: serverOwnerConfig.nativeConfigPath,
          client: serverOwnerConfig.nativeClient,
        });
      let publications = 0;
      rustEngineDaemon = createRustEngineDaemon({
        readerConfig: installedReaderConfig(dependencies.resourcesBasePath()),
        ...(ingress ? { privateOwnerHost: ingress } : {}),
        startupSmoke: startupSmoke.promise,
        // On Linux, Ctrl+C or a stop sent to dohc's process group reaches dohc
        // only. dohc quits and stops the engine at the end of its quit.
        ownProcessGroup: process.platform === "linux",
        ...testEngineRestartOverrides(),
        command: defaultEngineBinaryPath({
          isPackaged: app.isPackaged,
          appPath: app.getAppPath(),
          resourcesPath: process.resourcesPath,
        }),
        onFailure: (error, terminal) => {
          // The supervisor's diagnostic is for us: it names engine.ping, probe
          // counts and wedge budgets, which tell a developer or an agent exactly
          // which limit was hit. It goes to the log in full.
          console.error("[desktop] Rust engine daemon:", error);
          // One problem per crash: the first failure, not each restart
          // attempt after it, then the final verdict if restarts run out.
          if (!isQuitting() && (terminal || !engineProblemRecorded)) {
            recordEngineProblem(error, terminal ? "stopped" : "restarting");
            if (!terminal) engineProblemRecorded = true;
          }
          if (terminal && !isQuitting()) {
            // The dialog is for the user, so it says what broke and what to do
            // instead — no internal names, one instruction per sentence
            // (the dohc-interface skill). Use the same workspace engine name
            // as the runner settings.
            //
            // Cause-neutral on purpose: a terminal failure also arrives from the
            // restart limit and the crash window, where the engine crashed
            // rather than went silent. Every one of them ends the same way.
            dialog.showErrorBox(
              "The workspace engine stopped",
              "dohc stopped restarting the workspace engine.\n\n" +
                "Restart dohc. If this happens again, check the desktop logs or reinstall dohc.",
            );
          }
        },
        beforePublish: async (signal) => {
          const gate = process.env.DOHC_TEST_ENGINE_PUBLICATION_GATE;
          if (
            publications++ > 0 &&
            process.env.DOHC_DESKTOP_TEST === "1" &&
            !app.isPackaged &&
            gate
          )
            await waitForEnginePublicationGate(gate, signal);
          void dependencies.backgroundLiveStart?.pause();
          stopOwnerHost();
          await stopOwnerDelivery();
          await Promise.all(
            workspaceAuthorities.workspaceIds().map((workspaceId) =>
              workspaceAuthorities.withAuthority(workspaceId, (lease) => {
                const automations = lease.state.collectionAutomations;
                automations.pauseForEngineRestart();
                restartingCollectionAutomations.add(automations);
              }),
            ),
          );
        },
        // A capture event can die with the previous daemon's transport after its
        // moment committed; the replacement never re-emits it (its baseline finds
        // disk and manifest agreeing). One repaint per healthy launch closes that
        // staleness window. Scope-free: the lost event could have belonged to
        // any open workspace.
        onLaunch: () => {
          engineProblemRecorded = false;
          startOwnerHost();
          startOwnerDelivery();
          for (const automations of restartingCollectionAutomations) {
            automations.resumeAfterEngineRestart();
          }
          restartingCollectionAutomations.clear();
          dependencies.backgroundLiveStart?.resume();
          notifyRenderer();
        },
      });
      await rustEngineDaemon.start();
      // Collection projection completion is a separate derived-state wake, and
      // so is the end of a new workspace's first read: reads refused during it
      // can be answered now. Workspace activity owns capture and file
      // observation delivery.
      bridgeCaptureEventsToRenderer(
        {
          onEvent: (listener) =>
            rustEngineDaemon!.onEvent((event) => {
              if (
                event.name === COLLECTIONS_PROJECTED_EVENT ||
                event.name === CAPTURE_INITIAL_SETTLED_EVENT
              )
                listener(event);
            }),
        },
        (scope) => notifyRenderer(scope ? { ...scope, pathSetChanged: false } : undefined),
      );
      // The first placement that falls back on a drive without atomic
      // renames announces it at once; the capture health poll is a backstop.
      bridgeNoAtomicPlacement(rustEngineDaemon, dependencies.noteNoAtomicPlacement);
      bridgeWriteDeferred(rustEngineDaemon, dependencies.noteWriteDeferred);
      rustEngineDaemon.onEvent((event) => {
        if (event.name === "sync.refusalsChanged") dependencies.onRefusalsChanged?.();
        if (event.name === CAPTURE_MOMENT_RECORDED_EVENT && dependencies.backgroundLiveStart) {
          const scope = scopeOf(event.payload);
          if (scope?.paths) dependencies.backgroundLiveStart.note(scope.workspaceId, scope.paths);
        }
      });
      // The daemon also claims each local record change for its subscribed
      // automations (ADR 0008); its automation.claimed events wake the owning
      // workspace's executors to drain the durable claim table, and a claim
      // inserted already failed (the depth cap's chain-stopped stop report)
      // tells the executor, which sends its failure notice.
      bridgeAutomationClaimsToExecutors(
        rustEngineDaemon,
        (workspaceId) => ({
          notifyClaimed() {
            dependencies.collectionAutomations.current(workspaceId)?.notifyClaimed();
          },
        }),
        (workspaceId) => dependencies.collectionAutomations.current(workspaceId)?.failuresChanged(),
      );
      const relaySource = new RelayConfiguredDaemonClientSource(
        rustEngineDaemon,
        relayTransportRoutes,
        (workspaceId) => hasNoOrdinarySync(dependencies.findWorkspace(workspaceId)),
      );
      rustEngineSessionSource = relaySource;
      // A fresh debug-engine adoption measured 18.7 s for 5,000 files and
      // 101.8 s for 15,000 files on the launch fixture; 120 s bounds that path
      // with headroom. The renderer names the wait.
      rustEngineWorkspaceSessions = new EngineWorkspaceSessions(relaySource, {
        workspaceOpenDeadlineMs: 120_000,
        onOpened: (workspace) => {
          startupSmoke.resolve("skip");
          dependencies.onWorkspaceOpened?.(workspace.workspaceId);
          if (workspace.shareMount === true) return;
          dependencies.notifyOwnerDraftsChanged?.(workspace.workspaceId);
          // Refused edits wait in the engine's queues across restarts, so each open reads them again.
          void Promise.resolve()
            .then(() => refreshOwnerLiveQuarantines(workspace))
            .catch((error) => console.error("[desktop] owner live quarantine read failed:", error));
        },
      });
      const sessions = rustEngineWorkspaceSessions;
      rustEngineRelayClient = new EngineRelayClient({
        onRefusalsChanged: dependencies.onRefusalsChanged,
        onShareViewPullProgress: dependencies.onShareViewPullProgress,
        sessions,
        routes: relayTransportRoutes,
        closeWorkspaceBinding: (workspace) =>
          withOwnerHostPaused(ownerUsesWorkspace(workspace.workspaceId), () =>
            sessions.closeWorkspaceBinding(workspace).catch(() => undefined),
          ),
      });
      startOwnerHost();
      startOwnerDelivery();
      console.info("[desktop] Rust engine daemon handshake complete.");
      // Marked here, where the handshake actually completes — the bootstrap
      // gate's await also covers the cached-settings read, which would inflate
      // this mark.
      launchMarks.daemonReady();
      desktopMarks.markOnce("daemon-ready");
      logLaunchMarksOnce();
      return true;
    } catch (error) {
      stopOwnerHost();
      await stopOwnerDelivery();
      const message = error instanceof Error ? error.message : "Unknown Rust engine startup error.";
      console.error("[desktop] Rust engine daemon failed to start:", error);
      recordEngineProblem(error, "startup");
      dialog.showErrorBox(
        "dohc could not start the workspace engine",
        `${message}\n\ndohc cannot start without the workspace engine. Restart dohc. If it fails again, reinstall dohc.`,
      );
      // Contained: a stop() throw here would reject engineDaemonStartup itself
      // and rethrow from every gated await instead of letting the caller's
      // quit land.
      await rustEngineDaemon?.stop().catch((stopError: unknown) => {
        console.error("[desktop] Rust engine daemon stop after failed start:", stopError);
      });
      rustEngineDaemon = null;
      rustEngineWorkspaceSessions = null;
      rustEngineRelayClient = null;
      rustEngineSessionSource = null;
      // The app lifecycle quits, after it checks for a build that fixes this.
      return false;
    }
  }

  return {
    /** The move guard's view of which pages are live. Undefined until a complete list arrives. */
    liveDocumentPaths(workspaceId: string): readonly LiveDocumentPath[] | undefined {
      return liveDocumentPaths.get(workspaceId);
    },
    /** True only when an owner sync answered for every listed page, or this device is not bound to it. */
    ownerCatchUp(
      workspaceId: string,
      objectIds: readonly string[],
      signal: AbortSignal,
    ): Promise<boolean> {
      return ownerDelivery?.catchUp?.(workspaceId, objectIds, signal) ?? Promise.resolve(false);
    },
    retryOwnerDelivery(workspaceId: string): void {
      if (dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId))
        ownerDelivery?.retry?.(workspaceId);
    },
    /** The owner's edit of a shared note reached its queue for the server: its room sends it now. */
    ownerEditLanded(workspaceId: string): void {
      const edits = ownerEditsOf(workspaceId);
      edits.count += 1;
      for (const wake of [...edits.waiters]) wake();
    },
    /**
     * The owner opened `path`, which this computer holds an owner binding for,
     * in an editor here. A pass asks the server to host it unless a list read
     * after the open names it live or starting, and a refusal before is no
     * longer an answer. A pass starts now unless the last list named it live
     * or starting; then the next pass reads the list that decides.
     */
    ownerOpenedLiveDocument(workspaceId: string, path: string): void {
      if (!dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId)) return;
      ownerOpenRefused.get(workspaceId)?.delete(path);
      let opened = ownerOpened.get(workspaceId);
      if (!opened) ownerOpened.set(workspaceId, (opened = new Map()));
      opened.delete(path);
      opened.set(path, ++ownerOpenClock);
      // Only the latest opens wait; an editor opens one document at a time.
      for (const oldest of opened.keys()) {
        if (opened.size <= 64) break;
        opened.delete(oldest);
      }
      if (!hostedOwnerPaths.get(workspaceId)?.has(path)) ownerDelivery?.retry?.(workspaceId);
    },
    ownerLiveDeliveryStatus(workspaceId: string): OwnerLiveDeliveryStatus | undefined {
      return dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId)
        ? serverOwnerUnavailable
          ? "retrying"
          : ownerDeliveryStatus.get(workspaceId)
        : undefined;
    },
    ownerLiveStopFailures(workspaceId: string) {
      return [...(ownerStopFailures.get(workspaceId)?.values() ?? [])];
    },
    ownerLivePauses(workspaceId: string): OwnerLivePause[] {
      return dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId)
        ? (ownerLivePauses.get(workspaceId) ?? [])
        : [];
    },
    /**
     * Ends the server's pause of the note at `path`, once its copy is written,
     * so the server takes edits again. Resume then clears this computer's
     * paused Stop as it clears any other. Returns the pause's cause, or null
     * when the note is not paused.
     */
    async resumeOwnerLivePause(
      workspace: EngineWorkspace,
      path: string,
    ): Promise<OwnerLivePause["cause"] | null> {
      const pause = ownerLivePauses.get(workspace.workspaceId)?.find((row) => row.path === path);
      if (!pause) return null;
      ownerLivePauseResumes.set(
        workspace.workspaceId,
        (ownerLivePauseResumes.get(workspace.workspaceId) ?? 0) + 1,
      );
      await withServerSession(workspace.workspaceId, (session, signal) =>
        session.resumeLivePause(pause.pauseId, signal),
      );
      // Again once it is done, for a pass that read the pauses while it ran.
      ownerLivePauseResumes.set(
        workspace.workspaceId,
        (ownerLivePauseResumes.get(workspace.workspaceId) ?? 0) + 1,
      );
      ownerLivePauses.set(
        workspace.workspaceId,
        (ownerLivePauses.get(workspace.workspaceId) ?? []).filter(
          (row) => row.pauseId !== pause.pauseId,
        ),
      );
      notifyRenderer({ workspaceId: workspace.workspaceId });
      return pause.cause;
    },
    // A document's queue on this computer speaks for it before any the server
    // keeps. A record that can only be saved leaves the server's row its own.
    ownerLiveQuarantines(workspaceId: string): OwnerLiveQuarantine[] {
      const local: OwnerLiveQuarantine[] = (ownerQuarantines.get(workspaceId) ?? []).map((row) => ({
        objectId: row.objectId,
        path: row.path,
        reason: row.reason,
        storedOn: "this-computer",
        incident: quarantineIncident(row),
        recovery: row.recovery,
        ...(row.saveOnly ? { saveOnly: true } : {}),
      }));
      return [
        ...local,
        ...serverQuarantinesOf(workspaceId)
          .filter(
            (row) =>
              !local.some(
                (kept) =>
                  kept.objectId === row.objectId &&
                  kept.recovery !== "cannot-write" &&
                  !kept.saveOnly,
              ),
          )
          .map((row): OwnerLiveQuarantine => ({
            objectId: row.objectId,
            path: row.path,
            reason: row.reason,
            storedOn: "server",
            incident: serverIncident(row),
            recovery: row.recovery,
            ...(row.earlier ? { earlier: true } : {}),
          })),
      ];
    },
    refreshOwnerLiveQuarantines,
    /** Grants the refused head one more attempt, if the owner saw this incident. */
    async retryOwnerLiveQuarantine(
      workspace: EngineWorkspace,
      objectId: string,
      incident: string,
    ): Promise<void> {
      if (incident.startsWith("server:")) {
        const row = serverQuarantinesOf(workspace.workspaceId).find(
          (candidate) => candidate.objectId === objectId && serverIncident(candidate) === incident,
        );
        if (!row || row.recovery === "retrying")
          throw new Error("This document changed. Open Live documents to check it.");
        if (row.earlier) throw new ServerKeptEditsConflict(true);
        await serverKeptEditsAction(workspace.workspaceId, row, () =>
          withServerSession(workspace.workspaceId, (session, signal) =>
            session.keptEdits(
              { action: "retry", outboxId: row.outboxId, generation: row.generation },
              signal,
            ),
          ),
        );
        setServerQuarantines(
          workspace.workspaceId,
          serverQuarantinesOf(workspace.workspaceId).map((candidate): ServerKeptEdits =>
            candidate === row ? { ...row, recovery: "retrying" } : candidate,
          ),
        );
        ownerDelivery?.retry?.(workspace.workspaceId);
        return;
      }
      // Try again for a queue whose head the engine refused to read reads it
      // again, and fails with the engine's refusal while it still refuses.
      if (incident.startsWith("unreadable:")) {
        await withEngineClient(workspace, (client, handle) =>
          readOwnerQuarantinesInto(
            workspace.workspaceId,
            client,
            handle,
            (queue) => queue.objectId === objectId,
          ),
        );
        return;
      }
      await withEngineClient(workspace, async (client, handle) => {
        // Read again, so a Try again never names a queue that already changed.
        const row = (await readOwnerQuarantinesInto(workspace.workspaceId, client, handle)).find(
          (candidate) =>
            candidate.objectId === objectId && quarantineIncident(candidate) === incident,
        );
        if (row?.saveOnly)
          throw new Error(
            "These edits were kept after a restore and cannot be sent again. Save a recovery copy using this path and incident.",
          );
        if (!row || row.outboxId === null || row.recovery !== "paused") {
          throw new Error("This document changed. Open Live documents to check it.");
        }
        const outboxId = row.outboxId;
        await retryOwnerLiveQuarantine(client, handle, { ...row, outboxId });
        ownerQuarantineAttempts.set(outboxId, (ownerQuarantineAttempts.get(outboxId) ?? 0) + 1);
        // The grant leaves the queue's size as it was, so its head is read again.
        ownerQuarantineHeads.get(workspace.workspaceId)?.delete(outboxId);
        // The attempt is granted; a failed read must not report it as refused.
        await readQuarantinesAfterPass(workspace.workspaceId, client, handle);
      });
      ownerDelivery?.retry?.(workspace.workspaceId);
    },
    /** The records of Stops that took refused edits but could not write the file, read from their own file. */
    unwrittenOwnerLiveReleases(workspaceId: string) {
      return dependencies.ownerLiveReleases.list(workspaceId);
    },
    /** A Stop's release, recorded until the file holds any refused edits it took. */
    async releaseOwnerLiveStop(
      workspace: RegistryEntry,
      binding: LiveObjectBinding,
      acceptedCursor: number,
    ) {
      // Signed out, the release still runs, and waits if the file is behind.
      const lifetime = new AbortController();
      try {
        const session = await dependencies.serverOwnerDelivery?.connect(workspace, lifetime.signal);
        return await withEngineClient(workspace, (client, handle) =>
          releaseOwnerLiveStop(
            workspace.workspaceId,
            client,
            handle,
            binding,
            acceptedCursor,
            session?.signal,
            session ? (after, signal) => session.journal(binding, after, signal) : undefined,
          ),
        );
      } finally {
        lifetime.abort();
      }
    },
    /**
     * Resume clears a document's Stop. A release still owed to the file keeps
     * its record and recovery package: resuming does not write the file. The
     * engine no longer holds that release, so only Save recovery copy remains,
     * and the next Stop is an ordinary one. The engine names the Stop it
     * cleared, including a finished one its list no longer shows.
     */
    clearOwnerLiveStop(
      workspace: EngineWorkspace,
      document: OwnerLiveStop["document"],
    ): Promise<void> {
      return withEngineClient(workspace, async (client, handle) => {
        const cleared = (
          await client.ownerYDocStopClear(
            { id: 0, workspace: handle, deadlineMs: 30_000 },
            document,
          )
        )?.binding;
        if (cleared)
          await dependencies.ownerLiveReleases.endRetry(
            workspace.workspaceId,
            cleared.objectId,
            cleared,
          );
      });
    },
    /**
     * Try again for a Stop whose release took refused edits but could not
     * write the file: settles that release again and never starts a release.
     * The record names that release by the snapshot of its edits, so an older
     * Stop under the same binding, restored from an earlier engine state, does
     * not answer for it. When the engine no longer holds that release, nothing
     * shows the file has the edits: the record and its package stay, offering
     * only Save recovery copy. A release that never committed leaves its Stop
     * requested: Try again keeps the record's, and answers "requested" so the
     * Stop goes on as an ordinary one with the same edits.
     */
    async retryOwnerLiveRelease(
      workspace: EngineWorkspace,
      objectId: string,
    ): Promise<OwnerLiveStop | "requested" | undefined> {
      return withEngineClient(workspace, async (client, handle) => {
        const releases = dependencies.ownerLiveReleases;
        const record = (await releases.list(workspace.workspaceId)).find(
          (row) => row.objectId === objectId && row.retry,
        );
        const { binding, snapshot } = record ?? {};
        if (!binding || !snapshot)
          throw new Error("This document changed. Open Live documents to check it.");
        try {
          const released = await client.ownerYDocRelease(
            { id: 0, workspace: handle, deadlineMs: 30_000 },
            binding,
            dependencies.localPersonId(),
            { keptSnapshot: snapshot },
          );
          if (released.materialized === true)
            await releases.written(workspace.workspaceId, objectId, {
              binding,
              snapshot: released.keptSnapshot ?? null,
            });
          if (released.keptSnapshot === snapshot) return released;
          // The engine holds another release under this binding, which says nothing about this record's edits.
          await releases.endRetry(workspace.workspaceId, objectId, binding);
          return undefined;
        } catch (error) {
          if (!(error instanceof EngineRequestError && error.message === "owner-stop-conflict"))
            throw error;
          const stops = await client.ownerYDocStopList({
            id: 0,
            workspace: handle,
            deadlineMs: 30_000,
          });
          if (
            stops.some((stop) => stop.state === "requested" && sameBinding(stop.binding, binding))
          )
            return "requested";
          await releases.endRetry(workspace.workspaceId, objectId, binding);
          return undefined;
        } finally {
          await readQuarantinesAfterPass(workspace.workspaceId, client, handle);
        }
      });
    },
    /**
     * Save recovery copy: writes a document's kept edits next to its file, as
     * a lossless package and, when they rebuild the document, a readable copy.
     * The queue stays. It works while live editing is stopped, after a Stop
     * took the edits but could not write the file, and for any size. Saving a
     * Stop's stored package ends its record: the workspace now holds the edits.
     * An incident saves exactly the row that shows it.
     */
    async saveOwnerLiveRecoveryCopy(
      workspace: EngineWorkspace,
      path: string,
      incident?: string,
    ): Promise<LiveRecoveryFiles & { keptEdits: "kept" | "copied" | "ended" }> {
      const recovery = await import("./ownerLiveRecoveryCopy");
      const releases = dependencies.ownerLiveReleases;
      const records = await releases.list(workspace.workspaceId);
      const changed = () => new Error("This document changed. Open Live documents to check it.");
      const named =
        incident === undefined
          ? undefined
          : incident.startsWith("server:")
            ? "server"
            : incident.startsWith("release:")
              ? "record"
              : "queue";
      const read: { record?: UnwrittenRelease; queued?: LiveRecoveryPackage } =
        named === "server"
          ? {}
          : await withEngineClient(workspace, async (client, handle) => {
              if (named === "record") {
                const record = records.find(
                  (candidate) => candidate.path === path && releaseIncident(candidate) === incident,
                );
                if (!record) throw changed();
                return { record };
              }
              // A queue at this path whose head the engine refuses to read fails the save with that refusal.
              const row = (
                await readOwnerLiveQuarantines(client, handle, {
                  strict: (queue) => queue.currentPath === path,
                })
              ).find(
                (candidate) =>
                  candidate.path === path &&
                  candidate.outboxId !== null &&
                  (named === undefined || quarantineIncident(candidate) === incident),
              );
              if (named === "queue" && !row) throw changed();
              // Without a row, a record goes first, unless its package holds exactly this queue's edits, which the queue still holds.
              const record = named
                ? undefined
                : (records.find((candidate) => candidate.path === path) ??
                  records.find((candidate) => candidate.objectId === row?.objectId));
              if (
                record &&
                (!row?.outboxId ||
                  !record.retry ||
                  record.objectId !== row.objectId ||
                  record.headDeliveryId !== row.headDeliveryId)
              )
                return { record };
              if (!row?.outboxId) return {};
              const queue = await readOwnerLiveQueue(client, handle, row);
              if (
                record &&
                !sameRelease(record, {
                  binding: row.binding,
                  headDeliveryId: row.headDeliveryId,
                  snapshot: recoverySnapshot(queue),
                })
              )
                return { record };
              return {
                queued: recovery.liveRecoveryPackage(queue, {
                  path: row.path,
                  reason: row.reason,
                  storedOn: "this-computer",
                }),
              };
            });
      const writes = {
        create: (relative: string, text: string) =>
          createDurableFile(workspace.rootPath, relative, text),
        keep: recovery.keepOnThisComputer(workspace),
        exists: recovery.existsInWorkspace(workspace),
      };
      // Edits the server keeps: read them whole, one bounded page at a time,
      // write them here, then tell the server a durable copy of this refusal
      // exists, so it may let the document go. Until it hears, it keeps them.
      const held =
        read.queued || read.record
          ? undefined
          : serverQuarantinesOf(workspace.workspaceId).find(
              (row) =>
                row.path === path && (named === undefined || serverIncident(row) === incident),
            );
      if (named === "server" && !held) throw changed();
      if (held) {
        const queue = await serverKeptEditsAction(workspace.workspaceId, held, () =>
          withServerSession(workspace.workspaceId, (session, signal) =>
            readServerKeptEditsQueue(held, (cursor) =>
              session.keptEdits(
                {
                  action: "page",
                  outboxId: held.outboxId,
                  generation: held.generation,
                  ...(cursor === undefined ? {} : { cursor }),
                },
                signal,
              ),
            ),
          ),
        );
        const files = await recovery.saveLiveRecoveryCopy(
          recovery.liveRecoveryPackage(queue, {
            path: held.path,
            reason: held.reason,
            storedOn: "server",
          }),
          writes,
          dependencies.documentProjection,
        );
        try {
          // The checkpoint this copy holds: a later accepted edit makes the server ask for another.
          await serverKeptEditsAction(workspace.workspaceId, held, () =>
            withServerSession(workspace.workspaceId, (session, signal) =>
              session.keptEdits(
                {
                  action: "copied",
                  outboxId: held.outboxId,
                  generation: held.generation,
                  checkpointDigest: queue.checkpointDigest,
                },
                signal,
              ),
            ),
          );
          setServerQuarantines(
            workspace.workspaceId,
            serverQuarantinesOf(workspace.workspaceId).map((row): ServerKeptEdits =>
              row.generation === held.generation ? { ...row, recovery: "copied" } : row,
            ),
          );
        } catch (error) {
          // The copy is written. The server keeps the edits until a later save confirms one.
          console.error("[desktop] the server did not record the recovery copy:", error);
          return { ...files, keptEdits: "kept" };
        }
        return { ...files, keptEdits: "copied" };
      }
      if (read.queued)
        return {
          ...(await recovery.saveLiveRecoveryCopy(
            read.queued,
            writes,
            dependencies.documentProjection,
          )),
          keptEdits: "kept",
        };
      const record = read.record;
      if (!record)
        throw new Error("dohc has no kept edits for this file. Open Live documents to check it.");
      // Ends the record it saved, never a later one that replaced it.
      const end = async () => {
        await releases.remove(workspace.workspaceId, record.objectId, record);
        await refreshOwnerLiveQuarantines(workspace).catch((error) =>
          console.error("[desktop] owner live quarantine read failed:", error),
        );
      };
      const text = await releases.recovery(workspace.workspaceId, record.objectId);
      if (text === null) {
        // Nothing is left to protect, and the notice would block every later Stop.
        await end();
        throw new Error(
          `The kept edits dohc stored for ${record.path} are missing from this computer, so dohc removed their notice.`,
        );
      }
      const files = await recovery.saveLiveRecoveryCopy(
        recovery.parseLiveRecoveryPackage(text),
        writes,
        dependencies.documentProjection,
      );
      // A package without a readable copy means these edits can't become one,
      // so Try again would fail the same way. A copy that couldn't be written
      // throws instead, and the record stays.
      await end();
      return { ...files, keptEdits: "ended" };
    },
    clearOwnerLiveStopFailure(workspaceId: string, target: { objectId: string }) {
      if (ownerStopFailures.get(workspaceId)?.delete(target.objectId))
        notifyRenderer({ workspaceId });
    },
    /** The engine refused an edit to `path` because its queue for the server takes no more. A refused queue has its own notice. */
    noteOwnerLiveEditsPaused(workspaceId: string, path: string): void {
      // A full queue is not one its room waits at, so the room sends before it counts as idle again.
      for (const room of ownerRooms.get(workspaceId)?.values() ?? [])
        if (room.binding.currentPath === path) room.wake?.();
      const paused = pausedOwnerDocuments.get(workspaceId) ?? new Set<string>();
      if (
        !dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId) ||
        paused.has(path) ||
        refusedPaths(workspaceId).has(path)
      )
        return;
      pausedOwnerDocuments.set(workspaceId, paused.add(path));
      const reason = ownerDeliveryReason.get(workspaceId) ?? "unsent-edits-limit";
      if (
        ownerDeliveryStatus.get(workspaceId) === "retrying" &&
        ownerDeliveryReason.get(workspaceId) === reason
      )
        dependencies.notifyOwnerDeliveryChanged?.(workspaceId);
      else setOwnerDeliveryStatus(workspaceId, "retrying", reason);
    },
    ownerLivePausedPaths(workspaceId: string): string[] {
      return [...(pausedOwnerDocuments.get(workspaceId) ?? [])];
    },
    ownerLiveDeliveryReason(workspaceId: string): OwnerLiveDeliveryReason | undefined {
      return dependencies.serverOwnerDelivery?.workspaceIds().includes(workspaceId)
        ? serverOwnerUnavailable
          ? "restart-required"
          : ownerDeliveryReason.get(workspaceId)
        : undefined;
    },
    hasOwnerLiveRefusals(workspaceId: string): boolean | undefined {
      return dependencies.serverOwnerDelivery?.hasRefusals(workspaceId);
    },
    get daemon() {
      return rustEngineDaemon;
    },
    get sessions() {
      return rustEngineWorkspaceSessions;
    },
    get relayClient() {
      return rustEngineRelayClient;
    },
    get startup() {
      return engineDaemonStartup;
    },
    requireEngineSessions,
    withOwnerHostPaused: <Result>(work: () => Promise<Result>) => withOwnerHostPaused(true, work),
    closeRelayTransportWorkspace,
    closeAllRelayTransportWorkspaces,
    start() {
      engineDaemonStartup = startRustEngineDaemon();
      return engineDaemonStartup;
    },
    launchSettled() {
      startupSmoke.resolve("run");
    },
  };
}
