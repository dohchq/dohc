import { afterEach, describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import {
  AUTOMATION_COMPUTERS_PER_WORKSPACE,
  AUTOMATION_HOST_MAX_BODY_BYTES,
  AUTOMATION_HOST_RELEASE_MAX_BODY_BYTES,
  type RelayAutomationHostState,
} from "@dohc/workspace-contracts/relay";
import { automationHostMaxBodyBytes, isAutomationHostPath } from "./automationHostRoutes";
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

// A Group handover as the engine of the computer handing over answers it.
const GROUPS = {
  floorMs: 1,
  automations: [{ automationId: "collection:Trip#task", sinceMs: 1, decided: [{ messageId: "m1", createdAtMs: 2 }] }],
};

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

async function groups(h: SyncRelayHandler, generation: number | string, userId = "owner"): Promise<Response> {
  return h(request(userId, `${BASE}/groups?generation=${generation}`));
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
        ["release", { installId: "desktop", generation: 1, releasedThroughMs: 1, groups: GROUPS, groupsTaken: 9 }],
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
      (await send(h, "release", { installId: "laptop", generation: 2, releasedThroughMs: 5, groups: GROUPS, groupsTaken: 9 })).status,
      "only the computer handing over releases",
    ).toBe(409);
    expect(
      (await send(h, "release", { installId: "desktop", generation: 1, releasedThroughMs: 5, groups: GROUPS, groupsTaken: 9 })).status,
      "a release names the generation it read",
    ).toBe(409);

    const released = await state(
      await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 9_000, groups: GROUPS, groupsTaken: 9 }),
    );
    expect(released.host).toEqual({
      installId: "laptop",
      generation: 3,
      handoverFrom: null,
      releasedThroughMs: 9_000,
    });
    expect((await send(h, "take-over", { generation: 3 })).status, "nothing to take over").toBe(409);
  });

  it("keeps a release's Group handover for the computer it names", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");
    expect(await (await groups(h, 1)).json(), "no release left one").toEqual({ ok: true, generation: null, groups: null });
    await send(h, "choose", { installId: "laptop", generation: 1 });
    expect(
      (await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5, groups: [], groupsTaken: 1 })).status,
      "groups is an object",
    ).toBe(400);
    expect(
      (await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5 })).status,
      "a release carries the Group handover",
    ).toBe(400);
    await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5, groups: GROUPS, groupsTaken: 9 });

    expect(await (await groups(h, 3)).json()).toEqual({ ok: true, generation: 3, groups: GROUPS });
    expect((await groups(h, 2)).status, "not the current generation").toBe(409);
    expect((await groups(h, "x")).status).toBe(400);
    expect((await groups(h, 3, "stranger")).status, "only the owner").toBe(404);
    expect((await send(h, "groups", {})).status, "a read").toBe(405);

    // The owner moves on, and the desktop takes over: that handover is the laptop's.
    await send(h, "choose", { installId: "desktop", generation: 3 });
    expect((await groups(h, 3)).status).toBe(409);
    await send(h, "take-over", { generation: 4 });
    expect(await (await groups(h, 5)).json(), "another computer ran: a take over").toEqual({ ok: true, generation: 5, groups: null });

    // The desktop runs on: a called-off handover later finds nobody else ran.
    await send(h, "choose", { installId: "laptop", generation: 5 });
    await send(h, "choose", { installId: "desktop", generation: 6 });
    expect(await (await groups(h, 7)).json()).toEqual({ ok: true, generation: null, groups: null });

    // Its release goes on as it is, whatever handover it took before.
    await send(h, "choose", { installId: "laptop", generation: 7 });
    const afterTakeOver = { floorMs: 9, automations: [] };
    await send(h, "release", { installId: "desktop", generation: 8, releasedThroughMs: 9, groups: afterTakeOver, groupsTaken: 0 });
    expect(await (await groups(h, 9)).json()).toEqual({ ok: true, generation: 9, groups: afterTakeOver });
  });

  it("keeps a handover for its computer across a handover the owner called off", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");
    await checkIn(h, "studio");
    await send(h, "choose", { installId: "laptop", generation: 1 });
    await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5, groups: GROUPS, groupsTaken: 0 });
    // Before the laptop read it, the owner chose the studio, then the laptop again.
    await send(h, "choose", { installId: "studio", generation: 3 });
    const back = await state(await send(h, "choose", { installId: "laptop", generation: 4 }));
    expect(back.host).toMatchObject({ installId: "laptop", generation: 5, handoverFrom: null });
    expect(await (await groups(h, 5)).json()).toEqual({ ok: true, generation: 3, groups: GROUPS });
  });

  it("keeps the handover it holds when the computer releasing never took it", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");
    await send(h, "choose", { installId: "laptop", generation: 1 });
    await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5, groups: GROUPS, groupsTaken: 0 });
    // The laptop never read its handover before the owner chose the desktop back.
    await send(h, "choose", { installId: "desktop", generation: 3 });
    const untaken = { floorMs: 3, automations: [] };
    await send(h, "release", { installId: "laptop", generation: 4, releasedThroughMs: 6, groups: untaken, groupsTaken: 0 });
    expect(await (await groups(h, 5)).json(), "the desktop's own handover").toEqual({ ok: true, generation: 5, groups: GROUPS });

    // A computer that took it hands over its own, which carries it on.
    await send(h, "choose", { installId: "laptop", generation: 5 });
    const taken = { floorMs: 4, automations: [] };
    await send(h, "release", { installId: "desktop", generation: 6, releasedThroughMs: 7, groups: taken, groupsTaken: 5 });
    expect(await (await groups(h, 7)).json()).toEqual({ ok: true, generation: 7, groups: taken });
    expect(
      (await send(h, "release", { installId: "laptop", generation: 7, releasedThroughMs: 8, groups: taken })).status,
      "a release says which handover it took",
    ).toBe(400);
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
    await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 9_000, groups: GROUPS, groupsTaken: 9 });

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
      await send(h, "release", { installId: "laptop", generation: 4, releasedThroughMs: 5_000, groups: GROUPS, groupsTaken: 9 }),
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
      (await send(h, "release", { installId: "desktop", generation: 3, releasedThroughMs: 1, groups: GROUPS, groupsTaken: 9 })).status,
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

    // A release carries the Group handover, so it takes more.
    await checkIn(fresh, "laptop");
    await send(fresh, "check-in", { installId: "desktop", label: "Desktop", claim: true });
    await send(fresh, "choose", { installId: "laptop", generation: 1 });
    const release = (padding: number) => send(fresh, "release", {
      installId: "desktop",
      generation: 2,
      releasedThroughMs: 1,
      groups: { ...GROUPS, padding: "x".repeat(padding) },
      groupsTaken: 1,
    });
    expect((await release(AUTOMATION_HOST_RELEASE_MAX_BODY_BYTES)).status).toBe(413);
    expect((await release(AUTOMATION_HOST_MAX_BODY_BYTES)).status).toBe(200);
    expect(automationHostMaxBodyBytes(`${BASE}/release`)).toBe(AUTOMATION_HOST_RELEASE_MAX_BODY_BYTES);
    expect(automationHostMaxBodyBytes(`${BASE}/check-in`)).toBe(AUTOMATION_HOST_MAX_BODY_BYTES);
    expect(automationHostMaxBodyBytes(`/sync/${WORKSPACE}/live-host`)).toBeNull();
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
    expect((await send(h, "release", { installId: "desktop", generation: 0, releasedThroughMs: 1.5, groups: GROUPS, groupsTaken: 9 })).status).toBe(400);
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
    expect(countRows(dbPath, "sync_relay_automation_group_handovers")).toBe(0);

    const damaged = inspectDatabase(dbPath);
    damaged.exec("DROP TABLE sync_relay_automation_computers");
    damaged.close();
    expect(() => reopenTestStorage(dbPath)).toThrow("automation host schema is missing or damaged");
  });
});
