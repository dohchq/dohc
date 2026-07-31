// Pins helpers/relayPeer.ts against a REAL relay, because the specs that use it
// cannot: workspace-sync-rejoin fails earlier at cloudEnableSync (#434), so the
// assertion built on this helper is unreachable there. Without this, a helper two
// specs depend on would have no test at all.
//
// It also pins the relay behaviour that made the first version of the helper
// wrong: the log routes are identity-gated, so an identity-free read of an
// ADOPTED workspace answers 409, and mapping that to "no bucket" turned a
// correctly claimed workspace into a silent absence.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  relayAdoptedIdentity,
  spawnSyncRelay,
  type SyncRelayHandle,
} from "./helpers/syncRelay";
import { claimRelayWorkspace, relayJson, relayServesWorkspace } from "./helpers/relayPeer";

const TOKEN = "test:probe-user";

test("relayPeer helper: 404 absent, 409 without identity, 200 with it", async () => {
  test.setTimeout(120_000);
  const base = await mkdtemp(join(tmpdir(), "relaypeer-probe-"));
  const relayDb = join(base, "relay.sqlite");
  let relay: SyncRelayHandle | null = null;
  try {
    relay = await spawnSyncRelay({ dbPath: relayDb });

    // 1. An unclaimed workspace is ABSENT, not an error.
    expect(await relayServesWorkspace(relay.baseUrl, TOKEN, "never-claimed")).toBe(false);

    // 2. A claim WITHOUT identity (what claimRelayWorkspace sends) leaves the
    //    workspace un-adopted, so an identity-free read still succeeds.
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: TOKEN, workspaceId: "plain" });
    expect(await relayServesWorkspace(relay.baseUrl, TOKEN, "plain")).toBe(true);
    expect(relayAdoptedIdentity(relayDb, "plain")).toBeNull();

    // 3. A claim WITH identity — what the app's cloudEnableSync does — makes the
    //    relay adopt it, and then an identity-free read must NOT read as absent.
    const adopted = await relayJson(relay.baseUrl, TOKEN, "/sync/workspaces", {
      method: "POST",
      body: JSON.stringify({
        workspaceId: "adopted",
        replicationEpoch: "epoch-probe-1",
        streamIdentity: "stream-probe-1",
      }),
    });
    expect(adopted.status).toBe(200);
    const identity = relayAdoptedIdentity(relayDb, "adopted");
    expect(identity).not.toBeNull();

    await expect(relayServesWorkspace(relay.baseUrl, TOKEN, "adopted")).rejects.toThrow(/409/);
    expect(await relayServesWorkspace(relay.baseUrl, TOKEN, "adopted", identity)).toBe(true);
  } finally {
    await relay?.stop();
  }
});
