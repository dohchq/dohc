import { afterEach, describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import {
  AUTOMATION_COMPUTERS_PER_WORKSPACE,
  AUTOMATION_HOST_MAX_BODY_BYTES,
  AUTOMATION_HOST_REACH_MAX_BYTES,
  AUTOMATION_HOST_RELEASE_MAX_BODY_BYTES,
  AUTOMATION_SERVER_MAX_WORKSPACES,
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

// The reach verdicts of the computer handing over, which the relay keeps unread.
const REACH = { verdicts: [{ automationId: "collection:Trip#task", step: "0", verdict: "stopped" }] };

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
      { installId: "desktop", kind: "computer", label: "Ice's desktop", lastSeenMs: 12_000 },
      { installId: "laptop", kind: "computer", label: "laptop", lastSeenMs: 11_000 },
    ]);

    // A later claim finds a host and changes nothing but its own last seen.
    clock = 13_000;
    const again = await checkIn(h, "laptop", true, "Ice's laptop");
    expect(again.host).toEqual(claimed.host);
    expect(again.computers[0]).toEqual({ installId: "laptop", kind: "computer", label: "Ice's laptop", lastSeenMs: 13_000 });
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
        ["release", { installId: "desktop", generation: 1, releasedThroughMs: 1, groups: GROUPS, groupsWatched: 9, reach: REACH }],
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
      (await send(h, "release", { installId: "laptop", generation: 2, releasedThroughMs: 5, groups: GROUPS, groupsWatched: 9, reach: REACH })).status,
      "only the computer handing over releases",
    ).toBe(409);
    expect(
      (await send(h, "release", { installId: "desktop", generation: 1, releasedThroughMs: 5, groups: GROUPS, groupsWatched: 9, reach: REACH })).status,
      "a release names the generation it read",
    ).toBe(409);

    const released = await state(
      await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 9_000, groups: GROUPS, groupsWatched: 9, reach: REACH }),
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
    expect(await (await groups(h, 1)).json(), "no release left one").toEqual({ ok: true, generation: null, groups: null, reach: null, everShared: false });
    await send(h, "choose", { installId: "laptop", generation: 1 });
    expect(
      (await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5, groups: [], groupsWatched: 1, reach: REACH })).status,
      "groups is an object",
    ).toBe(400);
    expect(
      (await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5 })).status,
      "a release carries the Group handover",
    ).toBe(400);
    await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5, groups: GROUPS, groupsWatched: 9, reach: REACH });

    expect(await (await groups(h, 3)).json()).toEqual({ ok: true, generation: 3, groups: GROUPS, reach: REACH, everShared: false });
    expect((await groups(h, 2)).status, "not the current generation").toBe(409);
    expect((await groups(h, "x")).status).toBe(400);
    expect((await groups(h, 3, "stranger")).status, "only the owner").toBe(404);
    expect((await send(h, "groups", {})).status, "a read").toBe(405);

    // The owner moves on, and the desktop takes over: that handover is the laptop's.
    await send(h, "choose", { installId: "desktop", generation: 3 });
    expect((await groups(h, 3)).status).toBe(409);
    await send(h, "take-over", { generation: 4 });
    expect(await (await groups(h, 5)).json(), "another computer ran: a take over").toEqual({ ok: true, generation: 5, groups: null, reach: null, everShared: false });

    // A called-off handover later still finds the take over, for the
    // desktop's engine to compare with the generation it last watched at.
    await send(h, "choose", { installId: "laptop", generation: 5 });
    await send(h, "choose", { installId: "desktop", generation: 6 });
    expect(await (await groups(h, 7)).json()).toEqual({ ok: true, generation: 5, groups: null, reach: null, everShared: false });

    // Once it watched after the take over, its release goes on as it is.
    await send(h, "choose", { installId: "laptop", generation: 7 });
    const afterTakeOver = { floorMs: 9, automations: [] };
    await send(h, "release", { installId: "desktop", generation: 8, releasedThroughMs: 9, groups: afterTakeOver, groupsWatched: 7, reach: REACH });
    expect(await (await groups(h, 9)).json()).toEqual({ ok: true, generation: 9, groups: afterTakeOver, reach: REACH, everShared: false });
  });

  it("keeps a release's reach verdicts beside its Group handover, and none after a take over", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");
    await send(h, "choose", { installId: "laptop", generation: 1 });
    const release = (body: Record<string, unknown>) =>
      send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5, groups: GROUPS, groupsWatched: 1, ...body });
    expect((await release({ reach: [] })).status, "reach is an object").toBe(400);
    expect((await release({})).status, "a release carries the reach verdicts").toBe(400);
    const large = { verdicts: "x".repeat(AUTOMATION_HOST_REACH_MAX_BYTES) };
    expect((await release({ reach: large })).status).toBe(413);

    // A computer that could not read its verdicts releases none.
    expect((await release({ reach: null })).status).toBe(200);
    expect(await (await groups(h, 3)).json()).toEqual({ ok: true, generation: 3, groups: GROUPS, reach: null, everShared: false });

    await send(h, "choose", { installId: "desktop", generation: 3 });
    await send(h, "release", { installId: "laptop", generation: 4, releasedThroughMs: 6, groups: GROUPS, groupsWatched: 3, reach: REACH });
    expect((await (await groups(h, 5)).json() as { reach: unknown }).reach).toEqual(REACH);

    // Once the workspace was shared, the answer says so, even after the share ends.
    await createShare(h, "owner", WORKSPACE, { paths: ["trip"], recipientUserId: "ana", access: "edit" });
    expect((await (await groups(h, 5)).json() as { everShared: unknown }).everShared).toBe(true);

    await send(h, "choose", { installId: "laptop", generation: 5 });
    await send(h, "take-over", { generation: 6 });
    expect(await (await groups(h, 7)).json()).toEqual({ ok: true, generation: 7, groups: null, reach: null, everShared: true });
  });

  it("starts the next computer from now when the one releasing never watched after its take over", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");
    await send(h, "choose", { installId: "laptop", generation: 1 });
    await send(h, "take-over", { generation: 2 });
    // The laptop took over at 3 and never watched there.
    await send(h, "choose", { installId: "desktop", generation: 3 });
    await send(h, "release", { installId: "laptop", generation: 4, releasedThroughMs: 5, groups: GROUPS, groupsWatched: 1, reach: REACH });
    expect(await (await groups(h, 5)).json(), "its handover is stale").toEqual({ ok: true, generation: 5, groups: null, reach: null, everShared: false });
  });

  it("keeps a handover for its computer across a handover the owner called off", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");
    await checkIn(h, "studio");
    await send(h, "choose", { installId: "laptop", generation: 1 });
    await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5, groups: GROUPS, groupsWatched: 0, reach: REACH });
    // Before the laptop read it, the owner chose the studio, then the laptop again.
    await send(h, "choose", { installId: "studio", generation: 3 });
    const back = await state(await send(h, "choose", { installId: "laptop", generation: 4 }));
    expect(back.host).toMatchObject({ installId: "laptop", generation: 5, handoverFrom: null });
    expect(await (await groups(h, 5)).json()).toEqual({ ok: true, generation: 3, groups: GROUPS, reach: REACH, everShared: false });
  });

  it("keeps the handover it holds when the computer releasing never took it", async () => {
    const { h } = await relay();
    await checkIn(h, "desktop", true);
    await checkIn(h, "laptop");
    await send(h, "choose", { installId: "laptop", generation: 1 });
    await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 5, groups: GROUPS, groupsWatched: 0, reach: REACH });
    // The laptop never read its handover before the owner chose the desktop back.
    await send(h, "choose", { installId: "desktop", generation: 3 });
    const untaken = { floorMs: 3, automations: [] };
    await send(h, "release", { installId: "laptop", generation: 4, releasedThroughMs: 6, groups: untaken, groupsWatched: 0, reach: REACH });
    expect(await (await groups(h, 5)).json(), "the desktop's own handover").toEqual({ ok: true, generation: 5, groups: GROUPS, reach: REACH, everShared: false });

    // A computer that took it hands over its own, which carries it on.
    await send(h, "choose", { installId: "laptop", generation: 5 });
    const taken = { floorMs: 4, automations: [] };
    await send(h, "release", { installId: "desktop", generation: 6, releasedThroughMs: 7, groups: taken, groupsWatched: 5, reach: REACH });
    expect(await (await groups(h, 7)).json()).toEqual({ ok: true, generation: 7, groups: taken, reach: REACH, everShared: false });
    expect(
      (await send(h, "release", { installId: "laptop", generation: 7, releasedThroughMs: 8, groups: taken })).status,
      "a release says the generation it last watched at",
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
    await send(h, "release", { installId: "desktop", generation: 2, releasedThroughMs: 9_000, groups: GROUPS, groupsWatched: 9, reach: REACH });

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
      await send(h, "release", { installId: "laptop", generation: 4, releasedThroughMs: 5_000, groups: GROUPS, groupsWatched: 9, reach: REACH }),
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
      (await send(h, "release", { installId: "desktop", generation: 3, releasedThroughMs: 1, groups: GROUPS, groupsWatched: 9, reach: REACH })).status,
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
      groupsWatched: 1, reach: REACH,
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
    expect((await send(h, "release", { installId: "desktop", generation: 0, releasedThroughMs: 1.5, groups: GROUPS, groupsWatched: 9, reach: REACH })).status).toBe(400);
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
    expect(countRows(dbPath, "sync_relay_automation_host_placements")).toBe(0);

    const damaged = inspectDatabase(dbPath);
    damaged.exec("DROP TABLE sync_relay_automation_computers");
    damaged.close();
    expect(() => reopenTestStorage(dbPath)).toThrow("automation host schema is missing or damaged");
  });
});

