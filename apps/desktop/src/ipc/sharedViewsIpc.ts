import { randomUUID } from "node:crypto";
import { normalizeRootPath } from "@dohc/workspace-core";
import { shareCaptureNoticeState } from "../workspaces/shareCaptureNotice";
import {
  type OpenSharedViewPayload,
  RefreshSharedViewPayload,
  RefreshSharedViewResult,
  sharedViewAccessOperations,
  type CheckSharedViewAccessResult,
  engineStoreRefusalRecovery,
  UPDATING_ACCESS_MESSAGE,
} from "./bridgeContract";
import { registerOperations } from "./operationTable";
import {
  engineStoreRefusalDetailOf,
  engineStoreRefusalOf,
  type EngineStoreRefusal,
} from "@dohc/workspace-engine-client";
import {
  credentialScopedOperation,
  requireCredentials,
} from "../workspaces/credentialScopedOperation";
import { parseShareCode, relayUrlsMatch } from "../workspaces/syncCode";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
  type ShareReachSignatures,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { refreshReceivedReferencePin } from "../workspaces/workspaceFileReferenceScopes";
import {
  ShareSelectorInvalidError,
  type fetchShareViewInfo,
  type fetchShareViewAccess,
  type fetchShareViewReach,
  type probeShareViewLog,
  type ShareViewSelector,
} from "../workspaces/shareViewInfo";
import { storedShareViewReach } from "../workspaces/shareViewReach";
import type { ListedReach } from "@dohc/security-contract/listed-reach";
import type { RendererWorkspaceOperationSession } from "../window/rendererWorkspaceOperation";
import {
  SHARE_VIEW_REOPEN_MESSAGE,
  shareViewIdentityIsIntact,
  shareViewIsPresent,
} from "../workspaces/shareViewMarker";
import {
  SharePinInvalidError,
  shareViewIdentitySelector,
  recordedShareSelector,
} from "../workspaces/shareViewRecords";
import { waitForReceivedShareCaptureReady } from "../workspaces/receivedShareCaptureReady";
import { workspaceSummaryFor } from "../workspaces/workspaceSummaryProjection";
import { joinedByAccount } from "../workspaces/shareWriteGate";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { CreatedWorkspace } from "../workspaces/createWorkspaceFolder";
import type { createJoinedWorkspaceRunner } from "../workspaces/createJoinedWorkspace";
import type { WorkspaceAuthorityBinding } from "../workspaces/workspaceAuthorityOwner";
import type { ShareViewFiles } from "../workspaces/shareViewFiles";
import type {
  RefreshSharedViewOutcome,
  ShareViewPullCommitted,
  StandaloneShareViewRefreshOutcome,
} from "../workspaces/sharedView";
import type { withStaleSensitiveWorkspaceOperation } from "../workspaces/workspaceAssets";
import type { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import type { setWorkspaceShareView } from "../workspaces/WorkspaceRegistry";
import type { WorkspaceActivityScope } from "./workspaceActivityBroadcast";
import type { ShareViewRebuildOutcome } from "../workspaces/shareViewRebuild";

// How long a held pull waits at the relay, under its 30 s limit.
const SHARE_VIEW_HOLD_MS = 25_000;

export function registerSharedViewsIpcHandlers<
  Sender,
  Event extends { sender: Sender },
  Operation extends {
    readonly workspace: RegistryEntry & { readonly attachmentId: symbol };
    readonly signal: AbortSignal;
    assertCurrent(): void;
  },
  Lease,
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender,
    workspaceId: string,
    inactiveMessage: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  loadAndCacheCurrentCredentials(): Promise<CloudCredentials | null>;
  warmCredentialCache(): Promise<void>;
  currentCredentials(): CloudCredentials | null;
  currentCredentialGeneration(): number;
  currentRendererSession(sender: Sender): RendererWorkspaceOperationSession | undefined;
  onSenderClosed(sender: Sender, close: () => void): () => void;
  engineDaemonStartup(): Promise<unknown>;
  fetchShareViewInfo: typeof fetchShareViewInfo;
  fetchShareViewAccess: typeof fetchShareViewAccess;
  fetchShareViewReach: typeof fetchShareViewReach;
  probeShareViewLog: typeof probeShareViewLog;
  usableRoot(path: string): string;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  createJoinedWorkspace: ReturnType<typeof createJoinedWorkspaceRunner>;
  setWorkspaceShareView: typeof setWorkspaceShareView;
  refreshNativeWorkspaceSurfaces(): void;
  workspaceAuthorities: {
    attachmentRetirementSignal(workspaceId: string, attachmentId: symbol): AbortSignal;
    withBinding<Result>(
      binding: WorkspaceAuthorityBinding<RegistryEntry>,
      work: (lease: Lease) => Result | Promise<Result>,
    ): Promise<Result>;
  };
  canonicalWorkspaceFor(lease: Lease): RegistryEntry & { readonly attachmentId: symbol };
  withStaleSensitiveWorkspaceOperation: typeof withStaleSensitiveWorkspaceOperation;
  shareViewFiles: Pick<ShareViewFiles, "reconcile" | "end" | "narrow">;
  receivedShareEngine: Pick<
    ReturnType<typeof createReceivedShareEngineAccess>,
    "relayFor" | "storeFor"
  >;
  openWorkspaceActivity(workspace: CreatedWorkspace): Promise<unknown>;
  requireWorkspace(workspaceId: string): RegistryEntry;
  listWorkspaces(): readonly RegistryEntry[];
  notifyRenderer(scope?: WorkspaceActivityScope): void;
  syncNotices(isCurrent: () => boolean): Promise<void>;
  recordShareViewStoreRefusal(
    workspaceId: string,
    refusal: EngineStoreRefusal | null,
    detail: string | null,
  ): void;
  // Reads the relay's account listing again for an ended view the owner can
  // still restore, so the view resumes. Decides for itself whether the
  // recheck is due; a refresh only says the view is ended.
  recheckRemovedShares?(workspaceId: string): Promise<void>;
  // Whether this attachment has the document open in a live session, which
  // shows each change as it lands.
  showsLive(attachmentId: symbol, path: string): boolean;
  // Rebuild a closed copy under the reach the relay lists now, or join the
  // rebuild already running for it. Main holds the copy's sessions and
  // reports what stopped it in Notices.
  rebuildShareView(workspaceId: string, rebuildId: string): Promise<ShareViewRebuildOutcome>;
  // The rebuild the engine holds a record of for the copy, and its phase, or
  // null when there is none.
  readShareViewRebuild(workspaceId: string): Promise<{ rebuildId: string; phase: string } | null>;
  // Delete a converged rebuild's leftovers: its aside and staging stores and
  // its record.
  finishShareViewRebuild(workspaceId: string, rebuildId: string): Promise<void>;
}): { resumeRebuilds(): Promise<void> } {
  const {
    registerHandler,
    assertTrustedSender,
    withRendererWorkspaceOperation,
    loadAndCacheCurrentCredentials,
    warmCredentialCache,
    currentCredentials,
    engineDaemonStartup,
    fetchShareViewInfo,
    usableRoot,
    readdir,
    mkdir,
    createJoinedWorkspace,
    setWorkspaceShareView,
    refreshNativeWorkspaceSurfaces,
    workspaceAuthorities,
    canonicalWorkspaceFor,
    withStaleSensitiveWorkspaceOperation,
    shareViewFiles,
    receivedShareEngine,
    openWorkspaceActivity,
    requireWorkspace,
    listWorkspaces,
    notifyRenderer,
    recordShareViewStoreRefusal,
    recheckRemovedShares,
  } = dependencies;
  // A shared view has no recorder, so its refresh is what meets a store only
  // a newer dohc opens. That stops the whole workspace, so the refusal goes
  // to the workspace status the stop state reads. Rebuild refusals stay a
  // refresh error: a shared view cannot rebuild its store.
  async function reportingShareStoreRefusal<Result>(
    operation: Operation,
    refresh: () => Promise<Result>,
  ): Promise<Result> {
    const record = (refusal: EngineStoreRefusal | null, detail: string | null) => {
      try {
        operation.assertCurrent();
      } catch {
        return;
      }
      recordShareViewStoreRefusal(operation.workspace.workspaceId, refusal, detail);
    };
    let result: Result;
    try {
      result = await refresh();
    } catch (error) {
      const refusal = engineStoreRefusalOf(error);
      if (refusal !== null && engineStoreRefusalRecovery(refusal) === "update") {
        record(refusal, engineStoreRefusalDetailOf(error));
      }
      throw error;
    }
    record(null, null);
    return result;
  }
  // Give a received share the sync identity used by its Edit proposal lane.
  // Run at open and on refresh so an older received share gains the identity
  // before it submits document changes.
  async function recordShareViewIdentity(
    workspace: RegistryEntry & { attachmentId: symbol },
  ): Promise<void> {
    await warmCredentialCache();
    const credentials = currentCredentials();
    const grantedSelector = shareViewIdentitySelector({
      shareView: workspace.shareView,
      relayUrl: credentials?.relayUrl,
      relayUrlsMatch,
    });
    if (
      !grantedSelector ||
      !credentials?.relayUrl ||
      !workspace.shareView?.recipientUserId ||
      workspace.shareView.recipientUserId !== credentials.userId ||
      workspace.shareView.ended
    )
      return;
    await receivedShareEngine
      .relayFor({
        engineWorkspaceId: workspace.workspaceId,
        rootPath: workspace.rootPath,
        attachmentId: workspace.attachmentId,
        relay: { baseUrl: credentials.relayUrl, token: credentials.token },
      })
      .recordShareViewIdentity({
        grantedSelector,
        reach: storedShareViewReach(workspace.shareView),
      });
  }

  // Read a membership's reach again after a pull applied nothing because the
  // relay selected it under other signatures. Under the same visibility only
  // the levels moved: writers pause while capture keeps what they made, the
  // new levels go in, and the next pull continues. A changed visibility
  // changes nothing here: the next pull is served under it, and the engine
  // closes the copy for a rebuild before that pull answers.
  async function followShareViewReach(
    workspaceId: string,
    rootPath: string,
    relay: SyncRelayConnection,
    assertCurrent: () => void,
  ): Promise<"installed" | "current" | "visibility-changed"> {
    const view = requireWorkspace(workspaceId).shareView;
    if (!view || view.ended || recordedShareSelector(view.grantedSelector)?.wholeWorkspace !== true)
      return "current";
    const listed = await dependencies.fetchShareViewReach({ relay, shareId: view.shareId });
    assertCurrent();
    // A view with no readable reach takes the listed one: it has no
    // visibility of its own to compare.
    const stored = storedShareViewReach(view);
    if (stored && stored.visibilitySignature !== listed.visibilitySignature) {
      return "visibility-changed";
    }
    if (stored?.signature === listed.signature) return "current";
    await withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
      shareViewFiles.narrow(
        lease,
        { kind: "standalone", workspaceId },
        assertCurrent,
        async (unsavedPaths, unconfirmedChanges) => {
          const latest = requireWorkspace(workspaceId).shareView;
          if (!latest || latest.shareId !== view.shareId || latest.ended) return;
          await setWorkspaceShareView(workspaceId, {
            ...latest,
            reach: listed,
            unsavedPaths,
            unconfirmedChanges,
          });
        },
      ),
    );
    refreshNativeWorkspaceSurfaces();
    return "installed";
  }

  // The engine closed a membership's copy because the relay changed which
  // items it sees. Record the rebuild so the view shows "Updating access" and
  // nothing here reads the copy until the new one is swapped in.
  async function closeForRebuild(workspaceId: string, rebuildId: string): Promise<void> {
    const view = requireWorkspace(workspaceId).shareView;
    if (!view || view.rebuild?.rebuildId === rebuildId) return;
    await setWorkspaceShareView(workspaceId, { ...view, rebuild: { rebuildId } });
    notifyRenderer({ workspaceId, summaryChanged: true });
  }

  // The engine closes the copy before it answers with the rebuild's id, so a
  // crash or a failed record can lose the id. Ask the engine before reading
  // the copy, and record the rebuild it names.
  async function recoverRebuild(workspaceId: string): Promise<void> {
    const view = requireWorkspace(workspaceId).shareView;
    if (!view || view.ended || recordedShareSelector(view.grantedSelector)?.wholeWorkspace !== true)
      return;
    const rebuild = await dependencies.readShareViewRebuild(workspaceId);
    if (rebuild === null) return;
    // Only a closed copy can lose its id: the runner needs it to go further.
    // A converged copy whose record no longer names it was installed, and
    // only its finish failed, which leaves the hidden History aside. The
    // runner may have installed it while the status was read, so read the
    // record again.
    if (
      rebuild.phase === "converged" &&
      requireWorkspace(workspaceId).shareView?.rebuild === undefined
    ) {
      await dependencies
        .finishShareViewRebuild(workspaceId, rebuild.rebuildId)
        .catch((error: unknown) => {
          console.error("[desktop] joined copy rebuild finish:", error);
        });
      return;
    }
    await closeForRebuild(workspaceId, rebuild.rebuildId);
  }

  function updatingAccess(workspaceId: string): boolean {
    return requireWorkspace(workspaceId).shareView?.rebuild !== undefined;
  }

  // Rebuild the copy if it is closed. An ended membership takes today's end
  // path. The window learns the outcome either way.
  async function rebuildClosedCopy(workspaceId: string): Promise<ShareViewRebuildOutcome | null> {
    const view = requireWorkspace(workspaceId).shareView;
    if (!view?.rebuild || view.ended) return null;
    try {
      const outcome = await dependencies.rebuildShareView(workspaceId, view.rebuild.rebuildId);
      if (outcome.kind === "ended") {
        const workspace = requireWorkspace(workspaceId);
        await withStaleSensitiveWorkspaceOperation(workspace.rootPath, (lease) =>
          shareViewFiles.end(lease, { kind: "standalone", workspaceId }, () => undefined),
        );
        refreshNativeWorkspaceSurfaces();
      }
      return outcome;
    } finally {
      notifyRenderer({ workspaceId, summaryChanged: true });
    }
  }

  // Start the rebuild without waiting: a refresh holds the copy, and the
  // rebuild closes every session on it first.
  function startRebuild(workspaceId: string): void {
    void rebuildClosedCopy(workspaceId).catch((error: unknown) => {
      console.error("[desktop] joined copy rebuild:", error);
    });
  }

  // Receive side: open a pasted share code as a READ-ONLY shared view.
  // Mirrors the join flow's ordering guarantees: everything is validated
  // before local state exists, the token only ever goes to the signed-in
  // relay, and a failed first pull rolls the whole thing back. A membership
  // keeps what its first pull brought instead, unless it ended.
  async function openSharedView(input: OpenSharedViewPayload) {
    const parsed = parseShareCode(input.shareCode);
    if (!parsed) {
      throw new Error("That doesn't look like a share code. Copy it again and retry.");
    }
    const credentials = requireCredentials(await loadAndCacheCurrentCredentials());
    if (!credentials.relayUrl || !relayUrlsMatch(credentials.relayUrl, parsed.relayUrl)) {
      // Security gate, not cosmetics: the session token is only ever sent to
      // the relay this machine signed in with — never to a URL that arrived
      // inside a pasted code.
      throw new Error(
        "This share lives on a different server than the one you're signed in to. " +
          "Connect to the server that hosts this share, then try again.",
      );
    }
    const openGeneration = dependencies.currentCredentialGeneration();
    const assertOpenIdentity = () => {
      if (openGeneration !== dependencies.currentCredentialGeneration())
        throw new Error("The server session changed.");
    };
    const relay = { baseUrl: credentials.relayUrl, token: credentials.token };
    // Pre-flight against the relay before creating anything locally; also
    // learns who shared it for the honest read-only copy.
    let info: Awaited<ReturnType<typeof fetchShareViewInfo>>;
    // A membership's levels, which its first pull already gates by.
    let reach: ListedReach | null = null;
    try {
      info = await fetchShareViewInfo({ relay, shareId: parsed.shareId });
      if (info.selector?.wholeWorkspace === true) {
        reach = await dependencies.fetchShareViewReach({ relay, shareId: parsed.shareId });
      }
    } catch (error) {
      if (error instanceof ShareUnavailableError) {
        throw new Error(
          "No share matches that code for your account. Check the code and that you're signed in with the account it was shared with.",
        );
      }
      if (error instanceof RelayUnauthorizedError) {
        throw new Error("Your server session expired. Sign in again, then retry.");
      }
      if (error instanceof ShareSelectorInvalidError) {
        throw new Error(
          "This share can't be opened: the server didn't say what it shares. Try again later.",
        );
      }
      // fetch rejects with a TypeError when no answer arrives.
      if (error instanceof TypeError) {
        throw new Error("dohc could not reach the server. Check your connection.");
      }
      throw error;
    }
    // A chat code has no file selector, so there is no scope to
    // enforce and nothing to project. Refuse it here rather than record a
    // grant of "everything" (the mount path says the same through
    // assertMountableSelector).
    assertOpenIdentity();
    if (info.selector === null) {
      throw new Error("This code is for a shared group. Join it from Chats instead of opening it.");
    }
    const grantedSelector = info.selector;
    const rootPath = usableRoot(input.rootPath);
    // A membership's first pull can be long. One that failed kept what arrived
    // in this folder, and opening the same folder again continues it.
    const membership = grantedSelector.wholeWorkspace === true;
    const membershipName = info.subjectName ?? "the workspace";
    const unfinished = (error: unknown) =>
      error instanceof AccessUpdatingError
        ? new Error(
            `dohc could not finish reading ${membershipName} while its access is being updated. What arrived stays in ${rootPath}.`,
          )
        : new Error(
            `dohc could not finish reading ${membershipName}: ${causeOf(error)}. What arrived stays in ${rootPath}. Try again continues from there.`,
          );
    const kept = membership
      ? listWorkspaces().find(
          (entry) =>
            normalizeRootPath(entry.rootPath, process.platform) ===
              normalizeRootPath(rootPath, process.platform) &&
            entry.shareView?.shareId === parsed.shareId &&
            entry.shareView.recipientUserId === credentials.userId &&
            entry.shareView.ended !== true &&
            (entry.shareView.grantedSelector as { wholeWorkspace?: unknown } | undefined)
              ?.wholeWorkspace === true,
        )
      : undefined;
    if (kept) {
      await engineDaemonStartup();
      // A copy closed for its access is rebuilt first, and the pull continues
      // from the rebuilt copy.
      await recoverRebuild(kept.workspaceId);
      const rebuilt = await rebuildClosedCopy(kept.workspaceId);
      if (rebuilt?.kind === "ended")
        throw new Error(
          `Your membership of ${membershipName} ended. What arrived stays in ${rootPath}.`,
        );
      if (rebuilt && rebuilt.kind !== "rebuilt") throw unfinished(new AccessUpdatingError());
      try {
        await firstPull(kept.rootPath, kept.workspaceId, relay);
      } catch (error) {
        if (error instanceof ShareUnavailableError)
          throw new Error(
            `Your membership of ${membershipName} ended. What arrived stays in ${rootPath}.`,
          );
        if (!(error instanceof AccessUpdatingError)) throw unfinished(error);
        // The window shows Updating access until the rebuild finishes.
        startRebuild(kept.workspaceId);
      } finally {
        notifyRenderer();
      }
      return { workspace: workspaceSummaryFor(requireWorkspace(kept.workspaceId)) };
    }
    const existingEntries = await readdir(rootPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (existingEntries.length > 0) {
      throw new Error("Choose an empty folder — the shared files will be placed inside it.");
    }
    // Opening reaches the engine's sessions, and it can start before the
    // daemon handshake now that the window loads during it.
    await engineDaemonStartup();
    // Identity/metadata only (the join bootstrap): the shared content
    // arrives with the first pull below, and a shared view must never seed
    // starter files of its own.
    await mkdir(rootPath, { recursive: true });
    let pullFailure = null as { error: unknown } | null;
    const created = await createJoinedWorkspace({
      workspaceId: randomUUID(),
      rootPath,
      populate: async (created, authorityBinding) => {
        assertOpenIdentity();
        await setWorkspaceShareView(created.workspaceId, {
          shareId: parsed.shareId,
          ...(info.granterUserId ? { granterUserId: info.granterUserId } : {}),
          granterEmail: info.granterEmail,
          subjectName: info.subjectName,
          sharerName: info.sharerName,
          genericChatWritable: info.genericChatWritable,
          // Pin the selector the relay just stated, so later pulls enforce it
          // instead of trusting the relay's selection each time.
          grantedSelector,
          ...(reach ? { reach } : {}),
          receivedIdentity: info.receivedIdentity,
          ...membershipPlace(info),
          // Persist the origin relay so a later refresh signed into a different
          // relay is skipped instead of misreading a 404 as "share ended".
          relayUrl: credentials.relayUrl,
          recipientUserId: credentials.userId,
        });
        refreshNativeWorkspaceSurfaces();
        // Before the first pull: a share view that writes back needs its own
        // sync identity, and the pull is what gives it the share cursor that
        // makes local writes journal.
        //
        // Soft, like the refresh site. Opening a share is a read, and a failure
        // here costs the recipient the ability to send changes, not the ability
        // to open what they were given. The first window refresh retries it.
        await workspaceAuthorities
          .withBinding(authorityBinding, (lease) =>
            recordShareViewIdentity(canonicalWorkspaceFor(lease)),
          )
          .catch((error) => {
            console.error("[desktop] share view identity:", error);
          });
        try {
          await firstPull(created.rootPath, created.workspaceId, relay);
        } catch (error) {
          // A membership keeps what arrived, unless it ended.
          if (!membership || error instanceof ShareUnavailableError) throw error;
          pullFailure = { error };
        }
      },
      rollbackLabel: "open-share",
      cleanupFailureMessage: `dohc could not close the failed share download. Files stay in ${rootPath}. Restart dohc. If this folder appears in the workspace list, choose Remove from list on its row in Manage workspaces before opening the share again. Its folder stays. Then choose another empty folder.`,
      failure: (error) => {
        if (error instanceof ShareUnavailableError) {
          return new Error(
            `This share ended before it could be opened. Files stay in ${rootPath}. Ask the owner to share again, then choose another empty folder.`,
          );
        }
        return new Error(
          `dohc could not open the share. Files stay in ${rootPath}. Check your connection, then choose another empty folder.`,
        );
      },
    });
    // A share view is opened here, not wherever a status read happens to land
    // first. It needs the activity entry: that entry is what states
    // `historyShareView` to the status bar and the notice center, so the null
    // capture below is explained by a decision this open made.
    //
    // It deliberately gets NO recorder and no cloud engine. Its files are
    // written straight to its engine store by the write path, so a watcher
    // here would only observe writes this process already journaled, and it
    // replicates through its share rather than through a workspace remote.
    //
    // After the refresh, because a failed refresh rolls the whole open back.
    await openWorkspaceActivity(requireWorkspace(created.workspaceId));
    // Scope-free: the open added a registry entry no window has active yet.
    notifyRenderer();
    // Through the PROJECTION, not a raw parse: the level lives under the
    // record's pinned grant, and a raw parse would strip it and hand the
    // renderer a fresh share view with no level to state.
    if (pullFailure && !(pullFailure.error instanceof AccessUpdatingError))
      throw unfinished(pullFailure.error);
    // The engine closed the copy during its first pull. The window shows
    // Updating access until the rebuild finishes.
    if (pullFailure) startRebuild(created.workspaceId);
    const summary = workspaceSummaryFor(requireWorkspace(created.workspaceId));
    return { workspace: summary };
  }

  async function firstPull(
    rootPath: string,
    workspaceId: string,
    relay: SyncRelayConnection,
  ): Promise<void> {
    // A membership kept from before levels were listed reads them first.
    if (lacksReach(workspaceId))
      await followShareViewReach(workspaceId, rootPath, relay, () => undefined);
    for (let attempt = 0; ; attempt += 1) {
      const reconciled = await withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        shareViewFiles.reconcile(lease, { kind: "standalone", workspaceId }, "refresh"),
      );
      if (reconciled.kind !== "refresh") {
        throw new Error("Shared view refresh returned an invalid result.");
      }
      const outcome = reconciled.outcome;
      if ("ok" in outcome && !outcome.ok) {
        throw new Error(outcome.errorMessage);
      }
      if (outcome.status === "ended") {
        throw new ShareUnavailableError();
      }
      if (!outcome.reachChanged) return;
      if (outcome.rebuildId !== undefined) {
        await closeForRebuild(workspaceId, outcome.rebuildId);
        throw new AccessUpdatingError();
      }
      if (
        attempt > 0 ||
        (await followShareViewReach(workspaceId, rootPath, relay, () => undefined)) !== "installed"
      ) {
        throw new Error("the workspace's access changed while it was being read");
      }
    }
  }

  function lacksReach(workspaceId: string): boolean {
    const view = requireWorkspace(workspaceId).shareView;
    return (
      !!view &&
      !view.ended &&
      recordedShareSelector(view.grantedSelector)?.wholeWorkspace === true &&
      storedShareViewReach(view) === null
    );
  }

  const pullCache = new Map<
    Sender,
    {
      workspaceId: string;
      attachmentId: symbol;
      shareId: string;
      recipientUserId: string;
      relayUrl: string;
      nextCursor?: number;
      credentialGeneration: number;
      // A membership's level as this computer knows it, which its held pull
      // names. Cleared once the relay says it differs, until a check moves it.
      level?: ShareViewSelector["access"];
      reach?: ShareReachSignatures;
    }
  >();
  // The relay a membership reads its reach from: the signed-in one, when it
  // is the view's own and its account is the recipient.
  function membershipRelay(view: RegistryEntry["shareView"]): SyncRelayConnection | null {
    const credentials = currentCredentials();
    if (
      !view ||
      recordedShareSelector(view.grantedSelector)?.wholeWorkspace !== true ||
      !credentials?.relayUrl ||
      view.recipientUserId !== credentials.userId ||
      (view.relayUrl && !relayUrlsMatch(credentials.relayUrl, view.relayUrl))
    )
      return null;
    return { baseUrl: credentials.relayUrl, token: credentials.token };
  }
  const cacheClosers = new Map<Sender, () => void>();
  const clearCache = (sender: Sender) => {
    pullCache.delete(sender);
    cacheClosers.get(sender)?.();
    cacheClosers.delete(sender);
  };
  function syncSharedViewNotices(
    session: NonNullable<ReturnType<typeof dependencies.currentRendererSession>>,
    retirement: AbortSignal,
    credentialGeneration: number,
    share: { recipientUserId?: string; relayUrl?: string } | undefined,
  ) {
    const isCurrent = () =>
      session.isCurrent() &&
      !retirement.aborted &&
      dependencies.currentCredentialGeneration() === credentialGeneration &&
      joinedByAccount(share, currentCredentials());
    if (!isCurrent()) return;
    void dependencies.syncNotices(isCurrent);
  }

  async function refreshSharedView(
    event: Event,
    input: RefreshSharedViewPayload,
    pressBurst: boolean,
    held: boolean,
  ): Promise<RefreshSharedViewResult> {
    const heldResult = held ? { held: true as const } : {};
    const session = dependencies.currentRendererSession(event.sender);
    const retirement =
      session &&
      workspaceAuthorities.attachmentRetirementSignal(session.workspaceId, session.attachmentId);
    const assertSession = () => {
      if (
        !session?.isCurrent() ||
        retirement?.aborted ||
        session.workspaceId !== input.workspaceId
      ) {
        throw new Error("Shared view refresh stopped because this window changed workspaces.");
      }
    };
    assertSession();
    await warmCredentialCache();
    assertSession();
    const credentialGeneration = dependencies.currentCredentialGeneration();
    const entry = pullCache.get(event.sender);
    let cached =
      entry?.workspaceId === input.workspaceId && entry.attachmentId === session!.attachmentId
        ? entry
        : undefined;
    if (input.trigger === "background") {
      if (
        cached &&
        cached.nextCursor === undefined &&
        cached.credentialGeneration !== dependencies.currentCredentialGeneration()
      ) {
        clearCache(event.sender);
        cached = undefined;
      }
      const view = cached ? undefined : requireWorkspace(input.workspaceId).shareView;
      if (
        view &&
        (!shareViewIdentityIsIntact(view) || !recordedShareSelector(view.grantedSelector))
      ) {
        return {
          ok: true,
          status: "unchanged",
          probed: true,
          changedPaths: 0,
          excludedPaths: [],
          unjournalablePaths: [],
          refusedOps: 0,
          refusedDetail: null,
        };
      }
      const share = cached ?? view;
      const credentials = currentCredentials();
      if (
        !share?.relayUrl ||
        !credentials?.relayUrl ||
        credentials.userId !== share.recipientUserId ||
        !relayUrlsMatch(credentials.relayUrl, share.relayUrl)
      ) {
        return {
          ok: false,
          probed: true,
          changedPaths: 0,
          errorKind: "unauthorized",
          errorMessage: "Sign in to the account that received this share.",
        };
      }
      if (cached && cached.nextCursor === undefined) {
        if (pressBurst) syncSharedViewNotices(session!, retirement!, credentialGeneration, cached);
        return {
          ok: true,
          status: "unchanged",
          probed: true,
          changedPaths: 0,
          excludedPaths: [],
          unjournalablePaths: [],
          refusedOps: 0,
          refusedDetail: null,
        };
      }
      if (cached?.nextCursor !== undefined) {
        const scoped = credentialScopedOperation({
          assertCurrent: assertSession,
          capturedGeneration: credentialGeneration,
          currentGeneration: dependencies.currentCredentialGeneration,
        });
        const controller = new AbortController();
        let closed = false;
        const stopClose = dependencies.onSenderClosed(event.sender, () => {
          closed = true;
          controller.abort();
        });
        const timeout = setTimeout(
          () => controller.abort(),
          held ? SHARE_VIEW_HOLD_MS + 10_000 : 10_000,
        );
        try {
          const probe = await dependencies.probeShareViewLog({
            relay: { baseUrl: credentials.relayUrl, token: credentials.token },
            shareId: cached.shareId,
            since: cached.nextCursor,
            signal: AbortSignal.any([controller.signal, retirement!]),
            ...(held
              ? { hold: SHARE_VIEW_HOLD_MS, ...(cached.level ? { level: cached.level } : {}) }
              : {}),
            ...(cached.reach ? { reach: cached.reach } : {}),
          });
          if (probe.levelChanged) delete cached.level;
          controller.signal.throwIfAborted();
          scoped.assertCurrent();
          if (probe.unchanged || probe.levelChanged) {
            if (pressBurst)
              syncSharedViewNotices(session!, retirement!, credentialGeneration, cached);
            return {
              ok: true,
              status: "unchanged",
              probed: true,
              ...heldResult,
              ...(probe.levelChanged ? { levelChanged: true } : {}),
              changedPaths: 0,
              excludedPaths: [],
              unjournalablePaths: [],
              refusedOps: 0,
              refusedDetail: null,
            };
          }
        } catch (error) {
          if (closed) controller.signal.throwIfAborted();
          scoped.assertCurrent();
          if (controller.signal.aborted)
            return {
              ok: false,
              probed: true,
              changedPaths: 0,
              errorKind: "transient",
              errorMessage: "The shared view refresh timed out.",
            };
          // A revoked share needs the existing full path to preserve local work
          // and publish its ended state. Transient probes never touch the store.
          if (!(error instanceof ShareUnavailableError)) {
            return {
              ok: false,
              probed: true,
              changedPaths: 0,
              errorKind: error instanceof RelayUnauthorizedError ? "unauthorized" : "transient",
              errorMessage: error instanceof Error ? error.message : String(error),
            };
          }
        } finally {
          clearTimeout(timeout);
          stopClose();
        }
      }
    } else {
      // Signed in as another account, a refresh asks the relay nothing and
      // says why. Signed out, the local refresh still runs.
      const view = requireWorkspace(input.workspaceId).shareView;
      const credentials = currentCredentials();
      if (
        view &&
        !view.ended &&
        credentials &&
        shareViewIdentityIsIntact(view) &&
        !joinedByAccount(view, credentials)
      ) {
        return {
          ok: false,
          probed: true,
          changedPaths: 0,
          errorKind: "unauthorized",
          errorMessage: "Sign in to the account that received this share.",
        };
      }
    }
    clearCache(event.sender);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Shared view refresh stopped because this window changed workspaces.",
      (operation) =>
        reportingShareStoreRefusal(operation, async () => {
          const summaryBefore = JSON.stringify(workspaceSummaryFor(operation.workspace));
          const summaryChanged = () =>
            summaryBefore !==
            JSON.stringify(workspaceSummaryFor(requireWorkspace(input.workspaceId)));
          const notifyPull = (changed: boolean) =>
            notifyRenderer({
              workspaceId: input.workspaceId,
              ...(changed ? { summaryChanged: true } : {}),
            });
          const noticeShare = operation.workspace.shareView;
          const syncPullNotices = () =>
            syncSharedViewNotices(session!, retirement!, credentialGeneration, noticeShare);
          // The shell's on-open auto-refresh can run during the daemon handshake
          // now that the window loads during it; the reconcile needs sessions. The
          // physical operation is already held before this wait begins.
          await engineDaemonStartup();
          operation.assertCurrent();
          const currentShareViewWorkspace = () => {
            operation.assertCurrent();
            const current = operation.workspace;
            const shareView = current.shareView;
            if (!shareViewIsPresent(shareView)) {
              throw new Error("This workspace is not a shared view.");
            }
            if (!shareView) {
              throw new Error(
                "This shared view's record is damaged, so it can't refresh safely. Remove it, then open the share code again.",
              );
            }
            return { ...current, shareView };
          };
          let workspace = currentShareViewWorkspace();
          if (!shareViewIdentityIsIntact(workspace.shareView)) {
            throw new Error(SHARE_VIEW_REOPEN_MESSAGE);
          }
          // A closed copy answers only its rebuild, which this starts again
          // after a restart or a Try again.
          await recoverRebuild(workspace.workspaceId);
          if (requireWorkspace(workspace.workspaceId).shareView?.rebuild) {
            startRebuild(workspace.workspaceId);
            throw new Error(UPDATING_ACCESS_MESSAGE);
          }
          // A proven large fresh import can publish its workspace handle before
          // initial capture finishes. Every share.* RPC stays fenced until the
          // phase reaches ready or degraded, including the Edit identity call
          // below. Wait before relay work and before taking the workspace file
          // scheduler so the shell remains usable and a workspace switch stops
          // the background refresh promptly.
          const shareStore = receivedShareEngine.storeFor({
            engineWorkspaceId: workspace.workspaceId,
            rootPath: workspace.rootPath,
            attachmentId: workspace.attachmentId,
          });
          await waitForReceivedShareCaptureReady({
            readStatus: shareStore.watcherStatus?.bind(shareStore),
            assertCurrent: () => operation.assertCurrent(),
          });
          workspace = currentShareViewWorkspace();
          // An ended view the owner has since put back resumes: the reconcile
          // below reads the registry, which the recheck may have changed.
          if (workspace.shareView.ended && recheckRemovedShares) {
            await recheckRemovedShares(workspace.workspaceId);
            operation.assertCurrent();
            workspace = currentShareViewWorkspace();
          }
          // Refresh the relay-derived chat fact for the banner's next step. It
          // does not grant desktop generic-chat writes. Keep the share identity
          // current for the separate Edit proposal lane.
          if (!workspace.shareView.ended && (input.trigger !== "background" || !cached)) {
            let refreshedWorkspace = workspace;
            await warmCredentialCache().catch(() => undefined);
            const credentials = currentCredentials();
            if (
              credentials?.relayUrl &&
              workspace.shareView.recipientUserId === credentials.userId &&
              (!workspace.shareView.relayUrl ||
                relayUrlsMatch(credentials.relayUrl, workspace.shareView.relayUrl))
            ) {
              try {
                const info = await fetchShareViewInfo({
                  relay: {
                    baseUrl: credentials.relayUrl,
                    token: credentials.token,
                  },
                  shareId: workspace.shareView.shareId,
                });
                operation.assertCurrent();
                if (credentialGeneration !== dependencies.currentCredentialGeneration())
                  throw new Error("The server session changed.");
                const current = currentShareViewWorkspace();
                if (current.shareView.shareId !== workspace.shareView.shareId)
                  throw new Error("Shared view changed during refresh.");
                const nextShareView = {
                  ...current.shareView,
                  ...(info.granterUserId ? { granterUserId: info.granterUserId } : {}),
                  receivedIdentity: refreshReceivedReferencePin(
                    current.shareView.receivedIdentity,
                    info,
                  ),
                  genericChatWritable: info.genericChatWritable,
                  // Forget clears the email, so a reopened share takes the server's. A share that has one keeps it.
                  granterEmail: current.shareView.granterEmail ?? info.granterEmail,
                  subjectName: info.subjectName,
                  sharerName: info.sharerName,
                  ...(recordedShareSelector(current.shareView.grantedSelector)?.wholeWorkspace ===
                  true
                    ? membershipPlace(info)
                    : {}),
                };
                await setWorkspaceShareView(workspace.workspaceId, nextShareView);
                refreshedWorkspace = { ...current, shareView: nextShareView };
              } catch (error) {
                if (!(error instanceof ShareUnavailableError)) {
                  throw error;
                }
                refreshedWorkspace = currentShareViewWorkspace();
              }
            }
            await recordShareViewIdentity(refreshedWorkspace).catch((error) => {
              console.error("[desktop] share view enrolment:", error);
            });
          }
          let outcome: StandaloneShareViewRefreshOutcome | RefreshSharedViewOutcome;
          let nextCursor: number | undefined;
          let pulled: ShareViewPullCommitted["changes"] = [];
          // The reach signatures this view now settles on, which a held probe
          // compares with each empty page. After a visibility change they are
          // the served ones, so the probe stops counting the same change as news.
          let settledReach: ShareReachSignatures | undefined;
          try {
            const reconcile = async () => {
              const reconciled = await withStaleSensitiveWorkspaceOperation(
                workspace.rootPath,
                (lease) =>
                  shareViewFiles.reconcile(
                    lease,
                    { kind: "standalone", workspaceId: workspace.workspaceId },
                    "refresh",
                    (committed) => {
                      nextCursor = committed.cursor;
                      pulled = committed.changes;
                    },
                  ),
              );
              if (reconciled.kind !== "refresh") {
                throw new Error("Shared view refresh returned an invalid result.");
              }
              return reconciled.outcome;
            };
            const reachRelay = membershipRelay(workspace.shareView);
            // Installed levels can list Edit where the member had none, so the
            // copy enrolls for sending before anything is written under them.
            const enrollInstalled = () =>
              recordShareViewIdentity(currentShareViewWorkspace()).catch((error) => {
                console.error("[desktop] share view enrolment:", error);
              });
            if (
              reachRelay &&
              lacksReach(workspace.workspaceId) &&
              (await followShareViewReach(
                workspace.workspaceId,
                workspace.rootPath,
                reachRelay,
                () => operation.assertCurrent(),
              )) === "installed"
            ) {
              await enrollInstalled();
            }
            // A pull the engine closed the copy on records the rebuild and starts it.
            const closedForRebuild = async (pulled: typeof outcome) => {
              if (("ok" in pulled && !pulled.ok) || pulled.rebuildId === undefined) return false;
              await closeForRebuild(workspace.workspaceId, pulled.rebuildId);
              startRebuild(workspace.workspaceId);
              return true;
            };
            outcome = await reconcile();
            if (
              !(await closedForRebuild(outcome)) &&
              !("ok" in outcome && !outcome.ok) &&
              outcome.reachChanged &&
              reachRelay
            ) {
              const followed = await followShareViewReach(
                workspace.workspaceId,
                workspace.rootPath,
                reachRelay,
                () => operation.assertCurrent(),
              );
              // Pull again under the installed levels. A second change waits for
              // the next refresh, unless the engine closes the copy for it.
              if (followed === "installed") {
                await enrollInstalled();
                outcome = await reconcile();
                await closedForRebuild(outcome);
              } else if (followed === "visibility-changed") settledReach = outcome.reachChanged;
            }
            if (settledReach === undefined) {
              const stored = storedShareViewReach(
                requireWorkspace(workspace.workspaceId).shareView,
              );
              if (stored)
                settledReach = {
                  signature: stored.signature,
                  visibilitySignature: stored.visibilitySignature,
                };
            }
          } catch (error) {
            operation.assertCurrent();
            // A pull that failed on a later page still persisted the refusals its
            // earlier pages recorded, so the renderer is told once here too.
            notifyPull(summaryChanged());
            // A damaged pin does not heal on the next try, and re-asking the relay
            // for one would let it restate a wider scope. Say so instead of
            // reporting "refreshed, nothing new" forever.
            if (error instanceof SharePinInvalidError) {
              throw new Error(
                "This shared view's record is damaged, so it can't refresh safely. " +
                  "Remove it, then open the share code again.",
              );
            }
            throw error;
          }
          operation.assertCurrent();
          const changedSummary = summaryChanged();
          if ("ok" in outcome && !outcome.ok) {
            if (pressBurst || outcome.changedPaths > 0 || changedSummary) syncPullNotices();
            notifyPull(changedSummary);
            return RefreshSharedViewResult.parse(outcome);
          }
          if (
            outcome.status !== "ended" &&
            !updatingAccess(input.workspaceId) &&
            workspace.shareView.recipientUserId &&
            workspace.shareView.relayUrl
          ) {
            pullCache.set(event.sender, {
              workspaceId: input.workspaceId,
              attachmentId: session!.attachmentId,
              shareId: workspace.shareView.shareId,
              recipientUserId: workspace.shareView.recipientUserId,
              relayUrl: workspace.shareView.relayUrl,
              nextCursor,
              credentialGeneration,
              ...membershipLevel(workspace.shareView.grantedSelector),
              ...(settledReach ? { reach: settledReach } : {}),
            });
            const clear = () => clearCache(event.sender);
            const stopClose = dependencies.onSenderClosed(event.sender, clear);
            retirement!.addEventListener("abort", clear, { once: true });
            cacheClosers.set(event.sender, () => {
              stopClose();
              retirement!.removeEventListener("abort", clear);
            });
          } else clearCache(event.sender);
          if (outcome.status === "ended") refreshNativeWorkspaceSurfaces();
          // Every change came from the pull and wrote a document open in a live
          // session, which already shows it. Reopening that session would drop
          // what the person types while it reconnects.
          const shownLive =
            outcome.changedPaths > 0 &&
            pulled.length === outcome.changedPaths &&
            pulled.every(
              (change) =>
                change.operation === "write" &&
                dependencies.showsLive(workspace.attachmentId, change.path),
            );
          if (
            pressBurst ||
            outcome.changedPaths > 0 ||
            outcome.refusedOps > 0 ||
            changedSummary ||
            (nextCursor !== undefined &&
              cached?.nextCursor !== undefined &&
              nextCursor !== cached.nextCursor)
          ) {
            syncPullNotices();
          }
          notifyPull(changedSummary);
          return RefreshSharedViewResult.parse(
            outcome.status === "ended"
              ? outcome
              : { ...outcome, ...heldResult, ...(shownLive ? { shownLive: true } : {}) },
          );
        }),
    );
  }

  const checks = new Set<Sender>();
  registerOperations<typeof sharedViewAccessOperations, Event, Operation>(
    {
      handle: registerHandler,
      assertTrustedSender,
      withActiveWorkspace: (event, workspaceId, inactiveMessage, work) =>
        withRendererWorkspaceOperation(event.sender, workspaceId, inactiveMessage, work),
    },
    sharedViewAccessOperations,
    {
      openSharedView,
      refreshSharedView: async (input, { event }) => {
        const pressBurst = input.trigger === "press-burst";
        const held = input.trigger === "held";
        if (pressBurst || held) input = { ...input, trigger: "background" };
        try {
          return await refreshSharedView(event, input, pressBurst, held);
        } catch (error) {
          if (input.trigger !== "background" || !(error instanceof RelayUnauthorizedError))
            throw error;
          return {
            ok: false,
            changedPaths: 0,
            errorKind: "unauthorized",
            errorMessage: error.message,
          };
        }
      },
      // The copy is closed, so no session names this window: the handler
      // starts only the rebuild the membership's record names.
      retryShareViewRebuild: async (input) => {
        const view = requireWorkspace(input.workspaceId).shareView;
        if (!view || view.ended || !shareViewIdentityIsIntact(view)) return;
        // The panel shows during startup too, and the engine reads the rebuild.
        await engineDaemonStartup();
        await recoverRebuild(input.workspaceId);
        startRebuild(input.workspaceId);
      },
      dismissShareCaptureNotice: async (input, { operation }) => {
        operation.assertCurrent();
        const view = operation.workspace.shareView;
        if (!view || view.shareId !== input.shareId) return;
        const state = shareCaptureNoticeState(
          view.unsavedPaths,
          view.unconfirmedChanges,
          view.ended === true,
        );
        // A dismissal of an older restriction must not hide a newer Notice.
        if (state.key !== input.key) return;
        await setWorkspaceShareView(input.workspaceId, {
          ...view,
          unconfirmedChanges: {
            paths: state.filePaths,
            unchecked: state.unchecked,
            checked: state.checked,
            dismissedKey: state.key,
          },
        });
        notifyRenderer({ workspaceId: input.workspaceId, summaryChanged: true });
      },
      dismissAccessSavedNotice: async (input, { operation }) => {
        operation.assertCurrent();
        const view = operation.workspace.shareView;
        // A dismissal of an older recovery folder must not hide a newer Notice.
        if (!view || view.accessSaved?.folder !== input.folder) return;
        const { accessSaved: _dismissed, ...rest } = view;
        await setWorkspaceShareView(input.workspaceId, rest);
        notifyRenderer({ workspaceId: input.workspaceId, summaryChanged: true });
      },
      checkSharedViewAccess: async (input, { event }): Promise<CheckSharedViewAccessResult> => {
        if (checks.has(event.sender)) return { status: "unverified" };
        const controller = new AbortController();
        checks.add(event.sender);
        const timeout = setTimeout(() => controller.abort(), 4_000);
        const unsubscribe = dependencies.onSenderClosed(event.sender, () => controller.abort());
        try {
          return await withRendererWorkspaceOperation(
            event.sender,
            input.workspaceId,
            "Share access check stopped because this window changed workspaces.",
            async (operation) => {
              await warmCredentialCache();
              const scoped = credentialScopedOperation({
                capturedGeneration: dependencies.currentCredentialGeneration(),
                currentGeneration: dependencies.currentCredentialGeneration,
                assertCurrent: () => {
                  operation.assertCurrent();
                  controller.signal.throwIfAborted();
                },
              });
              scoped.assertCurrent();
              const workspace = operation.workspace;
              const view = workspace.shareView;
              const pin = recordedShareSelector(view?.grantedSelector);
              const credentials = currentCredentials();
              if (!view || !pin) return { status: "unverified" };
              if (!shareViewIdentityIsIntact(view)) return { status: "needs-reopen" };
              if (view.ended) return { status: "ended" };
              // A closed copy is not narrowed: its rebuild reads the new levels.
              if (view.rebuild) return { status: "unverified" };
              if (!joinedByAccount(view, credentials)) return { status: "unverified" };
              let stated;
              try {
                stated = await dependencies.fetchShareViewAccess({
                  relay: { baseUrl: credentials.relayUrl, token: credentials.token },
                  shareId: view.shareId,
                  signal: AbortSignal.any([controller.signal, operation.signal]),
                });
              } catch (error) {
                scoped.assertCurrent();
                if (!(error instanceof ShareUnavailableError)) return { status: "unverified" };
                clearTimeout(timeout);
                try {
                  await withStaleSensitiveWorkspaceOperation(workspace.rootPath, (lease) =>
                    shareViewFiles.end(
                      lease,
                      { kind: "standalone", workspaceId: workspace.workspaceId },
                      scoped.assertCurrent,
                    ),
                  );
                } finally {
                  const committed = requireWorkspace(workspace.workspaceId).shareView;
                  if (committed?.shareId === view.shareId && committed.ended) {
                    refreshNativeWorkspaceSurfaces();
                    notifyRenderer({ workspaceId: workspace.workspaceId, summaryChanged: true });
                  }
                }
                scoped.assertCurrent();
                return { status: "ended" };
              }
              scoped.assertCurrent();
              const statedAccess = stated.access;
              // Main's write gate reads a membership's levels from its stored
              // reach, so the relay's reach goes in with a new level. It is read
              // under the same deadline, before the record it is compared with.
              let listed: ListedReach | null = null;
              if (pin.wholeWorkspace === true && statedAccess !== pin.access) {
                listed = await dependencies.fetchShareViewReach({
                  relay: { baseUrl: credentials.relayUrl, token: credentials.token },
                  shareId: view.shareId,
                  signal: AbortSignal.any([controller.signal, operation.signal]),
                });
                scoped.assertCurrent();
              }
              clearTimeout(timeout);
              // The listed reach goes in only under the visibility the copy
              // already has. A changed one is the rebuild's to install.
              const reachFor = (current: unknown) => {
                const stored = storedShareViewReach(current);
                return listed &&
                  (!stored || stored.visibilitySignature === listed.visibilitySignature)
                  ? { reach: listed }
                  : null;
              };
              // Preserve the file/version pin. A metadata read can narrow access,
              // but cannot expand the scope this local copy was admitted with.
              // A membership's level is the owner's member level now, so it also
              // rises; its whole-workspace scope stays as pinned.
              const currentView = operation.workspace.shareView;
              const currentPin = recordedShareSelector(currentView?.grantedSelector);
              if (!currentView || currentView.shareId !== view.shareId || !currentPin)
                return { status: "unverified" };
              if (currentView.ended) return { status: "ended" };
              // A pull beside this check may have closed the copy meanwhile.
              if (currentView.rebuild) return { status: "unverified" };
              const moves =
                currentPin.wholeWorkspace === true && statedAccess !== currentPin.access;
              // Another window moved the level after this one read it.
              if (moves && !listed) return { status: "unverified" };
              const ranks = { view: 0, comment: 1, edit: 2 };
              if (moves && ranks[statedAccess] > ranks[currentPin.access]) {
                // Under a new visibility the gate keeps the old levels until the
                // rebuild, so the raise waits for it and a later check makes it.
                const reach = reachFor(currentView);
                if (!reach) return { status: "unverified" };
                await setWorkspaceShareView(workspace.workspaceId, {
                  ...currentView,
                  grantedSelector: { ...currentPin, access: statedAccess },
                  ...reach,
                });
                refreshNativeWorkspaceSurfaces();
                notifyRenderer({ workspaceId: workspace.workspaceId, summaryChanged: true });
              }
              const access =
                ranks[statedAccess] < ranks[currentPin.access] ? statedAccess : currentPin.access;
              if (access !== currentPin.access) {
                await withStaleSensitiveWorkspaceOperation(workspace.rootPath, (lease) =>
                  shareViewFiles.narrow(
                    lease,
                    { kind: "standalone", workspaceId: workspace.workspaceId },
                    scoped.assertCurrent,
                    async (unsavedPaths, unconfirmedChanges) => {
                      const latest = operation.workspace.shareView;
                      const latestPin = recordedShareSelector(latest?.grantedSelector);
                      if (
                        !latest ||
                        latest.shareId !== view.shareId ||
                        !latestPin ||
                        latest.ended ||
                        latest.rebuild
                      )
                        return;
                      const narrowed =
                        ranks[access] < ranks[latestPin.access] ? access : latestPin.access;
                      await setWorkspaceShareView(workspace.workspaceId, {
                        ...latest,
                        grantedSelector: { ...latestPin, access: narrowed },
                        ...reachFor(latest),
                        unsavedPaths,
                        unconfirmedChanges,
                      });
                    },
                  ),
                );
                refreshNativeWorkspaceSurfaces();
                notifyRenderer({ workspaceId: workspace.workspaceId, summaryChanged: true });
              }
              scoped.assertCurrent();
              const committed = operation.workspace.shareView;
              if (committed?.ended) return { status: "ended" };
              const committedPin = recordedShareSelector(committed?.grantedSelector);
              if (committed?.shareId !== view.shareId || !committedPin || committed.rebuild)
                return { status: "unverified" };
              // Only a membership has a role, and a level that the owner changes
              // for everyone; the window says so when this check moved it. The
              // view keeps the role for main's menus and the window's next start.
              if (
                committedPin.wholeWorkspace === true &&
                stated.role &&
                committed.role !== stated.role
              ) {
                await setWorkspaceShareView(workspace.workspaceId, {
                  ...committed,
                  role: stated.role,
                });
                notifyRenderer({ workspaceId: workspace.workspaceId, summaryChanged: true });
              }
              const pulling = pullCache.get(event.sender);
              if (
                pulling?.workspaceId === workspace.workspaceId &&
                pulling.shareId === view.shareId
              ) {
                Object.assign(pulling, membershipLevel(committedPin));
              }
              return committedPin.wholeWorkspace === true
                ? {
                    status: "current",
                    access: committedPin.access,
                    ...(stated.role ? { role: stated.role } : {}),
                    ...(committedPin.access !== pin.access
                      ? {
                          levelChanged: true,
                          ...(stated.levelChangedBy
                            ? { levelChangedBy: stated.levelChangedBy }
                            : {}),
                        }
                      : {}),
                  }
                : { status: "current", access: committedPin.access };
            },
          );
        } catch {
          return { status: "unverified" };
        } finally {
          clearTimeout(timeout);
          unsubscribe();
          checks.delete(event.sender);
        }
      },
    },
  );

  return {
    // At start nothing else rebuilds a closed copy: its window shows Updating
    // access and reads nothing. Start each one, as Try again would.
    async resumeRebuilds() {
      for (const { workspaceId } of listWorkspaces()) {
        try {
          await recoverRebuild(workspaceId);
        } catch (error) {
          console.error("[desktop] joined copy rebuild status:", error);
        }
        if (requireWorkspace(workspaceId).shareView?.rebuild) startRebuild(workspaceId);
      }
    },
  };
}

// Where a membership sits on the relay: the role it last named, and the
// owner's workspace id that Members routes name. Neither grants anything.
function membershipPlace(info: {
  role?: "owner" | "admin" | "member";
  membersWorkspaceId?: string;
}) {
  return {
    ...(info.role === "admin" || info.role === "member" ? { role: info.role } : {}),
    ...(info.membersWorkspaceId ? { membersWorkspaceId: info.membersWorkspaceId } : {}),
  };
}

// A membership's level follows the relay both ways, so its held pull names
// it. A path share's pin never rises, so naming its level could only repeat.
function membershipLevel(selector: unknown): { level?: ShareViewSelector["access"] } {
  const pin = recordedShareSelector(selector);
  return pin?.wholeWorkspace === true ? { level: pin.access } : {};
}

// The engine closed a membership's copy for a rebuild.
class AccessUpdatingError extends Error {}

function causeOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\.+$/u, "") || "the server stopped answering";
}
