import { randomUUID } from "node:crypto";
import { CHANNELS } from "./channels";
import { OpenSharedViewPayload, OpenSharedViewResult, RefreshSharedViewPayload, RefreshSharedViewResult } from "./bridgeContract";
import { requireCredentials } from "../workspaces/credentialScopedOperation";
import { parseShareCode, relayUrlsMatch } from "../workspaces/syncCode";
import { RelayUnauthorizedError, ShareUnavailableError } from "@dohc/workspace-contracts/relay";
import { ShareSelectorInvalidError, type fetchShareViewInfo } from "../workspaces/shareViewInfo";
import { assertMountableSelector } from "../workspaces/shareMounts";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { SharePinInvalidError, shareViewIdentitySelector } from "../workspaces/shareViewRecords";
import { waitForReceivedShareCaptureReady } from "../workspaces/receivedShareCaptureReady";
import { workspaceSummaryFor } from "../workspaces/workspaceSummaryProjection";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { CreatedWorkspace } from "../workspaces/createWorkspaceFolder";
import type { createJoinedWorkspaceRunner } from "../workspaces/createJoinedWorkspace";
import type { WorkspaceAuthorityBinding } from "../workspaces/workspaceAuthorityOwner";
import type { ShareViewFiles } from "../workspaces/shareViewFiles";
import type { withStaleSensitiveWorkspaceOperation } from "../workspaces/workspaceAssets";
import type { createReceivedShareEngineAccess } from "../workspaces/receivedShareEngineAccess";
import type { setWorkspaceShareView } from "../workspaces/WorkspaceRegistry";
import type { WorkspaceActivityScope } from "./workspaceActivityBroadcast";