describe("a server that runs automations", () => {
  const SERVER = { label: "My dohc server" };

  // One store with two handlers: `off` as the relay runs with automations
  // off, `on` as it runs with them on.
  async function relays(): Promise<{ off: SyncRelayHandler; on: SyncRelayHandler; storage: SyncRelayStorage }> {
    const { h: off, storage } = await relay();
    return { off, on: testHandler(storage, { nowMs: () => clock, automationServer: SERVER }), storage };
  }

  async function groupMark(h: SyncRelayHandler, generation: number): Promise<unknown> {
    const response = await groups(h, generation);
    expect(response.status).toBe(200);
    return response.json();
  }

  // Fills the server with other workspaces, as far as its limit: each one
  // hosted there, or with `handingOver`, being handed to it.
  function fillServer(storage: SyncRelayStorage, handingOver = false) {
    // Other workspaces' rows, standing in for a full server, need no workspace rows.
    const db = inspectDatabase(storagePath(storage));
    db.exec("PRAGMA foreign_keys = OFF");
    const insert = db.prepare(
      handingOver
        ? "INSERT INTO sync_relay_automation_hosts (workspace_id, install_id, generation, handover_from) VALUES (?, 'x', 1, 'server')"
        : "INSERT INTO sync_relay_automation_hosts (workspace_id, install_id, generation) VALUES (?, 'server', 1)",
    );
    for (let index = 0; index < AUTOMATION_SERVER_MAX_WORKSPACES; index++) insert.run(`other-${index}`);
    return {
      makeRoom() {
        db.prepare("DELETE FROM sync_relay_automation_hosts WHERE workspace_id = 'other-0'").run();
        db.close();
      },
    };
  }

  it("records a first claim on the server and lists it first", async () => {
    const { on } = await relays();
    clock = 12_000;
    const claimed = await checkIn(on, "desktop", true, "Ice's desktop");
    expect(claimed.host).toEqual({ installId: "server", generation: 1, handoverFrom: null, releasedThroughMs: null });
    expect(claimed.computers).toEqual([
      { installId: "server", kind: "server", label: "My dohc server", lastSeenMs: 12_000 },
      { installId: "desktop", kind: "computer", label: "Ice's desktop", lastSeenMs: 12_000 },
    ]);
  });

  it("never takes the server's install id from a computer", async () => {
    const { off, on } = await relays();
    for (const h of [off, on]) {
      expect((await send(h, "check-in", { installId: "server", label: "Fake", claim: true })).status).toBe(400);
      expect((await send(h, "release", {
        installId: "server", generation: 0, releasedThroughMs: 1, groups: GROUPS, groupsWatched: 0, reach: REACH,
      })).status).toBe(400);
      const presses = `/sync/${WORKSPACE}/automation-presses`;
      expect((await h(request("owner", `${presses}?installId=server`))).status).toBe(400);
      for (const [action, body] of [
        ["accept", { generation: 1, hostPressIds: ["press-1"] }],
        ["settle", { hostPressId: "press-1", outcome: "done", error: null }],
      ] as const) {
        const answer = await h(request("owner", `${presses}/${action}`, jsonBody({ installId: "server", ...body })));
        expect(answer.status, action).toBe(400);
        expect(await answer.text(), action).toContain("reserved for the server");
      }
    }
    expect((await send(off, "choose", { installId: "server", generation: 0 })).status).toBe(400);
    expect((await read(on)).host).toBeNull();
  });

  it("hands a computer the relay placed over to the server at its next check-in", async () => {
    const { off, on } = await relays();
    await checkIn(off, "desktop", true);
    await checkIn(off, "laptop");

    expect((await checkIn(on, "laptop")).host?.installId, "not the host").toBe("desktop");
    const handing = await checkIn(on, "desktop");
    expect(handing.host).toEqual({ installId: "server", generation: 2, handoverFrom: "desktop", releasedThroughMs: null });
    const released = await state(await send(on, "release", {
      installId: "desktop", generation: 2, releasedThroughMs: 9_000, groups: GROUPS, groupsWatched: 1, reach: REACH,
    }));
    expect(released.host).toEqual({ installId: "server", generation: 3, handoverFrom: null, releasedThroughMs: 9_000 });
    expect(await groupMark(on, 3)).toEqual({ ok: true, generation: 3, groups: GROUPS, reach: REACH, everShared: false });
  });

  it("keeps a host recorded before the relay told placed hosts from chosen ones", async () => {
    const { off, on, storage } = await relays();
    await checkIn(off, "desktop", true);
    const db = inspectDatabase(storagePath(storage));
    db.prepare("DELETE FROM sync_relay_automation_host_placements").run();
    db.close();
    expect((await checkIn(on, "desktop", true)).host?.installId).toBe("desktop");
  });

  it("keeps a computer the owner chose", async () => {
    const { off, on } = await relays();
    await checkIn(off, "desktop", true);
    await checkIn(off, "laptop");
    await state(await send(off, "choose", { installId: "laptop", generation: 1 }));
    await state(await send(off, "release", {
      installId: "desktop", generation: 2, releasedThroughMs: 9_000, groups: GROUPS, groupsWatched: 1, reach: REACH,
    }));
    const chosen = await checkIn(on, "laptop", true);
    expect(chosen.host).toEqual({ installId: "laptop", generation: 3, handoverFrom: null, releasedThroughMs: 9_000 });

    // Choosing the host it already has is a choice too.
    const { off: other, on: otherOn } = await relays();
    await checkIn(other, "desktop", true);
    await state(await send(other, "choose", { installId: "desktop", generation: 1 }));
    expect((await checkIn(otherOn, "desktop", true)).host?.installId).toBe("desktop");
  });

  it("lets the owner choose the server, and stops at the server's limit", async () => {
    const { off, on, storage } = await relays();
    await checkIn(off, "desktop", true);
    const server = fillServer(storage);
    const full = await send(on, "choose", { installId: "server", generation: 1 });
    expect(full.status).toBe(400);
    expect(await full.text()).toContain("as many workspaces as it can");
    server.makeRoom();
    const chosen = await state(await send(on, "choose", { installId: "server", generation: 1 }));
    expect(chosen.host).toEqual({ installId: "server", generation: 2, handoverFrom: "desktop", releasedThroughMs: null });
  });

  it("places a computer while the server is full, and hands it over once there is room", async () => {
    const { on, storage } = await relays();
    const server = fillServer(storage, true);
    expect((await checkIn(on, "desktop", true)).host?.installId).toBe("desktop");
    server.makeRoom();
    expect((await checkIn(on, "desktop", true)).host).toEqual({
      installId: "server", generation: 2, handoverFrom: "desktop", releasedThroughMs: null,
    });
  });

  describe("once it stops running automations", () => {
    it("starts the next computer after the relay's now, which the server never ran past", async () => {
      const { off, on } = await relays();
      await checkIn(off, "desktop", true);
      await checkIn(on, "desktop");
      await state(await send(on, "release", {
        installId: "desktop", generation: 2, releasedThroughMs: 9_000, groups: GROUPS, groupsWatched: 1, reach: REACH,
      }));
      // The server ran on after 9,000, in this process, until at most now.
      clock = 20_000;
      const moved = await checkIn(off, "laptop", true);
      expect(moved.host).toEqual({ installId: "laptop", generation: 4, handoverFrom: null, releasedThroughMs: 20_000 });

      // The progress never goes back, even when the relay's clock does.
      await checkIn(on, "laptop");
      await state(await send(on, "release", {
        installId: "laptop", generation: 5, releasedThroughMs: 25_000, groups: GROUPS, groupsWatched: 4, reach: REACH,
      }));
      clock = 15_000;
      const again = await checkIn(off, "laptop", true);
      expect(again.host).toEqual({ installId: "laptop", generation: 7, handoverFrom: null, releasedThroughMs: 25_000 });
    });

    it("starts the next computer after the latest schedule the server ran, when the relay's clock went back", async () => {
      const { off, on, storage } = await relays();
      await checkIn(on, "desktop", true);
      // The server's schedules ran through 30,000 before a restart set the clock back.
      storage.recordAutomationServerProgress({ workspaceId: WORKSPACE, throughMs: 30_000 });
      storage.recordAutomationServerProgress({ workspaceId: WORKSPACE, throughMs: 25_000 });
      clock = 20_000;
      const moved = await checkIn(off, "laptop", true);
      expect(moved.host).toEqual({ installId: "laptop", generation: 2, handoverFrom: null, releasedThroughMs: 30_000 });
    });

    it("keeps a placed computer placed across a handover it called off", async () => {
      const { off, on } = await relays();
      await checkIn(off, "desktop", true);
      expect((await checkIn(on, "desktop")).host?.handoverFrom).toBe("desktop");
      expect((await checkIn(off, "laptop")).host?.installId).toBe("desktop");
      expect((await checkIn(on, "desktop")).host).toEqual({
        installId: "server", generation: 4, handoverFrom: "desktop", releasedThroughMs: null,
      });
    });

    it("starts the computer the server was handing to when the owner chooses it again", async () => {
      const { off, on } = await relays();
      await checkIn(on, "desktop", true);
      await checkIn(on, "laptop");
      await state(await send(on, "choose", { installId: "laptop", generation: 1 }));
      const chosen = await state(await send(off, "choose", { installId: "laptop", generation: 2 }));
      expect(chosen.host).toEqual({ installId: "laptop", generation: 3, handoverFrom: null, releasedThroughMs: clock });
      expect(await groupMark(off, 3)).toEqual({ ok: true, generation: 3, groups: null, reach: null, everShared: false });
    });

    it("moves the host from the server to the next computer that claims it, from now", async () => {
      const { off, on } = await relays();
      await checkIn(on, "desktop", true);
      expect((await checkIn(off, "laptop")).host?.installId, "no claim").toBe("server");
      const moved = await checkIn(off, "desktop", true);
      expect(moved.host).toEqual({ installId: "desktop", generation: 2, handoverFrom: null, releasedThroughMs: clock });
      expect(moved.computers.map((computer) => computer.kind)).toEqual(["computer", "computer"]);
      expect(await groupMark(off, 2)).toEqual({ ok: true, generation: 2, groups: null, reach: null, everShared: false });
      // The relay placed it, so it goes back once the server runs automations again.
      expect((await checkIn(on, "desktop")).host?.installId).toBe("server");
    });

    it("ends the server's handover to a computer, which starts from now", async () => {
      const { off, on } = await relays();
      await checkIn(on, "desktop", true);
      await checkIn(on, "laptop");
      await state(await send(on, "choose", { installId: "laptop", generation: 1 }));
      const started = await checkIn(off, "desktop");
      expect(started.host).toEqual({ installId: "laptop", generation: 3, handoverFrom: null, releasedThroughMs: clock });
      expect(await groupMark(off, 3)).toEqual({ ok: true, generation: 3, groups: null, reach: null, everShared: false });
    });

    it("calls off a computer's handover to the server, since that computer still runs", async () => {
      const { off, on } = await relays();
      await checkIn(off, "desktop", true);
      await checkIn(on, "desktop");
      expect((await send(off, "take-over", { generation: 2 })).status, "the server cannot take over").toBe(400);
      const kept = await checkIn(off, "laptop");
      expect(kept.host).toEqual({ installId: "desktop", generation: 3, handoverFrom: null, releasedThroughMs: null });
    });

    it("starts a chosen computer from now instead of waiting for the server", async () => {
      const { off, on } = await relays();
      await checkIn(on, "desktop", true);
      await checkIn(off, "laptop");
      const chosen = await state(await send(off, "choose", { installId: "laptop", generation: 1 }));
      expect(chosen.host).toEqual({ installId: "laptop", generation: 2, handoverFrom: null, releasedThroughMs: clock });
      expect(await groupMark(off, 2)).toEqual({ ok: true, generation: 2, groups: null, reach: null, everShared: false });
    });
  });
});
