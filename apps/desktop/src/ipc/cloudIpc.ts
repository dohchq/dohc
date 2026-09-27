import { CHANNELS } from "./channels";
import {
  CloudEnableSyncPayload, CloudJoinWorkspacePayload, CloudJoinWorkspaceResult,
  CloudLoginStartPayload, CloudLoginStartResult, CloudLoginPollResult,
  CloudStatusPayload, CloudStatusResult, SyncStatusResult, WorkspaceSummary,
} from "./bridgeContract";
import {
  adoptCompletedCloudLoginSession, runCloudLogoutTransition, type CloudLogin,
} from "../workspaces/cloudLogin";
import { chatShareSessionKey } from "../mainChatIpcHandlers";
import { assertSyncEnrollmentCredentials, workspaceRemoteMatchesCredentials } from "../workspaces/chatRelayIdentity";
import { requireCredentials } from "../workspaces/credentialScopedOperation";
import { parseSyncCode, relayUrlsMatch } from "../workspaces/syncCode";
import { RelayUnauthorizedError, RelayWorkspaceUnavailableError, type RelayWorkspaceBootstrapResult } from "@dohc/workspace-contracts/relay";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { CreatedWorkspace } from "../workspaces/createWorkspaceFolder";
import type { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import type { EngineRelayWorkspaceClient } from "../workspaces/engineRelayClient";
import type { createJoinedWorkspaceRunner } from "../workspaces/createJoinedWorkspace";
import type { probeRelayWorkspace } from "../workspaces/relayWorkspaceProbe";
import type { readWorkspaceSecretState, readWorkspaceDataKeyForEnrollment, WorkspaceSecretState } from "../workspaces/workspaceSecretEnrollmentState";
import type { enrollWorkspaceKeyEnvelope } from "../workspaces/workspaceKeyEnvelopeEnrollment";
import type { bootstrapJoinedWorkspace } from "../workspaces/workspaceJoinEnrollment";
import type { installWorkspaceDataKey } from "../workspaces/workspaceDataKey";

export function registerCloudIpcHandlers<
  Sender,
  Event extends { sender: Sender },
  Operation extends {
    readonly workspace: RegistryEntry & { readonly attachmentId: symbol };
    assertCurrent(): void;
  },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  cloudLogin(): Pick<CloudLogin, "start" | "poll" | "status" | "logout" | "credentials">;
  clearCachedCredentials(): void;
  refreshCredentialCache(): Promise<void>;
  warmCredentialCache(): Promise<void>;
  currentCredentials(): CloudCredentials | null;
  loadAndCacheCurrentCredentials(): Promise<CloudCredentials | null>;
  closeAllRelayTransportWorkspaces(options?: { accountChanged?: boolean }): Promise<void>;
  activity: {
    stopEngines(): Promise<void>;
    enableCloud(workspace: RegistryEntry, options?: { joinBootstrap?: boolean }): Promise<unknown>;
    getStatus(workspaceId: string): SyncStatusResult;
  };
  reconcileCloud(): void;
  notifyCloudSessionChanged(phase: "changing" | "ready"): void;
  notifyCloudSessionChangedWithKey(key: string | null, phase: "changing" | "ready"): void;
  notifyRenderer(): void;
  findWorkspace(workspaceId: string): RegistryEntry | null;
  engineDaemonStartup(): Promise<unknown>;
  requireEngineSessions(): EngineWorkspaceSessions;
  currentEngineSessions(): EngineWorkspaceSessions | null;
  withPhysicalWorkspaceOperation<Result>(
    workspaceId: string,
    work: (operation: { readonly workspace: RegistryEntry & { readonly attachmentId: symbol }; assertCurrent(): void }) => Result | Promise<Result>,
  ): Promise<Result>;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, inactiveMessage: string,
    work: (operation: Operation) => Result | Promise<Result>,
  ): Promise<Result>;
  receivedShareEngine: Pick<ReturnType<typeof createReceivedShareEngineAccess>, "workspaceForRegistered">;
  readWorkspaceSecretState: typeof readWorkspaceSecretState;
  readWorkspaceDataKeyForEnrollment: typeof readWorkspaceDataKeyForEnrollment;
  assertWritableWorkspace(workspace: RegistryEntry): void;
  relayClientForWorkspace(input: {
    workspaceId: string; rootPath: string; attachmentId?: symbol;
    accountId: string;
    relay: { baseUrl: string; token: string };
  }): EngineRelayWorkspaceClient;
  enrollWorkspaceKeyEnvelope: typeof enrollWorkspaceKeyEnvelope;
  installWorkspaceDataKey: typeof installWorkspaceDataKey;
  setWorkspaceRemote(workspaceId: string, remote: NonNullable<RegistryEntry["remote"]>): unknown;
  usableRoot(rootPath: string): string;
  readdir(rootPath: string): Promise<string[]>;
  mkdir(rootPath: string, options: { recursive: true }): Promise<unknown>;
  probeRelayWorkspace: typeof probeRelayWorkspace;
  createJoinedWorkspace: ReturnType<typeof createJoinedWorkspaceRunner>;
  bootstrapJoinedWorkspace: typeof bootstrapJoinedWorkspace;
  refreshNativeWorkspaceSurfaces(): void;
  openWorkspaceActivity(workspace: CreatedWorkspace, options: { afterActivityOpen: () => Promise<void> }): Promise<unknown>;
  completeWorkspaceJoinBootstrap(workspaceId: string): unknown;
  desktopMarks: { mark(name: string): void; measureSince(name: string, start: string): unknown };
}): void {
  const {
    registerHandler, assertTrustedSender, cloudLogin, clearCachedCredentials,
    refreshCredentialCache, warmCredentialCache, currentCredentials,
    loadAndCacheCurrentCredentials, closeAllRelayTransportWorkspaces, activity,
    reconcileCloud, notifyCloudSessionChanged, notifyCloudSessionChangedWithKey,
    notifyRenderer, findWorkspace, engineDaemonStartup,
    requireEngineSessions, currentEngineSessions, withPhysicalWorkspaceOperation,
    withRendererWorkspaceOperation, receivedShareEngine, readWorkspaceSecretState,
    readWorkspaceDataKeyForEnrollment, assertWritableWorkspace, relayClientForWorkspace,
    enrollWorkspaceKeyEnvelope, installWorkspaceDataKey, setWorkspaceRemote,
    usableRoot, readdir, mkdir, probeRelayWorkspace, createJoinedWorkspace,
    bootstrapJoinedWorkspace, refreshNativeWorkspaceSurfaces, openWorkspaceActivity,
    completeWorkspaceJoinBootstrap, desktopMarks,
  } = dependencies;

  registerHandler(CHANNELS.cloudLoginStart, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudLoginStartPayload.parse(payload ?? {});
    return CloudLoginStartResult.parse(await cloudLogin().start(input.serverUrl));
  });

  registerHandler(CHANNELS.cloudLoginPoll, async (event) => {
    assertTrustedSender(event);
    const result = await cloudLogin().poll();
    if (result.status === "complete") {
      // The incoming session's identity, computed before anything is
      // cleared: the immediate broadcast says where the session is going, so
      // a same-account rotation carries the same key and mounted views keep
      // their rows instead of reading a signed-out interim as a switch.
      const incomingKey = chatShareSessionKey(await cloudLogin().credentials());
      // A completed login can rotate the bearer token without changing the
      // server or user id. Rebuild every relay-bound engine from the new
      // credential snapshot instead of letting an existing engine keep the
      // previous token.
      await adoptCompletedCloudLoginSession({
        clearCachedCredentials: () => clearCachedCredentials(),
        stopEngines: async () => await activity.stopEngines(),
        closeRelayTransportWorkspaces: async () =>
          await closeAllRelayTransportWorkspaces({ accountChanged: true }),
        refreshCredentialCache: async () => await refreshCredentialCache(),
        // Attach engines to already-open cloud-enabled workspaces that were
        // opened local-only because no session existed yet.
        reconcileCloud: () => {
          reconcileCloud();
        },
        notifySessionChanging: () =>
          notifyCloudSessionChangedWithKey(incomingKey, "changing"),
        notifyCloudSessionChanged: () => notifyCloudSessionChanged("ready"),
      });
    }
    return CloudLoginPollResult.parse(result);
  });

  registerHandler(CHANNELS.cloudStatus, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudStatusPayload.parse(payload ?? {});
    const status = await cloudLogin().status();
    await warmCredentialCache();
    const workspace = input.workspaceId ? findWorkspace(input.workspaceId) : undefined;
    let workspaceSecretState: WorkspaceSecretState | undefined;
    if (workspace) {
      // The shell asks at mount, which can precede the daemon handshake now
      // that the window loads during it.
      await engineDaemonStartup();
      const sessions = requireEngineSessions();
      workspaceSecretState = await withPhysicalWorkspaceOperation(
        workspace.workspaceId,
        async (operation) =>
          await readWorkspaceSecretState(
            receivedShareEngine.workspaceForRegistered(operation.workspace),
            sessions,
          ),
      );
    }
    return CloudStatusResult.parse({
      ...status,
      ...(input.workspaceId
        ? {
            workspaceSynced: !!workspace?.remote,
            workspaceSyncConnected:
              !!workspace?.remote &&
              workspaceRemoteMatchesCredentials(
                workspace.remote,
                currentCredentials(),
              ),
            ...(workspaceSecretState ? { workspaceSecretState } : {}),
          }
        : {}),
    });
  });

  registerHandler(CHANNELS.cloudLogout, async (event) => {
    assertTrustedSender(event);
    await runCloudLogoutTransition({
      clearCachedCredentials: () => clearCachedCredentials(),
      logout: () => cloudLogin().logout(),
      stopEngines: () => activity.stopEngines(),
      closeRelayTransportWorkspaces: () => closeAllRelayTransportWorkspaces({ accountChanged: true }),
      // Scope-free: logout changes every workspace's sync state at once.
      notifyWorkspaceActivity: () => notifyRenderer(),
      // Logout is a one-event transition to a known state: signed out. The
      // key change is what makes every view clear and refresh.
      notifyCloudSessionChanged: () => notifyCloudSessionChanged("ready"),
    });
  });

  // Enabling sync claims the workspace id. The first claimant owns it. The
  // owner can retry, and another account gets the relay's fixed 404. The
  // handler then records the verified binding and starts the merge engine.
  //
  // The relay's POST /sync/workspaces is the sole claim authority: workspace-api
  // is now auth-only and 404s every non-auth route, so there is no separate
  // preclaim to make — the relay owns ownership end to end (create / idempotent
  // same-owner / foreign-refused).
  registerHandler(CHANNELS.cloudEnableSync, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudEnableSyncPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Cloud enrollment stopped because this window changed workspaces.",
      async (operation) => {
        const workspace = operation.workspace;
        // A received share replicates through its pinned share lane. Enrolling its
        // projection as an owned workspace would claim someone else's filtered
        // copy and creates another engine-open path that has no reason to exist.
        assertWritableWorkspace(workspace);
        const credentials = await loadAndCacheCurrentCredentials();
        operation.assertCurrent();
        if (!credentials) throw new Error("Sign in to your server first");
        if (!credentials.relayUrl) {
          throw new Error("Cloud sync requires a relay URL");
        }
        assertSyncEnrollmentCredentials(workspace, credentials);
        const relay = {
          baseUrl: credentials.relayUrl,
          token: credentials.token,
        };
        const daemonRelay = relayClientForWorkspace({
          workspaceId: workspace.workspaceId,
          accountId: credentials.userId,
          rootPath: workspace.rootPath,
          attachmentId: workspace.attachmentId,
          relay,
        });
        await daemonRelay.claim();
        operation.assertCurrent();
        const sessions = currentEngineSessions();
        if (!sessions) {
          throw new Error("Rust engine workspace sessions are unavailable.");
        }
        const dataKey = await readWorkspaceDataKeyForEnrollment(
          receivedShareEngine.workspaceForRegistered(workspace),
          sessions,
        );
        operation.assertCurrent();
        await enrollWorkspaceKeyEnvelope({
          workspaceId: workspace.workspaceId,
          dataKey,
          ...(input.passphrase === undefined
            ? {}
            : { passphrase: input.passphrase }),
          transport: daemonRelay,
          installDataKey: async (unwrapped) =>
            await installWorkspaceDataKey(workspace.rootPath, unwrapped),
        });
        operation.assertCurrent();
        setWorkspaceRemote(workspace.workspaceId, {
          serverUrl: credentials.serverUrl,
          ownerUserId: credentials.userId,
        });
        await activity.enableCloud(workspace);
        operation.assertCurrent();
        return SyncStatusResult.parse(activity.getStatus(workspace.workspaceId));
      },
    );
  });

  // Join a synced workspace on this machine (0P-C): sync code from the
  // machine that already has it + a locally picked empty folder. Everything
  // is validated before any local state is created, so a mistyped code can
  // never mint an empty workspace; the first pull brings files, history,
  // and chats through the same engine sync path every later pull uses.
  registerHandler(CHANNELS.cloudJoinWorkspace, async (event, payload) => {
    assertTrustedSender(event);
    const input = CloudJoinWorkspacePayload.parse(payload);
    const parsed = parseSyncCode(input.syncCode);
    if (!parsed) {
      throw new Error(
        "That doesn't look like a workspace code. Copy it again from the other machine.",
      );
    }
    const credentials = requireCredentials(
      await loadAndCacheCurrentCredentials(),
    );
    if (
      !credentials.relayUrl ||
      !relayUrlsMatch(credentials.relayUrl, parsed.relayUrl)
    ) {
      // Security gate, not cosmetics: the session token is only ever sent to
      // the relay this machine signed in with — never to a URL that arrived
      // inside a pasted code.
      throw new Error(
        "This workspace syncs through a different server than the one you're signed in to. " +
          "Connect to the server that hosts this workspace, then join again.",
      );
    }
    if (findWorkspace(parsed.workspaceId)) {
      throw new Error("This workspace is already on this machine.");
    }
    const rootPath = usableRoot(input.rootPath);
    const existingEntries = await readdir(rootPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (existingEntries.length > 0) {
      throw new Error(
        "Choose an empty folder — the synced workspace's files will be placed inside it.",
      );
    }

    // Pre-flight against the relay before creating anything locally.
    const relay = { baseUrl: credentials.relayUrl, token: credentials.token };
    let probe: RelayWorkspaceBootstrapResult;
    try {
      probe = await probeRelayWorkspace({
        workspaceId: parsed.workspaceId,
        relay,
      });
      if (!probe.hasContent) {
        throw new Error(
          "That workspace hasn't synced anything yet. Make sure sync is on for it on the other machine, then try again.",
        );
      }
    } catch (error) {
      if (error instanceof RelayWorkspaceUnavailableError) {
        throw new Error(
          "No synced workspace matches that code for your account. Check the code and that you're signed in with the same account.",
        );
      }
      if (error instanceof RelayUnauthorizedError) {
        throw new Error(
          "Your server session expired. Sign in again, then retry.",
        );
      }
      throw error;
    }

    await mkdir(rootPath, { recursive: true });
    let summary!: ReturnType<typeof WorkspaceSummary.parse>;
    desktopMarks.mark("workspace-join-start");
    await createJoinedWorkspace({
      workspaceId: parsed.workspaceId,
      rootPath,
      prepare: async (created) => {
        summary = WorkspaceSummary.parse(created);
        // Bootstrap the relay coordinate through a capture-free daemon session
        // before registration exposes the workspace or activity.open can build
        // capture and start its watcher. An unset relay is claimed; otherwise
        // the pristine daemon adopts the relay's existing epoch and stream with
        // its own new origin. The bootstrap session closes before the captured
        // activity session opens.
        const daemonRelay = relayClientForWorkspace({
          workspaceId: parsed.workspaceId,
          accountId: credentials.userId,
          rootPath: created.rootPath,
          relay,
        });
        await bootstrapJoinedWorkspace({
          workspaceId: parsed.workspaceId,
          identity: probe.identity,
          ...(input.passphrase === undefined
            ? {}
            : { passphrase: input.passphrase }),
          transport: daemonRelay,
          installDataKey: async (unwrapped) =>
            await installWorkspaceDataKey(created.rootPath, unwrapped),
        });

        return { ...created, joinBootstrapPending: true };
      },
      populate: async (created) => {
        refreshNativeWorkspaceSurfaces();

        // Now open capture, bind the remote, and enable the pull-first engine.
        // joinBootstrap makes the engine PULL-FIRST:
        // its start() is the first pull (materialize + cursor commit), and no
        // push can reach the relay before that pull succeeds — a fresh join can
        // never seed boilerplate into the remote or conflict against it.
        await openWorkspaceActivity(created, {
          afterActivityOpen: async () => {
            setWorkspaceRemote(created.workspaceId, {
              serverUrl: credentials.serverUrl,
              ownerUserId: credentials.userId,
            });
            await activity.enableCloud(created, { joinBootstrap: true });
            completeWorkspaceJoinBootstrap(created.workspaceId);
          },
        });
      },
      rollbackLabel: "join",
      cleanupFailureMessage:
        `dohc could not close the failed download. Files remain in ${rootPath}. Restart dohc. If this folder appears in the workspace list, choose Forget from its menu before joining again. Forget keeps the folder. Then choose another empty folder.`,
      failure: (error) => {
        if (
          error instanceof Error &&
          /^(?:Passphrase required|Passphrase could not)\b/u.test(error.message)
        ) {
          return new Error(`${error.message} Files remain in ${rootPath}. Choose another empty folder to try again.`);
        }
        return new Error(
          `dohc could not download the workspace. Files remain in ${rootPath}. Check your connection, then choose another empty folder.`,
        );
      },
    });
    desktopMarks.measureSince("workspace-join", "workspace-join-start");
    // Scope-free: the join added a registry entry no window has active yet.
    notifyRenderer();
    return CloudJoinWorkspaceResult.parse({ workspace: summary });
  });

}
