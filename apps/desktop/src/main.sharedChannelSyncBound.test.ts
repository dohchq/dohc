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
    expect(passSource).toContain("uncovered: result.uncovered,");
    expect(mainSource).toContain("createPassCoverageReporter((message) =>");
  });

  // The reporter deduplicates by remainder, so a pass that returns early
  // without reporting leaves the last remainder remembered. A workspace whose
  // rows go away and come back would then have its first partial pass silenced.
  it("clears the remembered remainder on every no-rows return", () => {
    expect(passSource).toContain(
      "if (!entry || channels.length === 0) {\n      reportSharedChannelPassCoveredEverything(workspaceId);\n      return;\n    }",
    );
    expect(passSource).toContain(
      "if (matching.length === 0) {\n      reportSharedChannelPassCoveredEverything(workspaceId);\n      return;\n    }",
    );
  });

  // A pass a write triggered must cover the written share (#718): with more
  // rows than the window, closing Chats stops the poll, so that pass can be the
  // last one for minutes and the message would sit local.
  it("names the written share so its own pass covers it", () => {
    expect(syncCallSource).toContain("priorityShareId,");
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
});
