import { afterEach, describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import {
  AUTOMATION_COMPUTERS_PER_WORKSPACE,
  AUTOMATION_HOST_MAX_BODY_BYTES,
  type RelayAutomationHostState,
} from "@dohc/workspace-contracts/relay";
import { isAutomationHostPath } from "./automationHostRoutes";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import {
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  countRows,
  createShare,
  inspectDatabase,
  jsonBody,
  reopenTestStorage,
  request,
  storagePath,
  testHandler,
  testStorage,
  type HandlerOverrides,
} from "./testing";

afterEach(closeTestStorages);

const WORKSPACE = "workspace-trip";
const BASE = `/sync/${WORKSPACE}/automation-host`;

let clock = 10_000;

async function relay(
  overrides: HandlerOverrides = {},
): Promise<{ h: SyncRelayHandler; storage: SyncRelayStorage }> {
  clock = 10_000;
  const storage = await testStorage();
  const h = testHandler(storage, { nowMs: () => clock, ...overrides });
  await claimWorkspace(h, "owner", WORKSPACE);
  return { h, storage };
}

async function send(
  h: SyncRelayHandler,
  action: string,
  body: Record<string, unknown>,
  userId = "owner",
): Promise<Response> {
  return h(request(userId, `${BASE}/${action}`, jsonBody(body)));
}

async function state(response: Response): Promise<RelayAutomationHostState> {
  expect(response.status, await response.clone().text()).toBe(200);
  const { ok, ...rest } = (await response.json()) as RelayAutomationHostState & { ok: true };
  expect(ok).toBe(true);
  return rest;
}

async function checkIn(h: SyncRelayHandler, installId: string, claim = false, label = installId) {
  return state(await send(h, "check-in", { installId, label, claim }));
}

async function read(h: SyncRelayHandler): Promise<RelayAutomationHostState> {
  return state(await h(request("owner", BASE)));
}

describe("automation hosts", () => {
  it("lets the owner's first computer to save an automation claim the host", async () => {
    const { h } = await relay();
    expect(await read(h)).toEqual({ host: null, computers: [] });

    clock = 11_000;
    expect((await checkIn(h, "laptop")).host).toBeNull();
    clock = 12_000;
    const claimed = await checkIn(h, "desktop", true, "Ice's desktop");
    expect(claimed.host).toEqual({
      installId: "desktop",
      generation: 1,
      handoverFrom: null,
      releasedThroughMs: null,
    });
    expect(claimed.computers).toEqual([
      { installId: "desktop", label: "Ice's desktop", lastSeenMs: 12_000 },
      { installId: "laptop", label: "laptop", lastSeenMs: 11_000 },
    ]);

    // A later claim finds a host and changes nothing but its own last seen.
    clock = 13_000;
    const again = await checkIn(h, "laptop", true, "Ice's laptop");
    expect(again.host).toEqual(claimed.host);
    expect(again.computers[0]).toEqual({ installId: "laptop", label: "Ice's laptop", lastSeenMs: 13_000 });
  });

  it("answers nobody but the owner, and never a browser cookie", async () => {
    const { h } = await relay();
    await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana", access: "edit" });
    await checkIn(h, "desktop", true);
    for (const userId of ["ana", "stranger"]) {
      expect((await h(request(userId, BASE))).status).toBe(404);
      for (const [action, body] of [
        ["check-in", { installId: "ana-laptop", label: "Ana", claim: true }],
        ["choose", { installId: "desktop", generation: 1 }],
        ["release", { installId: "desktop", generation: 1, releasedThroughMs: 1 }],
        ["take-over", { generation: 1 }],
      ] as const) {
        expect((await send(h, action, body, userId)).status, `${userId} ${action}`).toBe(404);
      }
      expect((await send(h, "check-in", { installId: "" }, userId)).status, "before the body").toBe(404);
    }
    const withCookie = request("owner", BASE, { headers: { cookie: "session=owner" } });
    expect((await h(withCookie)).status).toBe(404);
    expect((await read(h)).computers.map((computer) => computer.installId)).toEqual(["desktop"]);
  });

  it("hands over when the old computer releases, and the new one starts after it", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");

    const chosen = await state(await send(h, "choose", { installId: "laptop", generation: 1 }));
    expect(chosen.host).toEqual({
      installId: "laptop",
      generation: 2,
      handoverFrom: "desktop",
      releasedThroughMs: null,
    });
    expect((await send(h, "choose", { installId: "laptop", generation: 1 })).status, "stale").toBe(409);
    expect(
      (await send(h, "release", { installId: "laptop", generation: 2, releasedThroughMs: 5 })).status,
      "only the computer handing over releases",
    ).toBe(409);
    expect(
      (await send(h, "release", { installId: "desktop", generation: 1, releasedThroughMs: 5 })).status,
      "a release names the generation it read",
    ).toBe(409);

    const released = await state(
      await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 9_000 }),
    );
    expect(released.host).toEqual({
      installId: "laptop",
      generation: 3,
      handoverFrom: null,
      releasedThroughMs: 9_000,
    });
    expect((await send(h, "take-over", { generation: 3 })).status, "nothing to take over").toBe(409);
  });

  it("cancels a handover by choosing the old computer back, and keeps it while choosing a third", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");
    await checkIn(h, "studio");
    await send(h, "choose", { installId: "laptop", generation: 1 });

    const third = await state(await send(h, "choose", { installId: "studio", generation: 2 }));
    expect(third.host).toMatchObject({ installId: "studio", generation: 3, handoverFrom: "desktop" });
    const back = await state(await send(h, "choose", { installId: "desktop", generation: 3 }));
    expect(back.host).toMatchObject({ installId: "desktop", generation: 4, handoverFrom: null });
    const same = await state(await send(h, "choose", { installId: "desktop", generation: 4 }));
    expect(same.host?.generation, "choosing the host changes nothing").toBe(4);

    expect(
      (await send(h, "choose", { installId: "unknown", generation: 4 })).status,
      "only a checked-in computer",
    ).toBe(400);
  });

  it("keeps the latest progress when a computer missed an earlier release", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");
    await checkIn(h, "studio");
    await send(h, "choose", { installId: "laptop", generation: 1 });
    await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 9_000 });

    // The laptop has not read the desktop's release when the owner chooses
    // the studio, so it reports its own older checkpoint.
    const chosen = await state(await send(h, "choose", { installId: "studio", generation: 3 }));
    expect(chosen.host).toEqual({
      installId: "studio",
      generation: 4,
      handoverFrom: "laptop",
      releasedThroughMs: 9_000,
    });
    const released = await state(
      await send(h, "release", { installId: "laptop", generation: 4, releasedThroughMs: 5_000 }),
    );
    expect(released.host).toEqual({
      installId: "studio",
      generation: 5,
      handoverFrom: null,
      releasedThroughMs: 9_000,
    });

    // Neither a take-over nor choosing back loses it.
    await send(h, "choose", { installId: "desktop", generation: 5 });
    const taken = await state(await send(h, "take-over", { generation: 6 }));
    expect(taken.host?.releasedThroughMs).toBe(9_000);
  });

  it("lets the owner take over without a release", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");
    await send(h, "choose", { installId: "laptop", generation: 1 });
    const taken = await state(await send(h, "take-over", { generation: 2 }));
    expect(taken.host).toEqual({
      installId: "laptop",
      generation: 3,
      handoverFrom: null,
      releasedThroughMs: null,
    });
    expect(
      (await send(h, "release", { installId: "desktop", generation: 3, releasedThroughMs: 1 })).status,
      "a late release after a take-over changes nothing",
    ).toBe(409);
  });

  it("starts at once when the owner chooses a computer and none is recorded", async () => {
    const { h } = await relay();
    await checkIn(h, "laptop");
    const chosen = await state(await send(h, "choose", { installId: "laptop", generation: 0 }));
    expect(chosen.host).toMatchObject({ installId: "laptop", generation: 1, handoverFrom: null });
  });

  it("forgets the computer seen longest ago, but never the host or the one handing over", async () => {
    const { h } = await relay();
    await checkIn(h, "computer-0", true);
    for (let index = 1; index < AUTOMATION_COMPUTERS_PER_WORKSPACE; index += 1) {
      clock += 1;
      await checkIn(h, `computer-${index}`);
    }
    await send(h, "choose", { installId: "computer-1", generation: 1 });
    clock += 1;
    const full = await checkIn(h, "newcomer");
    const kept = full.computers.map((computer) => computer.installId);
    expect(kept).toHaveLength(AUTOMATION_COMPUTERS_PER_WORKSPACE);
    expect(kept).toEqual(expect.arrayContaining(["newcomer", "computer-0", "computer-1"]));
    expect(kept).not.toContain("computer-2");
  });

  it("limits each owner's changes and refuses a large body", async () => {
    const { h } = await relay({ automationHostRateLimiter: new TokenBucketLimiter(2, 0.001, 10) });
    await checkIn(h, "desktop");
    await checkIn(h, "laptop");
    const limited = await send(h, "check-in", { installId: "studio", label: "Studio", claim: false });
    expect(limited.status).toBe(429);
    expect(await read(h), "a read is not a change").toMatchObject({ host: null });

    const { h: fresh } = await relay();
    const large = await send(fresh, "check-in", {
      installId: "desktop",
      label: "Desktop",
      claim: false,
      padding: "x".repeat(AUTOMATION_HOST_MAX_BODY_BYTES),
    });
    expect(large.status).toBe(413);
  });

  it("gives the small body limit to every spelling the router accepts", async () => {
    const spellings = [
      BASE,
      `${BASE}/check-in`,
      `${BASE}/check-in/`,
      `/sync/${WORKSPACE}/%61utomation-host/check-in`,
      `/sync//${WORKSPACE}//automation-host//check-in`,
      "/sync/workspace%2Dtrip/automation-host/check-in",
    ];
    for (const path of spellings) expect(isAutomationHostPath(path), path).toBe(true);
    for (const path of [
      `${BASE}/check-in/extra`,
      `${BASE}x`,
      "/sync/automation-host",
      "/sync/shares/automation-host",
      `/sync/${WORKSPACE}/live-host`,
      `/sync/${WORKSPACE}/%E0%A4%A/check-in`,
    ]) {
      expect(isAutomationHostPath(path), path).toBe(false);
    }

    // The router reaches the check-in for each spelling that names it.
    const { h } = await relay();
    for (const path of spellings.slice(1)) {
      const response = await h(request("owner", path, jsonBody({ installId: "desktop", label: "Desktop", claim: false })));
      expect(response.status, path).toBe(200);
    }
  });

  it("refuses malformed requests and unknown actions", async () => {
    const { h } = await relay();
    for (const body of [
      { installId: "", label: "x", claim: true },
      { installId: "desktop", label: "x".repeat(65), claim: true },
      { installId: "desktop", label: "Ice\n", claim: true },
      { installId: "desktop", label: "x", claim: "yes" },
    ]) {
      expect((await send(h, "check-in", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await send(h, "choose", { installId: "desktop", generation: -1 })).status).toBe(400);
    expect((await send(h, "release", { installId: "desktop", generation: 0, releasedThroughMs: 1.5 })).status).toBe(400);
    expect((await h(request("owner", `${BASE}/check-in`))).status, "check-in is a POST").toBe(405);
    expect((await send(h, "read", {})).status).toBe(404);
    expect((await h(request("owner", `${BASE}/choose/extra`))).status).toBe(404);
  });

  it("keeps the host across a restart and goes with its workspace", async () => {
    const { h, storage } = await relay();
    await checkIn(h, "desktop", true);
    const dbPath = storagePath(storage);
    closeTestStorage(storage);
    const reopened = reopenTestStorage(dbPath);
    expect((await read(testHandler(reopened))).host?.installId).toBe("desktop");
    closeTestStorage(reopened);

    const db = inspectDatabase(dbPath, { foreignKeys: true });
    db.prepare("DELETE FROM sync_relay_workspaces WHERE workspace_id = ?").run(WORKSPACE);
    db.close();
    expect(countRows(dbPath, "sync_relay_automation_hosts")).toBe(0);
    expect(countRows(dbPath, "sync_relay_automation_computers")).toBe(0);

    const damaged = inspectDatabase(dbPath);
    damaged.exec("DROP TABLE sync_relay_automation_computers");
    damaged.close();
    expect(() => reopenTestStorage(dbPath)).toThrow("automation host schema is missing or damaged");
  });
});
