import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const dmRequestsSource = readFileSync(
  new URL("./workspaces/dmRequests.ts", import.meta.url),
  "utf8",
);
const databaseIpcSource = readFileSync(
  new URL("./ipc/workspaceDatabaseIpc.ts", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

function handlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (markerAt < 0 || start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

function databaseHandlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = databaseIpcSource.indexOf(marker);
  const start = databaseIpcSource.lastIndexOf(
    "dependencies.registerHandler(",
    markerAt,
  );
  if (markerAt < 0 || start < 0) {
    throw new Error(`Missing database IPC handler for ${channel}`);
  }
  const next = databaseIpcSource.indexOf(
    "dependencies.registerHandler(",
    markerAt + marker.length,
  );
  return databaseIpcSource.slice(start, next < 0 ? undefined : next);
}

describe("main-process chat authorization", () => {
  it("routes every main chat acquisition through the Rust-only factory", () => {
    const factoryStart = mainSource.indexOf("function linkedChatStoreFor(");
    const factoryEnd = mainSource.indexOf(
      "\nfunction agentDispatchStoreHandleFor(",
      factoryStart,
    );
    const factory = mainSource.slice(factoryStart, factoryEnd);

    expect(factoryEnd).toBeGreaterThan(factoryStart);
    expect(factory).toContain("const lease = ownsLease");
    expect(factory).toContain("attachmentId: binding.attachmentId");
    expect(factory).toContain("receivedShareEngine.workspaceForRegistered({");
    expect(factory).toContain("workspaceAuthorities.withBinding(binding");
    expect(factory).toContain("createDesktopLinkedChatStore(engineWorkspace, {");
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
    // These handlers write into the WORKSPACE, and a share view is not a
    // writable workspace — before #646 PR2 and after it. The four handlers a
    // file share now reaches are gated by a LEVEL instead, and are pinned
    // separately below; nothing here lost its gate.
    const guardedMutations = [
      "saveChatBookmark",
      "archiveChatBookmark",
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
    expect(handlerSource("createChatChannel")).toContain(
      "assertWritable: ({ workspace }) => assertWritableWorkspace(workspace),",
    );
  });

  // A received file share can read the chat about its files, but Phase 3 has
  // no durable per-row relay receipt. Every generic mutation is therefore
  // refused before its first store call, whatever the grant says.
  it("gates every received-share chat mutation before any store call", () => {
    const levelGated = [
      "createFileChat",
      "sendChatMessage",
      "resolveChatDecision",
    ];

    for (const channel of levelGated) {
      const handler = handlerSource(channel);
      const scopeAt = handler.indexOf("await requireChatScope(");
      const gateAt = handler.indexOf("assertChatWritable(scope);");
      expect(scopeAt, channel).toBeGreaterThan(-1);
      expect(gateAt, `${channel}: MUTATION: an ungated received-share mutation`)
        .toBeGreaterThan(scopeAt);
      const storeAt = handler.search(/\bstore\./u);
      expect(storeAt, channel).toBeGreaterThan(-1);
      expect(storeAt, `${channel}: the gate must precede the store`).toBeGreaterThan(gateAt);
    }

    // setChatReaction goes through the shared factory, which runs its gate
    // between requireContext and run.
    expect(handlerSource("setChatReaction")).toContain("createSetChatReactionIpcHandler({");
    expect(handlerSource("setChatReaction")).toContain("requireContext: requireChatScope,");
    expect(handlerSource("setChatReaction")).toContain("assertWritable: assertChatWritable,");

    // markChatThreadRead is deliberately UNGATED and must stay that way: read
    // state is the reader's own, written locally and never replicated, so a
    // view recipient who read the discussion can stop it showing as unread.
    // The operation-specific factory has no durable-write gate dependency.
    expect(handlerSource("markChatThreadRead")).toContain(
      "createMarkChatThreadReadIpcHandler({",
    );
    expect(handlerSource("markChatThreadRead")).toContain("requireContext: requireChatScope,");
    expect(handlerSource("markChatThreadRead")).not.toContain(
      "assertSharedChannelWritable",
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
    expect(handler).toContain("revalidateChatWrite(workspace, target, authorUserId");
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
        "revalidateChatWrite(workspace, target, authorUserId",
      );
    }
  });

  it("returns the new thread viewer identity from main-owned state", () => {
    const handler = handlerSource("startChannelThread");
    expect(handler).toContain(
      "started.message.authorUserId ?? localReactorFallbackId()",
    );
    expect(handler).not.toContain("input.viewerAuthorId");
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
    const enableSync = handlerSource("cloudEnableSync");
    expect(enableSync).toContain("assertWritableWorkspace(workspace);");
    expect(enableSync).toContain("workspaceId: workspace.workspaceId");
    expect(enableSync).toContain("attachmentId: workspace.attachmentId");
    expect(enableSync).not.toContain("remoteWorkspaceId");

    const joinWorkspace = handlerSource("cloudJoinWorkspace");
    expect(joinWorkspace).not.toContain("remoteWorkspaceId");
  });

  it("uses the registry workspace coordinate for cloud collaboration", () => {
    const presenceStart = mainSource.indexOf(
      "async function presenceRelayTransportForScope(",
    );
    const presenceEnd = mainSource.indexOf(
      "async function presenceRelayTransportForWindow(",
      presenceStart,
    );
    const presence = mainSource.slice(presenceStart, presenceEnd);
    expect(presence).toContain("workspaceId: entry.workspaceId");

    for (const channel of ["createRelayShare", "shareChatChannel", "startDm"]) {
      expect(handlerSource(channel), channel).toContain(
        "/sync/${encodeURIComponent(workspace.workspaceId)}/shares",
      );
    }

    for (const channel of [
      "listShareProposals",
      "readShareProposalChanges",
      "readShareProposalFileContent",
      "settleShareProposal",
    ]) {
      expect(handlerSource(channel), channel).toContain(
        "workspaceId: scope.workspaceId",
      );
    }
  });

  it("admits renderer workspace requests through one exact physical operation", () => {
    for (const channel of [
      "createRelayShare",
      "shareChatChannel",
      "listChatChannelShares",
      "joinSharedChannel",
      "leaveSharedChannel",
      "dismissShareSkips",
      "cloudEnableSync",
      "listChatChannels",
      "syncDms",
      "acceptDm",
      "leaveDm",
      "startDm",
    ]) {
      const handler = handlerSource(channel);
      const admissionAt = handler.indexOf("withRendererWorkspaceOperation(");
      expect(admissionAt, channel).toBeGreaterThan(-1);
      expect(
        Math.max(
          handler.indexOf("operation.workspace"),
          handler.indexOf("endWorkspaceJoinedChannel(operation"),
        ),
        channel,
      ).toBeGreaterThan(
        admissionAt,
      );
      expect(handler, channel).not.toContain(
        "requireWorkspace(input.workspaceId)",
      );
      expect(handler, channel).not.toContain(
        "findWorkspace(input.workspaceId)",
      );
      expect(handler, channel).not.toContain(
        "requireEngineCapture(input.workspaceId",
      );
    }

    const joined = handlerSource("listJoinedSharedChannels");
    expect(joined).toContain("withWorkspaceOperation:");
    expect(joined).toContain("withRendererWorkspaceOperation(");

    const mountRegistration = mainSource.slice(
      mainSource.indexOf("registerShareMountIpcHandlers({"),
      mainSource.indexOf("registerShareMountIpcHandlers({") + 1_200,
    );
    expect(mountRegistration).toContain("withWorkspaceOperation:");
    expect(mountRegistration).toContain("withRendererWorkspaceOperation(");
    expect(mountRegistration).not.toContain("requireWorkspace,");
  });

  it("revalidates owner agent-message authorship after the authorization await", () => {
    const start = mainSource.indexOf("authorizeServiceNote: (");
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
      handler.indexOf("relayShareJsonWithCredentials<{ shareId: string }>("),
    );
  });

  it("projects pending chat bookmarks immediately after workspace and shared-channel pulls", () => {
    expect(mainSource).toMatch(
      /afterSuccessfulPull:\s*\(\)\s*=>\s*withWorkspaceAttachmentAsync\(\s*workspace,\s*\(\)\s*=>\s*projectPendingChatBookmarksAfterPull\(workspace\.workspaceId\)/,
    );
    expect(mainSource).toContain(
      "await projectPendingChatBookmarksAfterPull(workspaceId);",
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
    const helperStart = mainSource.indexOf(
      "function reserveAndPullSharedChannelForWorkspace(",
    );
    const helperEnd = mainSource.indexOf(
      "ipcMain.handle(CHANNELS.listChatChannelShares",
      helperStart,
    );
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = mainSource.slice(helperStart, helperEnd);
    expect(helper).toContain("return reserveAndPullSharedChannel({");
    expect(helper).toContain("operation: DesktopRendererWorkspaceOperation;");
    expect(helper).toContain(
      "const assertCurrent = input.assertCurrent ?? input.operation.assertCurrent;",
    );
    expect(helper).toContain("assertCurrent();");
    expect(helper).toContain("setWorkspaceSharedChannels(workspaceId, channels);");
    expect(helper).toContain("serialize: (workspaceId, run) =>");
    expect(helper).toContain(
      "{ state: input.operation.state, assertCurrent },",
    );
    expect(helper).not.toContain("workspaceAuthorities.withAuthority(");
    for (const [label, source] of [
      ["joinSharedChannel", handlerSource("joinSharedChannel")],
      ["acceptDm", handlerSource("acceptDm")],
    ] as const) {
      expect(source, label).toContain(
        "reserveAndPullSharedChannelForWorkspace({",
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
    expect(mainSource).toContain("serializeWorkspaceAuthorityWork(lease, () =>");
    expect(mainSource).toContain(
      "serializeWorkspaceAuthorityWork(operation, () =>",
    );

    const serializeAt = dmRequestsSource.indexOf("await input.serialize(");
    const pullAt = dmRequestsSource.indexOf("await input.pull({");
    expect(serializeAt).toBeGreaterThan(-1);
    expect(pullAt).toBeGreaterThan(serializeAt);
  });

  it("keeps received DMs as requests until acceptDm chooses a workspace", () => {
    const sync = handlerSource("syncDms");
    expect(sync).toContain("return classifyDmRequests({");
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
    const exclusivityAt = handler.indexOf("assertShareNotHeldElsewhere(");
    const credentialsAt = handler.indexOf("await warmCredentialCache()");
    const reserveAt = handler.indexOf(
      "reserveAndPullSharedChannelForWorkspace({",
    );
    expect(exclusivityAt).toBeGreaterThan(-1);
    expect(exclusivityAt).toBeLessThan(credentialsAt);
    expect(
      handler.match(/assertShareNotHeldElsewhere\(/gu),
    ).toHaveLength(3);
    const assertionStart = mainSource.indexOf(
      "function assertShareNotHeldElsewhere(",
    );
    const assertionEnd = mainSource.indexOf(
      "function reserveAndPullSharedChannelForWorkspace(",
      assertionStart,
    );
    expect(assertionStart).toBeGreaterThan(-1);
    expect(assertionEnd).toBeGreaterThan(assertionStart);
    const assertion = mainSource.slice(assertionStart, assertionEnd);
    expect(assertion).toContain(
      "otherWorkspaceHoldingShare(shareId, workspaceId)",
    );
    expect(assertion).toContain(
      "This conversation already lives in ${workspaceName}. Open that workspace to continue.",
    );
    expect(handler).toContain("if (!acceptedHere)");
    expect(reserveAt).toBeGreaterThan(credentialsAt);
    expect(handler).toContain("workspaceId: workspace.workspaceId");
    const preWriteAt = handler.indexOf("preWrite: (info) => {");
    expect(preWriteAt).toBeGreaterThan(reserveAt);
    expect(handler.slice(preWriteAt)).toContain("operation.assertCurrent();");
    expect(handler.slice(preWriteAt)).toContain(
      "assertShareNotHeldElsewhere(\n                  input.shareId,\n                  workspace.workspaceId,",
    );
    expect(handler).not.toContain("activity.queueCloudSync");
  });

  it("keeps the reservation row's placement true after a non-share-unavailable pull failure", () => {
    const handler = handlerSource("acceptDm");
    const catchAt = handler.indexOf("} catch (error) {");
    const catchEnd = handler.indexOf(
      "\n        }\n\n        operation.assertCurrent();",
      catchAt,
    );
    expect(catchAt).toBeGreaterThan(-1);
    expect(catchEnd).toBeGreaterThan(catchAt);
    const catchBlock = handler.slice(catchAt, catchEnd);
    const shareUnavailableAt = catchBlock.indexOf(
      "if (error instanceof ShareUnavailableError)",
    );
    const placementCheckAt = catchBlock.indexOf(
      "!isShareAcceptedInWorkspace(",
    );
    const rethrowAt = catchBlock.indexOf("throw error;");

    expect(shareUnavailableAt).toBeGreaterThan(-1);
    expect(placementCheckAt).toBeGreaterThan(shareUnavailableAt);
    expect(rethrowAt).toBeGreaterThan(placementCheckAt);
    expect(catchBlock).toContain(
      "operation.workspace.sharedChannels ?? [],\n                input.shareId,",
    );
    expect(catchBlock).not.toContain("findWorkspace(");
  });

  it("keeps accepted DMs in syncDms when the declined-request store is unreadable", () => {
    const handler = handlerSource("syncDms");
    const classifyAt = handler.indexOf("classify: async () => {");
    const listAcceptedAt = handler.indexOf("const dms = await listDmRecords({");
    const resultAt = handler.indexOf("return SyncDmsResult.parse({");
    expect(handler).toContain(
      "declinedShareIds: readDeclinedDms(dmRequestFile())",
    );
    expect(classifyAt).toBeGreaterThan(-1);
    expect(listAcceptedAt).toBeGreaterThan(classifyAt);
    expect(resultAt).toBeGreaterThan(listAcceptedAt);
    expect(handler.slice(resultAt)).toContain("dms: withholdDmsInRequestLanes({");
    expect(handler.slice(resultAt)).toContain("}).map(dmRecordForIpc)");
  });

  // #742 P1-A / round 4 / round 6: without this, a DM whose row Leave just
  // ended stays visible in BOTH `dms` (listDmRecords' readable-tombstone
  // row, connected:false) and a request lane (classifyDmRequests re-listing
  // it) OR held live by another workspace under the SAME shareId or the
  // SAME channelWireId (a re-grant mints a new shareId — round 6) — the
  // same conversation shown twice either way. requestShareIds is keyed off
  // pending AND declined; both holder snapshots are derived AFTER classify
  // resolves (dmRequests.ts's own executing tests cover the filter's actual
  // arithmetic and the stale-snapshot risk in detail — this pin only checks
  // main.ts wires the pieces in the right order).
  it("wires the withhold call with request lanes AND post-classify share/wire holder snapshots", () => {
    const handler = handlerSource("syncDms");
    const classifyAt = handler.indexOf("classify: async () => {");
    const requestShareIdsAt = handler.indexOf("const requestShareIds = new Set(");
    const holdersAt = handler.indexOf(
      "const holdersByShareId = liveSharedChannelHoldersByShareId(",
    );
    const holdersByWireAt = handler.indexOf(
      "const holdersByWireId = liveSharedChannelHoldersByWireId(",
    );
    const withholdAt = handler.indexOf("dms: withholdDmsInRequestLanes({");
    expect(classifyAt).toBeGreaterThan(-1);
    expect(requestShareIdsAt).toBeGreaterThan(classifyAt);
    expect(holdersAt).toBeGreaterThan(requestShareIdsAt);
    expect(holdersByWireAt).toBeGreaterThan(holdersAt);
    expect(withholdAt).toBeGreaterThan(holdersByWireAt);
    expect(handler.slice(requestShareIdsAt, withholdAt)).toContain(
      "[...pending, ...declined].map((row) => row.shareId)",
    );
    expect(handler.slice(withholdAt)).toContain("requestShareIds,");
    expect(handler.slice(withholdAt)).toContain("holdersByShareId,");
    expect(handler.slice(withholdAt)).toContain("holdersByWireId,");
    expect(handler.slice(withholdAt)).toContain(
      "workspaceId: workspace.workspaceId,",
    );
  });

  // #742 P1 (rounds 3–4): the fallback/staleness ARITHMETIC now has real
  // executing coverage (classifyDmRequestsWithFallback /
  // createLastKnownDmRequestLanesCache in dmChats.test.ts, per the #737
  // precedent for anything main.ts cannot be imported to exercise directly).
  // This pin only checks main.ts's WIRING: syncDms routes classify through
  // the attachment-owned fallback cache, keyed per workspace inside that
  // state, and guarded by the credential generation.
  it("routes syncDms's classify through the attachment cache and generation guard", () => {
    const handler = handlerSource("syncDms");
    expect(handler).toContain("await classifyDmRequestsWithFallback({");
    expect(handler).toContain("workspaceId: workspace.workspaceId,");
    expect(handler).toContain(
      "cache: operation.state.lastKnownDmRequestLanes,",
    );
    expect(handler).toContain(
      "credentialGeneration: () => credentialCacheGeneration,",
    );
    expect(mainSource).toContain(
      "lastKnownDmRequestLanes: createLastKnownDmRequestLanesCache(),",
    );
    expect(mainSource).not.toContain(
      "const lastKnownDmRequestLanes = createLastKnownDmRequestLanesCache();",
    );
  });

  it("keeps startDm grant rollback outside the post-await currentness check", () => {
    const handler = handlerSource("startDm");
    const createGrantAt = handler.indexOf("createGrant: async (email) => {");
    const revokeGrantAt = handler.indexOf("revokeGrant: async (shareId) => {");
    expect(createGrantAt).toBeGreaterThan(-1);
    expect(revokeGrantAt).toBeGreaterThan(createGrantAt);
    const createGrant = handler.slice(createGrantAt, revokeGrantAt);
    expect(createGrant).toContain("assertCurrentDmSession();");
    expect(createGrant).toContain("relayShareJsonWithCredentials<{");
    expect(createGrant).not.toContain("awaitCurrentDmSession(");
    expect(handler).toContain("assertCurrent: assertCurrentDmSession,");
  });

  // #742 P1 SECURITY (rounds 4–5): a NEW account's first failed poll must
  // never be served the PREVIOUS account's cached request rows, sender
  // emails included. Every session transition that clears the credential
  // cache also clears the DM lanes cache — centralized INSIDE
  // clearCachedCredentials() itself (round 5), not duplicated at each of its
  // three call sites, so login adoption, logout, AND a current-session 401
  // (round 5: also a real session end — main's own comment above it says so)
  // can never bypass it by routing around the shared function.
  it("clears the DM request-lanes cache from inside clearCachedCredentials, and every session-transition site routes through it", () => {
    const clearFnStart = mainSource.indexOf(
      "function clearCachedCredentials(): void {",
    );
    const clearFnEnd = mainSource.indexOf("\n}", clearFnStart);
    expect(clearFnStart).toBeGreaterThan(-1);
    expect(clearFnEnd).toBeGreaterThan(clearFnStart);
    expect(mainSource.slice(clearFnStart, clearFnEnd)).toContain(
      "lease.state.lastKnownDmRequestLanes.clear();",
    );
    expect(mainSource.slice(clearFnStart, clearFnEnd)).toContain(
      "peekedReceivedGrantKinds.clear();",
    );

    // Every session-transition site calls the shared function — none
    // inlines its own credentialSessionCache.clear() that would bypass it.
    const sites = mainSource.match(/clearCachedCredentials: \(\) => [^\n]+/gu) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const site of sites) {
      expect(site).toBe("clearCachedCredentials: () => clearCachedCredentials(),");
    }
  });

  it("checks renderer trust on every DM request mutation", () => {
    for (const channel of ["acceptDm", "declineDm", "requestDmAgain", "leaveDm"]) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain("assertTrustedSender(event);");
      expect(handler.indexOf("assertTrustedSender(event);"), channel).toBeLessThan(
        handler.indexOf(".parse(payload)"),
      );
    }
  });

  // #742: the DM surface's leave control must end the SAME row
  // leaveSharedChannel ends — a parallel ending mechanism (e.g. deleting the
  // row, or writing its own "ended" field by hand) would drift from the
  // reversibility contract endJoinedChannel and its tests already prove.
  it("ends a DM's registry row through the same mechanism leaveSharedChannel uses", () => {
    const helperStart = mainSource.indexOf(
      "function endWorkspaceJoinedChannel(",
    );
    const helperEnd = mainSource.indexOf(
      "ipcMain.handle(CHANNELS.leaveSharedChannel",
      helperStart,
    );
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = mainSource.slice(helperStart, helperEnd);
    expect(helper).toContain(
      "endJoinedChannel(workspace.sharedChannels ?? [], shareId)",
    );
    expect(helper).toContain("setWorkspaceSharedChannels(");

    const leaveShared = handlerSource("leaveSharedChannel");
    const leaveDm = handlerSource("leaveDm");
    for (const [label, handler] of [
      ["leaveSharedChannel", leaveShared],
      ["leaveDm", leaveDm],
    ] as const) {
      expect(handler, label).toContain(
        "endWorkspaceJoinedChannel(operation, input.shareId);",
      );
      // Neither handler duplicates the ending logic inline.
      expect(handler, label).not.toContain("endJoinedChannel(");
      expect(handler, label).not.toContain("ended: true");
    }
  });

  // #742 P1 (round 5): the fallback cache's own arithmetic (seed/overwrite/
  // idempotent-insert) has real executing coverage in dmChats.test.ts, per
  // the #737 precedent. This pin only checks main.ts's WIRING: leaveDm reads
  // the row's granterEmail BEFORE ending it (endJoinedChannel only flips
  // `ended`, so the row itself still carries it either way, but reading
  // first keeps the intent obvious) and records the leave in the SAME cache
  // syncDms falls back to.
  it("records a locally-known leave in the last-known lanes cache", () => {
    const handler = handlerSource("leaveDm");
    const leftRowAt = handler.indexOf("const leftRow = (");
    const endAt = handler.indexOf(
      "endWorkspaceJoinedChannel(operation, input.shareId);",
    );
    const markAt = handler.indexOf("markLeftInLastKnownLanes(");
    expect(leftRowAt).toBeGreaterThan(-1);
    expect(endAt).toBeGreaterThan(leftRowAt);
    expect(markAt).toBeGreaterThan(endAt);
    expect(handler.slice(markAt)).toContain(
      "operation.state.lastKnownDmRequestLanes,",
    );
    expect(handler.slice(markAt)).toContain(
      "granterEmail: leftRow?.granterEmail ?? null,",
    );
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
      "function joinedChannelAnswers(\n    workspace: RegistryEntry,",
    );
    // The write gate is unaffected: it reads the WHOLE registry array, in
    // main, and never crosses IPC at all.
    expect(mainSource).toContain(
      "sharedChannels: findWorkspace(workspace.workspaceId)?.sharedChannels,",
    );
  });

  // #627 deleted the read-only chat plumbing because these five handlers sit
  // behind requireEngineCapture, which throws for share views. They are the
  // WORKSPACE-WIDE surfaces: every channel and every file thread in one
  // response. #646 PR2 does not route them to a share view at all — filtering
  // a workspace-wide listing is the shape that produced #627, and not routing
  // it is smaller and safer — so their gate is unchanged and still pinned:
  // capture first, stores and sync after.
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

  // The same property, restated for the handlers a share view DOES reach
  // (#646 PR2). `requireChatScope` replaced `requireEngineCapture` as the
  // barrier on exactly these seven, and its position is what the #627 pin
  // above was really protecting: nothing touches a store or a sync seam
  // before the scope is resolved.
  it("resolves the chat scope before any store or sync seam on every share-reachable handler", () => {
    const shareReachable = [
      "listFileChats",
      "listChatMessages",
      "getChatThreadRevision",
      // The panel loads messages and reactions TOGETHER, so this one is part
      // of opening a thread at all, not a separate nicety.
      "listChatReactions",
      "markChatThreadRead",
      "createFileChat",
      "sendChatMessage",
      "setChatReaction",
      "resolveChatDecision",
    ];

    for (const channel of shareReachable) {
      const handler = handlerSource(channel);
      const scopeAt = Math.max(
        handler.indexOf("await requireChatScope("),
        handler.indexOf("requireContext: requireChatScope,"),
      );
      expect(scopeAt, `${channel}: MUTATION: a store call before the scope has no gate at all`)
        .toBeGreaterThan(-1);
      // A factory-built handler resolves its context inside the factory, so
      // its seams sit in a `run` callback that always follows the dep object.
      const seamAts = ["store.", "syncWorkspaceSharedChannels("]
        .map((seam) => handler.indexOf(seam))
        .filter((at) => at >= 0);
      expect(seamAts.length, channel).toBeGreaterThan(0);
      expect(Math.min(...seamAts), channel).toBeGreaterThan(scopeAt);
      // And none of them may fall back to the capture gate, which throws for
      // every share view.
      expect(handler, `${channel}: requireEngineCapture refuses every share view`)
        .not.toContain("requireEngineCapture(");
    }
  });

  // The scope keeps the relay-derived fact for the banner's next step, but
  // main never treats that cached fact as mutation authority.
  it("keeps received-share chat metadata without using it as write authority", () => {
    const scopeAt = mainSource.indexOf("async function requireChatScope(");
    const scope = mainSource.slice(scopeAt, mainSource.indexOf("\n  }", scopeAt));
    expect(scope).toContain('requireEngineCapture(workspaceId, "Chats")');
    // PRESENCE decides whether this is a share at all, and it is the same
    // question main asks before a write. A marker that lost its value is
    // still a share view; resolving a capture for it would hand someone
    // else's workspace the local chat surface.
    expect(
      scope,
      "MUTATION: a truthiness read makes a damaged marker an ordinary workspace",
    ).toContain("shareViewIsPresent(workspace.shareView)");
    // The level comes from the PINNED grant, read back through the SAME
    // function the refresh path uses, so this gate and the pull cannot
    // disagree about what a share grants. Reading the raw field would accept
    // a grant that is damaged anywhere except its access value.
    expect(scope).toContain("readableShareLevel(workspace.shareView?.grantedSelector)");
    expect(scope).not.toContain("grantedSelector.access");
    // Never from a renderer payload or a relay answer read at call time.
    expect(scope).not.toContain("input.access");
    expect(scope).toContain(
      "genericChatWritable: workspace.shareView?.genericChatWritable === true",
    );

    // Every received share is refused unconditionally: no cached relay fact
    // (level, generic-chat capability) may reopen a write.
    const gateAt = mainSource.indexOf("function assertChatWritable(");
    const gate = mainSource.slice(gateAt, mainSource.indexOf("\n  }", gateAt));
    expect(gate).toContain(
      'throw new SharedFileReadOnlyError("Chats are read-only in this shared view.")',
    );
    expect(
      gate,
      "MUTATION: cached generic chat authority reopened received-share writes",
    ).not.toMatch(/scope\.(access|genericChatWritable|ended)/u);
    expect(scope).not.toContain("resolveShareViewRelayAuthorId(");
  });

  it("keeps share chat stores and file-index reads on one exact engine attachment", () => {
    const scopeAt = mainSource.indexOf("async function requireChatScope(");
    const scopeEnd = mainSource.indexOf(
      "\n  async function recordShareViewIdentity(",
      scopeAt,
    );
    const scope = mainSource.slice(scopeAt, scopeEnd);
    expect(scopeEnd).toBeGreaterThan(scopeAt);
    expect(scope).toContain("workspaceAuthorities.withAuthority(workspaceId");
    expect(scope).toContain("const workspace = canonicalWorkspaceFor(lease);");
    expect(scope).toContain("attachmentId: binding.attachmentId");
    expect(scope).toContain("store: linkedChatStoreFor(lease)");
    expect(scope).toContain("workspaceAuthorities.withBinding(binding");

    const fileObjectAt = mainSource.indexOf("async function chatFileObjectId(");
    const fileObjectEnd = mainSource.indexOf(
      "\n  async function requireVersionOperations(",
      fileObjectAt,
    );
    const fileObject = mainSource.slice(fileObjectAt, fileObjectEnd);
    expect(fileObjectEnd).toBeGreaterThan(fileObjectAt);
    expect(fileObject).toContain("await scope.withAuthority(");
    expect(fileObject).toContain("activeEngineFileIndex(scope.engineWorkspace)");

    const indexAt = mainSource.indexOf("async function engineSearchIndexFor(");
    const indexEnd = mainSource.indexOf(
      "\nasync function activeEngineFileIndex(",
      indexAt,
    );
    const index = mainSource.slice(indexAt, indexEnd);
    expect(indexEnd).toBeGreaterThan(indexAt);
    expect(index).toContain("withWorkspaceAttachmentAsync(workspace");
    expect(index).toContain("engineWorkspaceForAuthority(lease)");

    expect(mainSource).not.toContain("async function pushShareViewChat(");
    expect(mainSource).not.toContain(".pushShareView({");
  });

  it("holds the new shared view authority through identity recording", () => {
    const handler = handlerSource("openSharedView");
    expect(handler).toMatch(
      /workspaceAuthorities\s*\.withBinding\(\s*authorityBinding,\s*\(lease\) =>\s*recordShareViewIdentity\(canonicalWorkspaceFor\(lease\)\),\s*\)/,
    );
    expect(handler).not.toContain(
      "rootPath: authorityBinding.canonicalRootPath",
    );
  });

  // #874: the rebuild moves a workspace's engine database aside. Main must
  // derive the refusal from its OWN activity status. A renderer that can
  // trigger the move on a HEALTHY store would silently detach the workspace's
  // history and chats. engineStoreRebuild.test.ts behavior-tests ordering.
  it("gates the engine-store rebuild on main's own refusal fact", () => {
    const handler = handlerSource("rebuildEngineStore");
    const gateAt = handler.indexOf("assertWritableWorkspace(registered);");
    expect(gateAt).toBeGreaterThan(-1);
    expect(handler.indexOf("await ")).toBeGreaterThan(gateAt);
    expect(handler).toContain("isStoreRefused: () =>");
    expect(handler).toContain(
      "activity.getStatus(workspace.workspaceId).engineStoreRefused",
    );
  });

  // The write gate's own shape, pinned where it is defined. Same split as
  // `assertChatWritable` above: main DELEGATES the level rule, and the rule's
  // behaviour is driven against the REAL function in shareWriteGate.test.ts.
  // A source pin proves position, never behaviour.
  it("keeps the workspace write boundary on PRESENCE, and the level only where the write is routed", () => {
    const gateAt = mainSource.indexOf("function assertWritableWorkspace(");
    const gate = mainSource.slice(
      gateAt,
      mainSource.indexOf("function assertAgentRunnableWorkspace(", gateAt),
    );
    expect(gateAt).toBeGreaterThan(-1);
    // The ordinary write gate asks ONE rule, and that rule cannot see a
    // level. What it decides is driven behaviourally in
    // `workspaces/shareWriteGate.test.ts`.
    expect(gate).toContain("workspaceWriteRefusal(findWorkspace(workspace.workspaceId)?.shareView)");
    expect(
      gate,
      "MUTATION: a level test here opens 27 handlers on an edit share view at once",
    ).not.toContain("shareViewTakesLocalWrites(");
    expect(gate).not.toContain('access !== "view"');
    expect(gate).not.toContain('=== "edit"');

    // And `sharedViewOf` still answers PRESENCE for every caller that asks
    // only whether this is a share view — agent runs, site previews, the
    // dispatch scan. Widening it to a level test would make an edit share view
    // an ordinary workspace on all of them at once.
    const resolverAt = mainSource.indexOf("function sharedViewOf(");
    const resolver = mainSource.slice(
      resolverAt,
      mainSource.indexOf("function assertWritableWorkspace(", resolverAt),
    );
    expect(
      resolver,
      "MUTATION: a truthiness read makes a damaged marker an ordinary workspace",
    ).toContain("if (!shareViewIsPresent(entry.shareView)) return null;");
    expect(resolver).toContain("readableShareLevel(marker.grantedSelector)");
    expect(resolver).toContain("ended: marker.ended === true");

    // The received-share owner asks the same rule after resolving the current
    // registry target. A share view has no watcher, so a save routed to disk
    // alone would leave the recipient nothing to send.
    const shareViewFiles = readFileSync(
      new URL("./workspaces/shareViewFiles.ts", import.meta.url),
      "utf8",
    );
    expect(
      shareViewFiles,
      "MUTATION: a second copy of the level rule is a copy that drifts",
    ).toContain("!shareViewTakesLocalWrites({");
  });

  // The menu is a UX MIRROR of the gates below it, and it has to mirror the
  // SAME rule they ask. Its SHAPE is decided by `explorerMenuEntries` and
  // driven at every level in `workspaces/explorerMenu.test.ts`; what this pins
  // is main's wiring — that the decision comes from there, over the registry's
  // own answer, and that main does not re-spell a level beside it.
  it("builds a shared view's explorer menu from the one rule, not from a level of its own", () => {
    const handler = handlerSource("showExplorerMenu");
    expect(handler).toContain(
      "const shareView = sharedViewOf(registryEntry.workspaceId);",
    );
    expect(handler).toContain("explorerMenuEntries({");
    expect(handler).toContain("shareView: menuContext.shareView,");
    expect(handler).toContain("exactRendererWorkspaceReferences.capture(");
    expect(handler).toContain("exactRendererWorkspaceReferences.withReference(");
    expect(
      handler,
      "MUTATION: a second copy of the level rule in main is a copy that drifts",
    ).not.toContain("shareViewTakesLocalWrites(");
    expect(handler).not.toContain('access === "edit"');
    // And the decision itself asks the shared rule rather than a level.
    const menu = readFileSync(
      new URL("./workspaces/explorerMenu.ts", import.meta.url),
      "utf8",
    );
    expect(menu).toContain("shareViewTakesLocalWrites(scope.shareView)");
    expect(
      menu,
      "MUTATION: a menu that reads the level directly stops agreeing with the handlers",
    ).not.toContain('access === "edit"');
  });

  // #646 PR3a. The review's incoming side is fetched by main and validated by
  // the bridge, and the two must state ONE bound. A larger guard here admits a
  // body the contract then refuses, which fails the whole response — every
  // file in the review, not just the large one. The contract half is driven
  // behaviourally in `ipc/bridgeContract.test.ts`.
  it("guards the review's incoming text at the bound the contract enforces", () => {
    const readerAt = mainSource.indexOf("async function shareProposalIncomingText(");
    const reader = mainSource.slice(readerAt, readerAt + 1600);
    expect(readerAt).toBeGreaterThan(-1);
    // The WHOLE guard, not a prefix of it: `> BOUND * 5` contains the same
    // constant name and would pass a looser match.
    expect(reader).toContain(
      "if (bytes.byteLength > WORKSPACE_TEXT_EDITOR_MAX_BYTES) return null;",
    );
    expect(
      reader,
      "MUTATION: the engine's 10 MiB bound admits a body the 2 MiB field refuses",
    ).not.toContain("ENGINE_TEXT_MAX_CHARS");
  });

  // #646 PR3. Which handlers sit behind the ordinary workspace write gate.
  //
  // This pin proves POSITION only. What the gate DECIDES is driven
  // behaviourally in `workspaces/shareWriteGate.test.ts`, which executes
  // `workspaceWriteRefusal` against a real edit-level registry marker and
  // asserts it refuses — the property that keeps every writer below closed on
  // a share view at every level. Position and decision together are the
  // claim; neither alone is.
  it("keeps each main-owned raw-disk writer and the plugin pipeline behind the workspace write gate", () => {
    // Each of these writes the workspace folder. A share view's folder is a
    // projection of its engine store, so a write here would leave content no
    // moment states. The next pull would overwrite it.
    const rawDiskWriters = [
      ["pickImageFiles", "operation.workspace"],
      ["importToDatabase", "operation.workspace"],
    ] as const;
    for (const [channel, workspace] of rawDiskWriters) {
      expect(handlerSource(channel), channel).toContain(
        `assertWritableWorkspace(${workspace});`,
      );
      expect(
        handlerSource(channel),
        `${channel}: MUTATION: a blanket-refused handler that reads the level is one the gate no longer covers`,
      ).not.toContain("if (shareView === null) assertWritableWorkspace(workspace);");
    }
    expect(databaseHandlerSource("applyDatabaseEdit")).toContain(
      "dependencies.assertWritableWorkspace(operation.workspace);",
    );

    // The plugin runtime installs and runs plugin code against the workspace
    // root, so its owner takes the same gate before it builds a record.
    const runtimeAt = mainSource.indexOf(
      "const pluginRuntimes = new PluginWorkspaceRuntimes<CreatedWorkspace>({",
    );
    expect(runtimeAt).toBeGreaterThan(-1);
    const runtime = mainSource.slice(runtimeAt, runtimeAt + 700);
    expect(
      runtime,
      "MUTATION: an ungated pipeline writes plugin state into someone else's workspace",
    ).toContain("assertWritable: assertWritableWorkspace,");

    // Import remains in main and routes received-share writes through the
    // same owner as before. WorkspaceFileMutationOwner behavior-tests the six
    // file handlers that no longer keep policy in main.
    const routedImport = handlerSource("importWorkspaceFiles");
    expect(
      routedImport,
      "MUTATION: an unrouted share view takes the blanket refusal and its write never becomes a change",
    ).toContain("if (!isShareView) {");
    expect(routedImport).toContain("assertWritableWorkspace(currentWorkspace);");
    expect(routedImport).toContain("await shareViewFiles.change(");
    expect(routedImport).toContain('kind: "import"');
    expect(routedImport).not.toContain(
      "shareViewTakesLocalWrites(",
    );
  });

  it("holds database and UI-state paths under exact renderer and physical authority", () => {
    const helpers = [
      ["getWorkspaceUiState", "await readUiStateFile(operation.workspace.rootPath)"],
      ["setWorkspaceUiState", "writeUiStateFile(operation.workspace.rootPath"],
    ] as const;

    for (const [channel, helper] of helpers) {
      const handler = handlerSource(channel);
      const operationAt = handler.indexOf("withRendererWorkspaceOperation(");
      const helperAt = handler.indexOf(helper);
      expect(operationAt, channel).toBeGreaterThan(-1);
      expect(helperAt, channel).toBeGreaterThan(operationAt);
      expect(handler, channel).not.toContain("requireWorkspace(input.workspaceId)");
    }

    const databaseRegistrationAt = mainSource.indexOf(
      "registerWorkspaceDatabaseIpcHandlers<",
    );
    const databaseRegistration = mainSource.slice(
      databaseRegistrationAt,
      databaseRegistrationAt + 2_500,
    );
    expect(databaseRegistrationAt).toBeGreaterThan(-1);
    expect(databaseRegistration).toContain("withRendererWorkspaceOperation(");
    expect(databaseRegistration).toContain("editWorkspaceDatabaseInWorker({");
    expect(databaseRegistration).toContain("rootPath: operation.workspace.rootPath,");
    expect(databaseHandlerSource("applyDatabaseEdit")).toContain(
      "ApplyDatabaseEditPayload.parse(payload)",
    );
    const uiStateHandler = handlerSource("getWorkspaceUiState");
    expect(uiStateHandler).toContain("WorkspaceIdPayload.parse(payload)");
    expect(uiStateHandler).not.toContain(
      "ListWorkspaceFilesPayload.parse(payload)",
    );
  });

  // #646 PR3a. Two lanes, and a workspace is only ever in one of them. The
  // rules live in shareProposals.ts and are driven behaviourally there; this
  // pin covers main's wiring — that both lanes go through them, and that
  // neither takes a share id from the renderer.
  it("wires share-change authorization and the submit guard in source order", () => {
    const granterLane = [
      "listShareProposals",
      "readShareProposalChanges",
      "readShareProposalFileContent",
      "settleShareProposal",
    ];
    for (const channel of granterLane) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain("withShareProposalGranterOperation(");
      expect(handler, `${channel}: a share view is never the granter`).not.toContain(
        "withShareProposalRecipientOperation(",
      );
    }
    expect(mainSource).not.toContain("function requireShareProposalGranter(");
    expect(mainSource).not.toContain("function openShareProposals(");

    const recipientLane = ["submitShareChanges", "listMyShareChanges", "withdrawShareChanges"];
    for (const channel of recipientLane) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain("withShareProposalRecipientOperation(");
      expect(handler, `${channel}: shareId: input.` ).not.toContain("shareId: input.");
    }

    const granterAt = mainSource.indexOf(
      "function withShareProposalGranterOperation<Result>(",
    );
    const granter = mainSource.slice(
      granterAt,
      mainSource.indexOf(
        "function withShareProposalRecipientOperation<Result>(",
        granterAt,
      ),
    );
    expect(
      granter,
      "MUTATION: a share view accepting its own changes writes into someone else's workspace",
    ).toContain("assertShareProposalGranter(workspace.shareView)");

    // Which rule each recipient channel asks for. Sending needs the edit
    // level; seeing and taking back what was already sent need membership
    // only, because a reverse path a downgrade removes is not one. Both rules
    // are driven behaviourally in `workspaces/shareProposals.test.ts`.
    const submit = handlerSource("submitShareChanges");
    expect(
      submit,
      "MUTATION: an ungated submit sends a view recipient's edits to the granter",
    ).toContain("requireShareViewProposalScope,");
    for (const channel of ["listMyShareChanges", "withdrawShareChanges"]) {
      expect(handlerSource(channel), channel).toContain("requireShareViewMembership,");
    }
    // The grant that leaves this machine is the PINNED one the scope resolved,
    // never a selector the renderer stated.
    expect(submit).toContain(
      "grantedSelector: scope.grant,",
    );
    expect(
      submit,
      "MUTATION: submitting without a final disk capture drops edits made after the last refresh",
    ).toContain("const reconciled = await withStaleSensitiveWorkspaceOperation(");
    expect(submit).toContain("shareViewFiles.reconcile(");
    expect(submit).toContain("workspaceId: beforeReconcile.workspaceId,");
    expect(submit).toContain('"settle",');
    const schedulerAt = submit.indexOf(
      "const reconciled = await withStaleSensitiveWorkspaceOperation(",
    );
    const reconcileAt = submit.indexOf("shareViewFiles.reconcile(");
    const refusalAt = submit.indexOf(
      "assertShareChangesJournalable(reconciled.unjournalablePaths);",
    );
    const submitAt = submit.indexOf(").submitShareProposal({");
    // indexOf returns -1 for an absent anchor, and -1 orders below every real
    // position, so a removed guard would satisfy the comparisons below.
    expect(schedulerAt).toBeGreaterThan(-1);
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeGreaterThan(-1);
    expect(submitAt).toBeGreaterThan(-1);
    expect(schedulerAt).toBeLessThan(reconcileAt);
    expect(reconcileAt).toBeLessThan(refusalAt);
    expect(refusalAt).toBeLessThan(submitAt);
    expect(submit).toContain(
      "const result = await resolveSubmitShareChangesResult(",
    );
    expect(submit).toContain(
      "reconciled.capturedPaths + reconciled.repairedPaths,",
    );

    const recipientAt = mainSource.indexOf(
      "function withShareProposalRecipientOperation<Result>(",
    );
    const recipientEnd = mainSource.indexOf("\n  }\n", recipientAt);
    const recipient = mainSource.slice(recipientAt, recipientEnd);
    const operationAt = recipient.indexOf("withRendererWorkspaceOperation(");
    const credentialsAt = recipient.indexOf("await warmCredentialCache()");
    const metadataAt = recipient.indexOf("const resolve = (): ShareProposalRecipientScope");
    expect(operationAt).toBeGreaterThan(-1);
    expect(credentialsAt).toBeGreaterThan(operationAt);
    expect(metadataAt).toBeGreaterThan(credentialsAt);
    expect(recipient).toContain("rootPath: workspace.rootPath,");
    expect(recipient).toContain("sameScope(scope, resolve())");
    expect(recipient).not.toContain("workspace: RegistryEntry;");
    expect(recipient).not.toContain("requireWorkspace(workspaceId)");
  });
});