export function registerSharedViewsIpcHandlers<
  Sender,
  Event extends { sender: Sender },
  Operation extends {
    readonly workspace: RegistryEntry & { readonly attachmentId: symbol };
    assertCurrent(): void;
  },
  Lease,
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(sender: Sender, workspaceId: string, inactiveMessage: string,
    work: (operation: Operation) => Promise<Result>): Promise<Result>;
  loadAndCacheCurrentCredentials(): Promise<CloudCredentials | null>;
  warmCredentialCache(): Promise<void>;
  currentCredentials(): CloudCredentials | null;
  engineDaemonStartup(): Promise<unknown>;
  fetchShareViewInfo: typeof fetchShareViewInfo;
  usableRoot(path: string): string;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  createJoinedWorkspace: ReturnType<typeof createJoinedWorkspaceRunner>;
  setWorkspaceShareView: typeof setWorkspaceShareView;
  refreshNativeWorkspaceSurfaces(): void;
  workspaceAuthorities: {
    withBinding<Result>(binding: WorkspaceAuthorityBinding<RegistryEntry>, work: (lease: Lease) => Result | Promise<Result>): Promise<Result>;
  };
  canonicalWorkspaceFor(lease: Lease): RegistryEntry & { readonly attachmentId: symbol };
  withStaleSensitiveWorkspaceOperation: typeof withStaleSensitiveWorkspaceOperation;
  shareViewFiles: Pick<ShareViewFiles, "reconcile">;
  receivedShareEngine: Pick<ReturnType<typeof createReceivedShareEngineAccess>, "relayFor" | "storeFor">;
  openWorkspaceActivity(workspace: CreatedWorkspace): Promise<unknown>;
  requireWorkspace(workspaceId: string): RegistryEntry;
  notifyRenderer(scope?: WorkspaceActivityScope): void;
}): void {
  const {
    registerHandler, assertTrustedSender, withRendererWorkspaceOperation,
    loadAndCacheCurrentCredentials, warmCredentialCache, currentCredentials, engineDaemonStartup,
    fetchShareViewInfo, usableRoot, readdir, mkdir, createJoinedWorkspace, setWorkspaceShareView,
    refreshNativeWorkspaceSurfaces, workspaceAuthorities, canonicalWorkspaceFor,
    withStaleSensitiveWorkspaceOperation, shareViewFiles, receivedShareEngine,
    openWorkspaceActivity, requireWorkspace, notifyRenderer,
  } = dependencies;
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
    if (!grantedSelector || !credentials?.relayUrl) return;
    await receivedShareEngine.relayFor({
      engineWorkspaceId: workspace.workspaceId,
      rootPath: workspace.rootPath,
      attachmentId: workspace.attachmentId,
      relay: { baseUrl: credentials.relayUrl, token: credentials.token },
    }).recordShareViewIdentity({ grantedSelector });
  }

  // Receive side: open a pasted share code as a READ-ONLY shared view.
  // Mirrors the join flow's ordering guarantees: everything is validated
  // before local state exists, the token only ever goes to the signed-in
  // relay, and a failed first pull rolls the whole thing back.
  registerHandler(CHANNELS.openSharedView, async (event, payload) => {
    assertTrustedSender(event);
    const input = OpenSharedViewPayload.parse(payload);
    const parsed = parseShareCode(input.shareCode);
    if (!parsed) {
      throw new Error(
        "That doesn't look like a share code. Copy it again and retry.",
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
        "This share lives on a different server than the one you're signed in to. " +
          "Connect to the server that hosts this share, then try again.",
      );
    }
    const relay = { baseUrl: credentials.relayUrl, token: credentials.token };
    // Pre-flight against the relay before creating anything locally; also
    // learns who shared it for the honest read-only copy.
    let info: Awaited<ReturnType<typeof fetchShareViewInfo>>;
    try {
      info = await fetchShareViewInfo({ relay, shareId: parsed.shareId });
    } catch (error) {
      if (error instanceof ShareUnavailableError) {
        throw new Error(
          "No share matches that code for your account. Check the code and that you're signed in with the account it was shared with.",
        );
      }
      if (error instanceof RelayUnauthorizedError) {
        throw new Error(
          "Your server session expired. Sign in again, then retry.",
        );
      }
      if (error instanceof ShareSelectorInvalidError) {
        throw new Error(
          "This share can't be opened: the server didn't say what it shares. Try again later.",
        );
      }
      throw error;
    }
    // A chat-channel code has no file selector, so there is no scope to
    // enforce and nothing to project. Refuse it here rather than record a
    // grant of "everything" (the mount path says the same through
    // assertMountableSelector).
    assertMountableSelector(info.selector);
    const grantedSelector = info.selector;
    const rootPath = usableRoot(input.rootPath);
    const existingEntries = await readdir(rootPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (existingEntries.length > 0) {
      throw new Error(
        "Choose an empty folder — the shared files will be placed inside it.",
      );
    }
    // Identity/metadata only (the join bootstrap): the shared content
    // arrives with the first pull below, and a shared view must never seed
    // starter files of its own.
    await mkdir(rootPath, { recursive: true });
    const created = await createJoinedWorkspace({
      workspaceId: randomUUID(),
      rootPath,
      populate: async (created, authorityBinding) => {
        setWorkspaceShareView(created.workspaceId, {
          shareId: parsed.shareId,
          granterEmail: info.granterEmail,
          genericChatWritable: info.genericChatWritable,
          // Pin the selector the relay just stated, so later pulls enforce it
          // instead of trusting the relay's selection each time.
          grantedSelector,
          // Persist the origin relay so a later refresh signed into a different
          // relay is skipped instead of misreading a 404 as "share ended".
          relayUrl: credentials.relayUrl,
        });
        refreshNativeWorkspaceSurfaces();
        // Before the first pull: a share view that writes back needs its own
        // sync identity, and the pull is what gives it the share cursor that
        // makes local writes journal.
        //
        // Soft, like the refresh site. Opening a share is a read, and a failure
        // here costs the recipient the ability to send changes, not the ability
        // to open what they were given. The next refresh records it.
        await workspaceAuthorities
          .withBinding(authorityBinding, (lease) =>
            recordShareViewIdentity(canonicalWorkspaceFor(lease)),
          )
          .catch((error) => {
            console.error("[desktop] share view identity:", error);
          });
        const reconciled = await withStaleSensitiveWorkspaceOperation(
          created.rootPath,
          (lease) =>
            shareViewFiles.reconcile(
              lease,
              { kind: "standalone", workspaceId: created.workspaceId },
              "refresh",
            ),
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
      },
      rollbackLabel: "open-share",
      cleanupFailureMessage:
        "Couldn't safely roll back the shared view. Its folder was left in place; restart dohc before retrying.",
      failure: (error) => {
        if (error instanceof ShareUnavailableError) {
          return new Error(
            "This share was ended before it could be opened. Nothing was added on this machine.",
          );
        }
        return new Error(
          "Couldn't open the share. Nothing was added on this machine — check your connection and try again.",
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
    const summary = workspaceSummaryFor(requireWorkspace(created.workspaceId));
    return OpenSharedViewResult.parse({ workspace: summary });
  });

  registerHandler(CHANNELS.refreshSharedView, async (event, payload) => {
    assertTrustedSender(event);
    const input = RefreshSharedViewPayload.parse(payload);
    return withRendererWorkspaceOperation(
      event.sender,
      input.workspaceId,
      "Shared view refresh stopped because this window changed workspaces.",
      async (operation) => {
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
        // Refresh the relay-derived chat fact for the banner's next step. It
        // does not grant desktop generic-chat writes. Keep the share identity
        // current for the separate Edit proposal lane.
        if (!workspace.shareView.ended) {
          let refreshedWorkspace = workspace;
          await warmCredentialCache().catch(() => undefined);
          const credentials = currentCredentials();
          if (
            credentials?.relayUrl &&
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
              const nextShareView = {
                ...workspace.shareView,
                genericChatWritable: info.genericChatWritable,
              };
              setWorkspaceShareView(workspace.workspaceId, nextShareView);
              refreshedWorkspace = { ...workspace, shareView: nextShareView };
            } catch (error) {
              if (!(error instanceof ShareUnavailableError)) {
                throw error;
              }
            }
          }
          await recordShareViewIdentity(refreshedWorkspace).catch((error) => {
            console.error("[desktop] share view enrolment:", error);
          });
        }
        let outcome;
        try {
          const reconciled = await withStaleSensitiveWorkspaceOperation(
            workspace.rootPath,
            (lease) =>
              shareViewFiles.reconcile(
                lease,
                { kind: "standalone", workspaceId: workspace.workspaceId },
                "refresh",
              ),
          );
          if (reconciled.kind !== "refresh") {
            throw new Error("Shared view refresh returned an invalid result.");
          }
          outcome = reconciled.outcome;
        } catch (error) {
          operation.assertCurrent();
          // A pull that failed on a later page still persisted the refusals its
          // earlier pages recorded, so the renderer is told once here too.
          notifyRenderer({ workspaceId: workspace.workspaceId });
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
        if ("ok" in outcome && !outcome.ok) {
          operation.assertCurrent();
          notifyRenderer({ workspaceId: workspace.workspaceId });
          return RefreshSharedViewResult.parse(outcome);
        }
        operation.assertCurrent();
        if (outcome.status === "ended") refreshNativeWorkspaceSurfaces();
        notifyRenderer({ workspaceId: workspace.workspaceId });
        return RefreshSharedViewResult.parse(outcome);
      },
    );
  });

}
