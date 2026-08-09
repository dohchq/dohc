import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHARED_CHANNEL_SYNC_PASS_ROWS } from "./workspaces/sharedChannels";

// #718: listChatChannels and syncDms AWAIT the shared-channel sync pass, so a
// pass that walks the whole joined registry makes joined history set Chats-open
// latency. sharedChannels.test.ts pins the window itself; this suite pins that
// the PRODUCTION pass actually uses it — the wiring is the part a mutation can
// silently unbound. main.ts is the Electron entry point and cannot be imported
// under vitest, so this reads the source it protects, as
// main.chatSecurity.test.ts and main.bootstrapWindowGate.test.ts do.
const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

function sourceBetween(marker: string, end: string, source = mainSource): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${marker}`);
  const stop = source.indexOf(end, start + marker.length);
  if (stop < 0) throw new Error(`Unterminated ${marker}`);
  return source.slice(start, stop + end.length);
}

// The pass function, and inside it the call that carries the bound.
const passSource = sourceBetween(
  "async function runSharedChannelSyncPass(",
  "\n}\n",
);
const syncCallSource = sourceBetween(
  "await syncJoinedSharedChannels({",
  "\n    });",
);

// One IPC handler's body, so a trigger wired in ONE handler cannot stand in for
// the others.
function handlerSource(channel: string): string {
  const marker = `ipcMain.handle(CHANNELS.${channel},`;
  const start = mainSource.indexOf(marker);
  if (start < 0) throw new Error(`Missing handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", start + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

describe("the shared-channel sync pass is bounded in production", () => {
  it("bounds one pass to a small, finite number of live rows", () => {
    expect(Number.isInteger(SHARED_CHANNEL_SYNC_PASS_ROWS)).toBe(true);
    expect(SHARED_CHANNEL_SYNC_PASS_ROWS).toBeGreaterThan(0);
    expect(SHARED_CHANNEL_SYNC_PASS_ROWS).toBeLessThanOrEqual(16);
  });

  it("passes that bound to the pass instead of an unbounded row count", () => {
    expect(syncCallSource).toContain("passRows: SHARED_CHANNEL_SYNC_PASS_ROWS,");
  });

  // The rotation resolves its cursor against the registry's own order, and that
  // only works when the pass RECEIVES the unfiltered rows. main filters ended
  // rows out of the work set, so handing the same filtered array for both makes
  // the cursor lookup miss the moment its share is revoked — the exact case the
  // unit pin covers, tested against inputs production would never send.
  it("hands the pass the unfiltered registry, not the work set, for the rotation", () => {
    expect(passSource).toContain("const registryOrder = entry?.sharedChannels ?? [];");
    expect(passSource).toContain(
      "const channels = registryOrder.filter((channel) => !channel.ended);",
    );
    expect(syncCallSource).toContain("registryOrder,");
    expect(syncCallSource).toContain("channels: matching,");
  });

  // A revoked-and-re-granted channel loses its share id: mergeJoinedChannel
  // replaces the row. The cursor therefore has to name the CHANNEL, and the
  // merge has to keep that channel where it was — an appended row moves the
  // rotation's place to the end of the registry and strands the rest.
  it("carries the cursor as a channel, and keeps a re-granted channel in place", () => {
    expect(syncCallSource).toContain(
      "resumeAfterChannelWireId: sharedChannelSyncCursors.get(workspaceId),",
    );
    expect(passSource).toContain(
      "sharedChannelSyncCursors.set(workspaceId, result.resumeAfterChannelWireId)",
    );
    // The merge appends only a channel the workspace has never joined.
    const merge = sourceBetween(
      "export function mergeJoinedChannel(",
      "\n}\n",
      readFileSync(
        new URL("./workspaces/sharedChannels.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(merge).toContain("if (!replaced) merged.push(joined);");
    expect(merge).not.toContain("return [...kept, joined];");
  });

  // The helper resolves a target, and a target with no live grant resolves to
  // nothing. Running a pass anyway put a whole window of relay round trips in
  // front of a purely local read — opening a LOCAL channel awaited the rotation.
  it("never starts a pass for a chat target that holds no live grant", () => {
    const helper = sourceBetween(
      "async function syncSharedChannelsForChatTarget(",
      "\n}\n",
    );
    expect(helper).toContain(
      "if (!joinedChannel || joinedChannel.ended === true) return 0;",
    );
    // And the skip must come BEFORE the pass, or it skips nothing.
    expect(
      helper.indexOf("if (!joinedChannel || joinedChannel.ended === true) return 0;"),
    ).toBeLessThan(helper.indexOf("return await syncWorkspaceSharedChannels(workspaceId,"));
  });

  // A lookup that FAILS (the engine restarting) is not evidence the target is
  // local. Reading it that way skips the sync entirely and the workspace goes
  // unsynced for that trigger.
  it("falls back to a plain pass when the target lookup itself fails", () => {
    const helper = sourceBetween(
      "async function syncSharedChannelsForChatTarget(",
      "\n}\n",
    );
    expect(helper).toContain("} catch {");
    expect(helper).toContain("return await syncWorkspaceSharedChannels(workspaceId);");
    // The failure path must not be the local-target path.
    expect(helper).not.toContain(".catch(() => null)");
    expect(
      helper.indexOf("return await syncWorkspaceSharedChannels(workspaceId);"),
    ).toBeLessThan(
      helper.indexOf("if (!joinedChannel || joinedChannel.ended === true) return 0;"),
    );
  });

  // Signed out, a workspace with joined rows refreshed none of them — but the
  // count was seeded after the credential work, so that exit reported a clean
  // sweep and the snapshot read as fully fresh. The count is seeded from the
  // ended-filtered rows BEFORE any credential work, so a rejection there knows
  // it too.
  it("reports every joined row when the account cannot sync them", () => {
    const seed = passSource.indexOf("liveRows = channels.length;");
    const credentials = passSource.indexOf("await warmCredentialCache();");
    expect(seed).toBeGreaterThan(-1);
    expect(seed).toBeLessThan(credentials);
    expect(passSource).toContain(
      "if (!syncCredentials?.relayUrl) return liveRows;",
    );
    // A workspace with no rows at all still claims nothing.
    expect(passSource).toContain(
      "if (!entry || channels.length === 0) {\n      reportSharedChannelPassCoveredEverything(workspaceId);\n      return 0;\n    }",
    );
  });

  // A pass that reached its rows and refreshed none of them (offline) reported
  // a clean sweep, and every snapshot built on it read as fully fresh.
  it("reports rows a pass failed to refresh, and everything when a pass dies", () => {
    expect(passSource).toContain(
      "const unrefreshed = result.uncovered + result.failedRows;",
    );
    expect(passSource).toContain("return unrefreshed;");
    // The outer catch owns the same claim.
    expect(passSource).toContain("return liveRows;");
    expect(passSource).toContain("liveRows = matching.length;");
  });

  // The pass waits in a per-workspace queue. Resolving the priority to a SHARE
  // before queueing means a revoke plus re-grant while it waits leaves the
  // queued pass hunting a share id that no longer exists — the same failure the
  // cursor already had, one layer up.
  it("carries the priority through the queue as a channel, not a grant", () => {
    const helper = sourceBetween(
      "async function syncSharedChannelsForChatTarget(",
      "\n}\n",
    );
    expect(helper).toContain(
      "return await syncWorkspaceSharedChannels(workspaceId, joinedChannel.channelWireId);",
    );
    expect(helper).not.toContain("joinedChannel.shareId");
    expect(syncCallSource).toContain("priorityChannelWireId,");
  });

  // Aggregate reads answer from the local store after ONE bounded pass. An
  // agent reading that response through the CLI or MCP cannot see the pass was
  // partial unless the response says so — the console line reaches nobody.
  it("tells every aggregate read how many rows its pass left", () => {
    for (const result of [
      "ListChatFileMentionsResult",
      "ListChatChannelsResult",
      "ListPersonalChatFeedResult",
      "WorkspaceGraphResult",
    ]) {
      const response = sourceBetween(`return ${result}.parse({`, "\n    });");
      expect(response, result).toContain(
        "...(rowsUncovered > 0 ? { sharedChannelRowsUncovered: rowsUncovered } : {}),",
      );
    }
  });

  it("rotates the window: the cursor is both read and stored per workspace", () => {
    expect(syncCallSource).toContain(
      "resumeAfterChannelWireId: sharedChannelSyncCursors.get(workspaceId),",
    );
    expect(passSource).toContain(
      "sharedChannelSyncCursors.set(workspaceId, result.resumeAfterChannelWireId)",
    );
  });

  it("reports the rows the pass left, so a partial pass never reads as fresh", () => {
    expect(passSource).toContain("reportSharedChannelPassCoverage({");
    expect(passSource).toContain("uncovered: unrefreshed,");
    expect(mainSource).toContain("createPassCoverageReporter((message) =>");
  });

  // The reporter deduplicates by remainder, so a pass that returns early
  // without reporting leaves the last remainder remembered. A workspace whose
  // rows go away and come back would then have its first partial pass silenced.
  it("clears the remembered remainder on every no-rows return", () => {
    expect(passSource).toContain(
      "if (!entry || channels.length === 0) {\n      reportSharedChannelPassCoveredEverything(workspaceId);\n      return 0;\n    }",
    );
    expect(passSource).toContain(
      "if (matching.length === 0) {\n      reportSharedChannelPassCoveredEverything(workspaceId);\n      return 0;\n    }",
    );
  });

  // A pass a write triggered must cover the written share (#718): with more
  // rows than the window, closing Chats stops the poll, so that pass can be the
  // last one for minutes and the message would sit local.
  it("names the written share so its own pass covers it", () => {
    expect(syncCallSource).toContain("priorityChannelWireId,");
    // Each write trigger separately: one handler still naming its share is not
    // proof the others do.
    for (const channel of [
      "sendChatMessage",
      "startChannelThread",
      "resolveChatDecision",
    ]) {
      expect(handlerSource(channel), channel).toContain(
        "void syncSharedChannelsForChatTarget(",
      );
      expect(handlerSource(channel), channel).not.toContain(
        "void syncWorkspaceSharedChannels(",
      );
    }
    // The agent dispatch path posts through the chat service, which now carries
    // the thread it wrote into.
    expect(mainSource).toContain("onMessagePosted: (workspaceId, threadId) => {");
    expect(mainSource).toContain(
      "void syncSharedChannelsForChatTarget(workspaceId, { threadId });",
    );
    // The CLI chat surface is message-bearing too. Asserted as its own block so
    // another wired trigger cannot stand in for it.
    expect(mainSource).toContain(
      "onWrite: (workspace, target) => {\n" +
        "      notifyRenderer();\n" +
        "      activity.queueCloudSync(workspace.workspaceId);\n" +
        "      void syncSharedChannelsForChatTarget(workspace.workspaceId, target);",
    );
  });

  // A channel view has no poll at all, so its snapshot is whatever the last
  // pass happened to leave. Above the window, an untargeted sync can refresh
  // sixteen other channels and serve the opened one stale — and nothing comes
  // along later to correct it.
  it("names the opened channel, and syncs it BEFORE serving its threads", () => {
    const handler = handlerSource("listChannelThreads");
    const sync = handler.indexOf(
      "await syncSharedChannelsForChatTarget(workspace.workspaceId, {\n" +
        "      channelId: input.channelId,\n" +
        "    });",
    );
    const read = handler.indexOf("listChannelThreads({");
    expect(sync, "the opened channel must be named").toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    // A refresh after the read is a refresh the caller never sees.
    expect(sync).toBeLessThan(read);
  });

  // The DM poll runs every 4 s behind an open conversation. Unnamed, it starts a
  // plain rotation, so above the window the conversation the user is READING can
  // stay stale for many polls while the surface looks refreshed.
  it("names the open DM so its own poll refreshes it", () => {
    expect(handlerSource("syncDms")).toContain(
      "await syncSharedChannelsForChatTarget(\n" +
        "          workspace.workspaceId,\n" +
        "          input.openChannelId ? { channelId: input.openChannelId } : undefined,\n" +
        "        );",
    );
    expect(handlerSource("syncDms")).not.toContain(
      "await syncWorkspaceSharedChannels(",
    );
  });

  // #731: no renderer poll runs behind the CLI or MCP, so their chat reads must
  // trigger the pass themselves. The CLI server's own dispatch AWAITS
  // options.onRead before it serves a chat verb (cliServer.test.ts pins that);
  // this pins that PRODUCTION wires the hook to the real pass, not a stub.
  it("wires the CLI server's chat reads to the real shared-channel sync pass", () => {
    const cliServerSource = sourceBetween(
      "async function startDesktopCliServer(",
      "\n}\n",
    );
    // Named through the SAME target-priority helper syncDms uses (:276-279),
    // not a plain untargeted pass: a chat read past the pass's row bound must
    // still cover the thread or channel it actually asked for.
    expect(cliServerSource).toContain(
      "onRead: async (workspace, target) => {\n" +
        "      await syncSharedChannelsForChatTarget(workspace.workspaceId, target);\n" +
        "    },",
    );
  });
});
