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

function sourceBetween(marker: string, end: string): string {
  const start = mainSource.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${marker}`);
  const stop = mainSource.indexOf(end, start + marker.length);
  if (stop < 0) throw new Error(`Unterminated ${marker}`);
  return mainSource.slice(start, stop + end.length);
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

describe("the shared-channel sync pass is bounded in production", () => {
  it("bounds one pass to a small, finite number of live rows", () => {
    expect(Number.isInteger(SHARED_CHANNEL_SYNC_PASS_ROWS)).toBe(true);
    expect(SHARED_CHANNEL_SYNC_PASS_ROWS).toBeGreaterThan(0);
    expect(SHARED_CHANNEL_SYNC_PASS_ROWS).toBeLessThanOrEqual(16);
  });

  it("passes that bound to the pass instead of an unbounded row count", () => {
    expect(syncCallSource).toContain("passRows: SHARED_CHANNEL_SYNC_PASS_ROWS,");
  });

  it("rotates the window: the cursor is both read and stored per workspace", () => {
    expect(syncCallSource).toContain(
      "resumeAfterShareId: sharedChannelSyncCursors.get(workspaceId) ?? null,",
    );
    expect(passSource).toContain(
      "sharedChannelSyncCursors.set(workspaceId, result.resumeAfterShareId)",
    );
  });

  it("reports the rows the pass left, so a partial pass never reads as fresh", () => {
    expect(passSource).toContain("reportSharedChannelPassCoverage({");
    expect(passSource).toContain("uncovered: result.uncovered,");
    expect(mainSource).toContain("createPassCoverageReporter((message) =>");
  });
});
