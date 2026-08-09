import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const dmRequestsSource = readFileSync(
  new URL("./workspaces/dmRequests.ts", import.meta.url),
  "utf8",
);

function handlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (markerAt < 0 || start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

describe("main-process chat authorization", () => {
  it("routes every main chat acquisition through the Rust-only factory", () => {
    const factoryStart = mainSource.indexOf("function linkedChatStoreFor(");
    const factoryEnd = mainSource.indexOf(
      "\nconst agentDispatchStoreHandles",
      factoryStart,
    );
    const factory = mainSource.slice(factoryStart, factoryEnd);

    expect(factory).toContain("createDesktopLinkedChatStore(workspace, {");
    expect(factory).toContain("sessions: rustEngineWorkspaceSessions");
    expect(factory).not.toContain("createLinkedChatStore(");
  });

  it("awaits linked-chat initialization before opening the dispatch adapter", () => {
    const handler = handlerSource("chatRunRecordsForThread");
    expect(handler).toContain("await linkedChatStore.ensureOpen()");
    expect(handler.indexOf("await linkedChatStore.ensureOpen()")).toBeLessThan(
      handler.indexOf("agentDispatchStoreHandleFor(workspace)"),
    );
  });

  it("guards every renderer chat mutation with the workspace read-only boundary", () => {
    const guardedMutations = [
      "saveChatBookmark",
      "archiveChatBookmark",
      "createFileChat",
      "sendChatMessage",
      "resolveChatDecision",
      "setChatFollow",
      "startChannelThread",
      "shareChatChannel",
      "startDm",
      "resumeThreadDispatch",
    ];

    for (const channel of guardedMutations) {
      expect(handlerSource(channel), channel).toContain(
        "assertWritableWorkspace(workspace);",
      );
    }

    expect(handlerSource("createChatChannel")).toContain("createChatChannelIpcHandler({");
    expect(handlerSource("createChatChannel")).toContain("assertWritableWorkspace,");
    expect(handlerSource("setChatReaction")).toContain("createSetChatReactionIpcHandler({");
    expect(handlerSource("setChatReaction")).toContain("assertWritableWorkspace,");
    expect(handlerSource("markChatThreadRead")).toContain(
      "createSharedChannelWritableChatIpcHandler({",
    );
    expect(handlerSource("markChatThreadRead")).toContain("assertWritableWorkspace,");
    expect(handlerSource("markChatThreadRead")).toContain(
      "await assertSharedChannelWritable({",
    );
  });

  it("gates every chat dispatch IPC on the workspace engine capture", () => {
    // AUDIT-OPTOUT: each handler resolves the engine dispatch store — the read
    // resolves it, the resume WRITES a paused flag through it. An opted-out
    // workspace must refuse both, exactly like its sibling chat IPCs.
    const gated = [
      ["chatDispatchStateForThread", "chatDispatchService.dispatchStateForThread("],
      ["resumeThreadDispatch", "chatDispatchService.resumeThreadDispatch("],
    ] as const;

    for (const [channel, call] of gated) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain("requireEngineCapture(");
      // #541 round 6: callers pass the FEATURE noun; the gate owns the copy.
      expect(handler, channel).toContain('"Chats"');
      expect(handler.indexOf("requireEngineCapture("), channel).toBeLessThan(
        handler.indexOf(call),
      );
    }
  });

  it("connects the production reaction handler to its behavior-tested boundary", () => {
    const handler = handlerSource("setChatReaction");
    expect(handler).toContain("setChatReactionFromMain({");
    expect(handler).toContain("revalidateReplicationAuthorId:");
    expect(handler).toContain("revalidateChatWrite(workspace, target, authorUserId)");
    expect(handler).toContain("syncJoinedChannels:");
    expect(handler).toContain("syncWorkspaceSharedChannels(workspaceId)");
    expect(handler).toContain("queueCloudSync:");
    expect(handler).toContain("activity.queueCloudSync(workspaceId)");
  });

  it("connects both message composers to the behavior-tested identity gate", () => {
    for (const channel of ["sendChatMessage", "startChannelThread"]) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain("writeChatMessageFromMain({");
      expect(handler, channel).toContain("revalidateAuthorUserId:");
      expect(handler, channel).toContain(
        "revalidateChatWrite(workspace, target, authorUserId)",
      );
    }
  });

  it("connects account-pinned relay work to its behavior-tested helpers", () => {
    expect(handlerSource("joinSharedChannel")).toContain(
      "recipientUserId: joinedRecipientUserId",
    );
    expect(mainSource).toContain(
      "const joinedRecipientUserId = joinCredentials.userId;",
    );
    expect(handlerSource("acceptDm")).toContain(
      "recipientUserId: acceptCredentials.userId",
    );
    expect(mainSource).toContain(
      "joinedChannelMatchesCredentials(channel, syncCredentials)",
    );
    expect(mainSource).toContain(
      "workspaceRemoteMatchesCredentials(remote, credentials)",
    );
    expect(mainSource).not.toContain("credentialMatchesRemote");
    expect(mainSource).toContain(
      "!!remote && workspaceRemoteMatchesCredentials(remote, cachedCredentials)",
    );
    expect(mainSource).toContain(
      "workspaceRemoteMatchesCredentials(workspace.remote, credentials)",
    );
    const loginPoll = handlerSource("cloudLoginPoll");
    expect(loginPoll).toContain("await adoptCompletedCloudLoginSession({");
    const loginReplacementSteps = [
      "clearCachedCredentials()",
      "activity.stopEngines()",
      "closeAllRelayTransportWorkspaces()",
      "refreshCredentialCache()",
      "activity.reconcileCloud(engineForWorkspace)",
    ];
    let previousStep = -1;
    for (const step of loginReplacementSteps) {
      const index = loginPoll.indexOf(step);
      expect(index, step).toBeGreaterThan(previousStep);
      previousStep = index;
    }
    expect(mainSource).not.toContain("pinLegacyWorkspaceRemotesForCurrentAccount");
    expect(handlerSource("cloudEnableSync")).toContain(
      "syncEnrollmentRemoteWorkspaceId(",
    );
    expect(handlerSource("cloudEnableSync")).toContain(
      "workspaceId: remoteWorkspaceId",
    );
  });

  it("revalidates owner agent-message authorship after the authorization await", () => {
    const start = mainSource.indexOf("authorizeServiceNote: async");
    const end = mainSource.indexOf("onMessagePosted:", start);
    const authorizeServiceNote = mainSource.slice(start, end);

    expect(authorizeServiceNote).toContain(
      "identity.authorUserId === verifiedUserId &&",
    );
  });

  it("derives generic channel-share eligibility in the main process", () => {
    const handler = handlerSource("shareChatChannel");
    expect(handler).toContain("requireShareableChatChannel({");
    expect(handler.indexOf("requireShareableChatChannel({")).toBeLessThan(
      handler.indexOf("relayShareJson<{ shareId: string }>("),
    );
  });

  it("projects pending chat bookmarks immediately after workspace and shared-channel pulls", () => {
    expect(mainSource).toContain(
      "afterSuccessfulPull: () =>\n      projectPendingChatBookmarksAfterPull(workspace.workspaceId)",
    );
    expect(mainSource).toContain(
      "if (result.changed) await projectPendingChatBookmarksAfterPull(workspaceId);",
    );
    expect(mainSource).toContain(
      "readOnly: Boolean(sharedViewOf(workspaceId))",
    );
  });

  // #541: the cause-aware refusal helpers are behavior-tested in
  // engineCaptureGate.test.ts, but the WIRING is the user-visible fix —
  // reverting a call site to a bare "not enabled" throw passes the whole
  // desktop suite. These pins make that revert fail.
  it("routes every null-capture refusal through the cause-aware helper", () => {
    function slice(startMarker: string, endMarker: string): string {
      const start = mainSource.indexOf(startMarker);
      const end = mainSource.indexOf(endMarker, start);
      if (start < 0 || end < 0) {
        throw new Error(`Missing main.ts region ${startMarker} .. ${endMarker}`);
      }
      return mainSource.slice(start, end);
    }

    // The single gate behind the 30+ versions/chats/engine-history handlers.
    expect(
      slice(
        "async function requireEngineCapture(",
        "async function requireVersionOperations(",
      ),
    ).toContain("engineOffRefusal(");
    // The dispatch prepare seam: cause before release, recovery from the
    // actual close — both live inside the helper, so the wiring must use it.
    const prepare = slice(
      "prepareRunWorkspace: async (workspace)",
      "authorizeServiceNote:",
    );
    expect(prepare).toContain("releaseAndRefuseWithoutCapture({");
    // Round 5: the kept-entry path answers from the LIVE capture re-read.
    expect(prepare).toContain("currentCapture:");
    // Round 6: judged only after the kept open has settled.
    expect(prepare).toContain("settleKeptOpen:");
    expect(prepare).toContain("ensureWorkspaceActivityOpen(registered)");
    // And the release itself derives its answer from the post-close
    // retention state (round 4) — through the behavior-tested factory.
    expect(
      slice(
        "async function acquireDispatchRunActivity(",
        "function openDispatchWorkspaces(",
      ),
    ).toContain("createDispatchRunRelease({");
    // The two manual sites outside requireEngineCapture.
    expect(
      slice("operationsFor: async (workspaceId)", "startRun: async"),
    ).toContain("engineOffRefusal(");
    expect(
      slice("async function openCliWorkspace(", "const store = linkedChatStoreFor("),
    ).toContain("engineOffRefusal(");
  });

  // Both explicit join paths pull the share's log into the chosen workspace.
  // A joined-lane refusal raised AFTER either one leaves the pulled
  // messages with no registry row, and no row is what
  // joinedSharedChannelForTarget answers null for: assertSharedChannelWritable
  // and channelIsLocked then read a READ-ONLY shared channel as a local one
  // the user may write into. The order is the authorization, so it is pinned
  // here rather than left to the reader.
  // A check ahead of an awaited pull is not a gate: two joins at the limit
  // both pass it, both pull, and the loser's merge throws with its channel
  // already imported. So the RESERVATION — the merge itself, synchronous over
  // the cached registry — is what has to precede the pull. The loser then
  // refuses having pulled nothing.
  it("reserves the joined-lane slot before either join path pulls anything", () => {
    for (const [label, source] of [
      ["joinSharedChannel", handlerSource("joinSharedChannel")],
      ["acceptDm", handlerSource("acceptDm")],
    ] as const) {
      expect(source, label).toContain("reserveAndPullSharedChannel({");
      expect(source, label).toContain(
        "writeSharedChannels: setWorkspaceSharedChannels",
      );
    }
    const reserveAt = dmRequestsSource.indexOf("input.writeSharedChannels(");
    const pullAt = dmRequestsSource.indexOf("await input.pull({");
    expect(reserveAt).toBeGreaterThan(-1);
    expect(pullAt).toBeGreaterThan(reserveAt);
    expect(dmRequestsSource.slice(pullAt)).not.toContain(
      "writeSharedChannels(input.workspaceId, []",
    );
  });

  // An ENDED row claims nothing across workspaces. The tombstone stays as its
  // own workspace's write gate, but leaving is presented as reversible and
  // silently was not: the invitation stayed filtered out of every other
  // workspace, and the only offered action in the holder was to rejoin.
  it("lets an ended row stop claiming a share for every other workspace", () => {
    const claimStart = dmRequestsSource.indexOf(
      "export function liveSharedChannelHoldersByShareId(",
    );
    const claimEnd = dmRequestsSource.indexOf(
      "export function otherLiveSharedChannelHolder(",
      claimStart,
    );
    expect(claimStart).toBeGreaterThan(-1);
    expect(claimEnd).toBeGreaterThan(claimStart);
    const claim = dmRequestsSource.slice(claimStart, claimEnd);
    const skipAt = claim.indexOf("if (channel.ended === true) continue;");
    const addAt = claim.indexOf("shareHolders.add(workspace.workspaceId);");
    expect(skipAt).toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(-1);
    expect(skipAt).toBeLessThan(addAt);
    expect(dmRequestsSource.match(/Ended rows are provenance/gu)).toHaveLength(1);
  });

  // Reserving the row before the pull makes it VISIBLE to any sync pass that
  // starts meanwhile — a relay cadence, listChatChannels, a syncDms refresh —
  // and a rotating pass can pull the same row. Without the shared serializer,
  // two pulls of the same share race the per-share cursor and peer updates.
  // Both join paths run outside a pass, so this queues rather than deadlocking.
  it("runs each join's first pull under the same per-workspace serializer as the sync pass", () => {
    expect(mainSource).toContain(
      "return serializeSharedChannelSync(workspaceId, () =>\n    runSharedChannelSyncPass(workspaceId, priorityChannelWireId),",
    );

    for (const [label, source] of [
      ["joinSharedChannel", handlerSource("joinSharedChannel")],
      ["acceptDm", handlerSource("acceptDm")],
    ] as const) {
      expect(source, label).toContain("serialize: serializeSharedChannelSync");
    }
    const serializeAt = dmRequestsSource.indexOf("await input.serialize(");
    const pullAt = dmRequestsSource.indexOf("await input.pull({");
    expect(serializeAt).toBeGreaterThan(-1);
    expect(pullAt).toBeGreaterThan(serializeAt);
  });

  it("keeps received DMs as requests until acceptDm chooses a workspace", () => {
    const sync = handlerSource("syncDms");
    expect(sync).toContain("await classifyDmRequests({");
    expect(sync).toContain("pending,");
    expect(sync).toContain("declined,");
    expect(sync).not.toContain("mergeJoinedChannel(");
    expect(sync).not.toContain("setWorkspaceSharedChannels(");
    expect(sync).not.toContain("pullSharedChannel({");
    expect(sync).not.toContain("reserveAndPullSharedChannel({");
    expect(mainSource).not.toContain("autoJoinReceivedDms");
    expect(mainSource).not.toContain("dohc-dm-homes.json");
  });

  it("accepts only once and keys every write and pull to the chosen workspace", () => {
    const handler = handlerSource("acceptDm");
    const exclusivityAt = handler.indexOf("otherWorkspaceHoldingShare(");
    const credentialsAt = handler.indexOf("await warmCredentialCache()");
    const reserveAt = handler.indexOf("reserveAndPullSharedChannel({");
    expect(exclusivityAt).toBeGreaterThan(-1);
    expect(exclusivityAt).toBeLessThan(credentialsAt);
    expect(
      handler.match(/otherWorkspaceHoldingShare\(/gu),
    ).toHaveLength(2);
    expect(handler).toContain(
      "This conversation already lives in ${workspaceName}. Open that workspace to continue.",
    );
    expect(handler).toContain("if (!acceptedHere)");
    expect(reserveAt).toBeGreaterThan(credentialsAt);
    expect(handler).toContain("workspaceId: workspace.workspaceId");
    expect(handler).toContain("serialize: serializeSharedChannelSync");
    expect(handler).not.toContain("activity.queueCloudSync");
  });

  it("checks renderer trust on every DM request mutation", () => {
    for (const channel of ["acceptDm", "declineDm", "requestDmAgain"]) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain("assertTrustedSender(event);");
      expect(handler.indexOf("assertTrustedSender(event);"), channel).toBeLessThan(
        handler.indexOf(".parse(payload)"),
      );
    }
  });

  it("filters confirmed DMs from the ordinary received-channel lane", () => {
    const handler = handlerSource("listChatChannelShares");
    expect(handler).toContain("await resolveDmKinds({");
    expect(handler).toContain("shareIdsToWithholdFromOrdinaryInvites({");
    expect(handler).toContain("shareIdsClaimedElsewhere,");
  });

  // #640: the joined lane crosses IPC scoped to the channels the caller
  // named. The registry array grows with every channel this workspace has
  // ever joined, so a handler that answered it whole would put that history
  // in the response — the growth the deleted join gate used to bound.
  it("answers the joined lane only for the channels the caller named", () => {
    // listJoinedSharedChannels goes through the shared factory, whose scoping
    // is pinned BEHAVIOURALLY in mainChatIpcHandlers.test.ts — a source pin
    // cannot observe a response size. This one covers the wiring.
    expect(handlerSource("listJoinedSharedChannels")).toContain(
      "answerJoinedChannels: joinedChannelAnswers",
    );
    const listing = handlerSource("listChatChannelShares");
    expect(listing).toContain("joinedChannelAnswers(");
    expect(listing).toContain("input.channelWireIds");
    // And the scope is a required argument of the one projection, so a third
    // caller cannot answer the lane without naming one.
    expect(mainSource).toContain(
      "function joinedChannelAnswers(workspaceId: string, channelWireIds: readonly string[])",
    );
    // The write gate is unaffected: it reads the WHOLE registry array, in
    // main, and never crosses IPC at all.
    expect(mainSource).toContain(
      "sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,",
    );
  });

  // #627 deleted the read-only chat plumbing because these five handlers sit
  // behind requireEngineCapture, which throws for share views. That gate is
  // now the only barrier between a share view and their full read/write
  // paths, so its position is pinned: capture first, stores and sync after.
  it("acquires the Chats engine capture before any store or sync seam", () => {
    const gated = [
      "listChatChannels",
      "listChatFollows",
      "listPersonalChatFeed",
      "markPersonalChatFeedSeen",
      "syncDms",
    ];

    for (const channel of gated) {
      const handler = handlerSource(channel);
      const captureAt = handler.indexOf("await requireEngineCapture(");
      expect(captureAt, channel).toBeGreaterThan(-1);
      const captureCall = handler.slice(captureAt, handler.indexOf(");", captureAt));
      expect(captureCall, channel).toContain('"Chats"');

      const seamAts = ["linkedChatStoreFor(", "syncWorkspaceSharedChannels("]
        .map((seam) => handler.indexOf(seam))
        .filter((at) => at >= 0);
      expect(seamAts.length, channel).toBeGreaterThan(0);
      expect(Math.min(...seamAts), channel).toBeGreaterThan(captureAt);
    }
  });
});
