import { describe, expect, it, vi } from "vitest";
import type { SignIn } from "../server/account";
import { createServerClient } from "../server/client";
import { createOpenWorkspace } from "../server/openWorkspace";
import { pendingSignOuts, readRegistration, saveRegistration } from "../server/pushRegistration";
import { keptDisk, type KeptDisk } from "../server/testKeptDisk";
import { deferred, testServer, type Answer } from "../server/testServer";
import { createReadCache } from "../server/workspaceData";
import { createWorkspaceList } from "../server/workspaceList";
import { alertTarget, createAlerts, openTap, type NativeAlerts, type Permission } from "./alerts";

const TOKEN = "ab".repeat(32);
const PATH = "/sync/push/devices";
const OWNER = { origin: "https://dohc.example.com", userId: "u-1" };
const off = { status: 200, body: { ok: true, available: true, enabled: false, generation: null } };
const on = (generation: number) => ({
  status: 200,
  body: { ok: true, available: true, enabled: true, generation },
});

function fakeNative(initial: Permission = "undetermined") {
  let permission = initial;
  let token = TOKEN;
  let fetches = 0;
  let asking: Promise<void> = Promise.resolve();
  const asked: Permission[] = [];
  const tokenListeners = new Set<(token: string) => void>();
  const announce = () => {
    for (const listener of tokenListeners) listener(token);
  };
  const native: NativeAlerts = {
    permission: async () => permission,
    ask: async () => {
      asked.push(permission);
      await asking;
      if (permission === "undetermined") permission = "granted";
      return permission;
    },
    // As expo-notifications on iOS: each fetch registers again, and the registration announces the token.
    token: async () => {
      fetches += 1;
      announce();
      return token;
    },
    onToken(listener) {
      tokenListeners.add(listener);
      return () => tokenListeners.delete(listener);
    },
  };
  return {
    native,
    asked,
    fetches: () => fetches,
    holdAsk: (until: Promise<void>) => (asking = until),
    deny: () => (permission = "denied"),
    newToken(next: string) {
      token = next;
      announce();
    },
  };
}

function setup(options: { disk?: KeptDisk; permission?: Permission } = {}) {
  const server = testServer();
  const disk = options.disk ?? keptDisk();
  const store = disk.launch();
  const device = fakeNative(options.permission);
  let current = true;
  const signIn: SignIn = {
    origin: OWNER.origin,
    userId: OWNER.userId,
    email: "ice@example.com",
    isCurrent: () => current,
    client: createServerClient({
      origin: OWNER.origin,
      token: "t",
      fetch: server.fetch,
      signal: new AbortController().signal,
    }),
  };
  const alerts = createAlerts({ signIn, store, native: device.native, environment: "production" });
  const end = () => (current = false);
  return { server, disk, store, device, alerts, end };
}

const ready = (alerts: ReturnType<typeof createAlerts>) =>
  vi.waitFor(() => {
    const state = alerts.state();
    if (state.status === "loading" || (state.status === "ready" && state.busy))
      throw new Error("still loading");
    return state;
  });

describe("alerts", () => {
  it("stay off until turned on, ask then, bind the token, and keep the choice for the next launch", async () => {
    const { server, disk, store, device, alerts } = setup();
    server.on("GET", PATH, off);
    server.on("PUT", PATH, on(7));
    alerts.sync();
    expect(await ready(alerts)).toMatchObject({ status: "ready", on: false });
    expect(device.asked).toEqual([]);
    expect(server.paths()).toEqual([`GET ${PATH}`]);

    alerts.turnOn();
    await vi.waitFor(() => expect(alerts.state()).toMatchObject({ on: true, busy: false }));
    expect(device.asked).toEqual(["undetermined"]);
    expect(server.calls.at(-1)).toMatchObject({
      method: "PUT",
      body: { token: TOKEN, environment: "production" },
    });
    expect(alerts.generation()).toBe(7);
    expect(await readRegistration(store, OWNER)).toEqual({
      alerts: true,
      generation: 7,
      signingOut: false,
    });

    const relaunch = setup({ disk, permission: "granted" });
    relaunch.server.on("GET", PATH, on(7));
    relaunch.server.on("PUT", PATH, on(8));
    relaunch.alerts.sync();
    await vi.waitFor(() => expect(relaunch.alerts.generation()).toBe(8));
    expect(relaunch.device.asked).toEqual([]);
  });

  it("removes the binding at the server's generation when turned off", async () => {
    const { server, store, alerts } = setup({ permission: "granted" });
    await saveRegistration(store, OWNER, true, 3);
    server.on("GET", PATH, on(3), on(3));
    server.on("PUT", PATH, on(3));
    server.on("DELETE", PATH, off);
    alerts.sync();
    await vi.waitFor(() => expect(alerts.state()).toMatchObject({ on: true }));
    alerts.turnOff();
    await vi.waitFor(() => expect(alerts.state()).toMatchObject({ on: false, busy: false }));
    expect(server.calls.at(-1)).toMatchObject({ method: "DELETE", body: { generation: 3 } });
    expect(await readRegistration(store, OWNER)).toMatchObject({ alerts: false, generation: null });
  });

  it("show when the system denies them, and remove the binding until it allows them", async () => {
    const { server, store, device, alerts } = setup({ permission: "granted" });
    await saveRegistration(store, OWNER, true, 4);
    device.deny();
    server.on("GET", PATH, on(4));
    server.on("DELETE", PATH, off);
    alerts.sync();
    expect(await ready(alerts)).toMatchObject({ on: false, denied: true });
    expect(server.paths()).toEqual([`GET ${PATH}`, `DELETE ${PATH}`]);
  });

  it("say the server sends none, before any prompt", async () => {
    const { server, device, alerts } = setup();
    server.on("GET", PATH, { status: 200, body: { ok: true, available: false } });
    alerts.sync();
    expect(await ready(alerts)).toEqual({ status: "unavailable" });
    alerts.turnOn();
    expect(device.asked).toEqual([]);
  });

  it("fetch the token once per sync, though each fetch announces it again", async () => {
    const { server, device, store, alerts } = setup({ permission: "granted" });
    await saveRegistration(store, OWNER, true, 1);
    server.on("GET", PATH, on(1));
    server.on("PUT", PATH, on(1));
    await alerts.sync();
    await alerts.sync();
    expect(device.fetches()).toBe(2);
    expect(server.paths()).toEqual([`GET ${PATH}`, `PUT ${PATH}`, `GET ${PATH}`, `PUT ${PATH}`]);
  });

  it("bind a new token when the system replaces it, without fetching it again", async () => {
    const { server, device, store, alerts } = setup({ permission: "granted" });
    await saveRegistration(store, OWNER, true, 1);
    server.on("GET", PATH, on(1));
    server.on("PUT", PATH, on(1), on(2));
    await alerts.sync();
    device.newToken("cd".repeat(32));
    await vi.waitFor(() => expect(alerts.generation()).toBe(2));
    expect(device.fetches()).toBe(1);
    expect(server.calls.at(-1)!.body).toEqual({
      token: "cd".repeat(32),
      environment: "production",
    });
  });

  it("keep alerts off when turned off while a new token binds", async () => {
    const { server, store, device, alerts } = setup({ permission: "granted" });
    await saveRegistration(store, OWNER, true, 1);
    const bind = deferred<Answer>();
    server.on("GET", PATH, on(1), on(1), on(2));
    server.on("PUT", PATH, on(1), () => bind.promise);
    server.on("DELETE", PATH, off);
    await alerts.sync();
    device.newToken("cd".repeat(32));
    await vi.waitFor(() => expect(server.paths().at(-1)).toBe(`PUT ${PATH}`));
    const writes = vi.spyOn(store, "transaction");
    const turn = deferred<void>();
    const held = store.transaction(() => turn.promise);
    alerts.turnOff();
    await vi.waitFor(() => expect(writes).toHaveBeenCalledTimes(2));
    bind.resolve(on(2));
    // The token's sync has the answer once it queues a save behind the choice, or ends without one.
    await vi.waitFor(() => {
      if (writes.mock.calls.length < 3) expect(alerts.state()).toMatchObject({ busy: false });
    });
    turn.resolve();
    await held;
    await vi.waitFor(() => expect(alerts.state()).toMatchObject({ on: false, busy: false }));
    expect(server.paths().at(-1)).toBe(`DELETE ${PATH}`);
    expect(await readRegistration(store, OWNER)).toMatchObject({ alerts: false, generation: null });
  });

  it("save nothing once the sign-in ends during the prompt", async () => {
    const { server, store, device, alerts, end } = setup();
    server.on("GET", PATH, off);
    await alerts.sync();
    const prompt = deferred<void>();
    device.holdAsk(prompt.promise);
    alerts.turnOn();
    await vi.waitFor(() => expect(device.asked).toHaveLength(1));
    end();
    prompt.resolve();
    await store.transaction(async () => undefined);
    expect(await readRegistration(store, OWNER)).toBeNull();
  });

  it("save nothing once the sign-in ends while the save waits its turn", async () => {
    const { server, store, alerts, end } = setup({ permission: "granted" });
    await saveRegistration(store, OWNER, true, 2);
    server.on("GET", PATH, on(2));
    server.on("PUT", PATH, on(2));
    await alerts.sync();
    const turn = deferred<void>();
    const cleanup = store.transaction(async (sql) => {
      await turn.promise;
      await sql.run("DELETE FROM push_registrations", []);
    });
    alerts.turnOff();
    end();
    turn.resolve();
    await cleanup;
    await store.transaction(async () => undefined);
    expect(await readRegistration(store, OWNER)).toBeNull();
  });

  it("repeat a choice that failed to save on Try again", async () => {
    const { server, disk, store, alerts } = setup({ permission: "granted" });
    server.on("GET", PATH, off);
    server.on("PUT", PATH, on(6));
    await alerts.sync();
    disk.failWrites = /push_registrations/;
    alerts.turnOn();
    expect(await ready(alerts)).toMatchObject({ on: false, problem: "kept" });
    disk.failWrites = null;
    alerts.retry();
    await vi.waitFor(() => expect(alerts.state()).toMatchObject({ on: true, problem: null }));
    expect(await readRegistration(store, OWNER)).toMatchObject({ alerts: true, generation: 6 });
  });

  it("show a failure with the switch where it was, and change nothing once the sign-in ends", async () => {
    const { server, store, alerts, end } = setup({ permission: "granted" });
    await saveRegistration(store, OWNER, true, 5);
    server.on("GET", PATH, "offline");
    alerts.sync();
    expect(await ready(alerts)).toMatchObject({ on: true, problem: "offline" });

    const held = deferred<Answer>();
    server.on("GET", PATH, () => held.promise);
    server.on("PUT", PATH, on(9));
    const syncing = alerts.sync();
    await vi.waitFor(() => expect(server.calls).toHaveLength(2));
    end();
    held.resolve(on(5));
    await syncing;
    expect(server.paths()).not.toContain(`PUT ${PATH}`);
    expect(alerts.generation()).toBe(5);
    expect(await readRegistration(store, OWNER)).toMatchObject({ generation: 5 });
  });
});

describe("a pending Sign out's row", () => {
  it("holds until it ends, and alerts can't change it meanwhile", async () => {
    const store = keptDisk().launch();
    const rows = pendingSignOuts(store);
    await saveRegistration(store, OWNER, true, 2);
    await rows.begin(OWNER);
    expect(await rows.isPending(OWNER)).toBe(true);
    await saveRegistration(store, OWNER, true, 3);
    expect(await readRegistration(store, OWNER)).toEqual({
      alerts: true,
      generation: 2,
      signingOut: true,
    });
    expect(await rows.isPending({ ...OWNER, userId: "u-2" })).toBe(false);
    await rows.end(OWNER);
    expect(await readRegistration(store, OWNER)).toBeNull();
  });
});

describe("a tapped alert", () => {
  const list = [
    { workspaceId: "ws-1", name: "Trip", canOpen: true, showOnPhone: true },
    { workspaceId: "ws-2", name: "Work", canOpen: true, showOnPhone: false },
  ];
  const data = { generation: 4, workspaceId: "ws-1", threadId: "t-1", messageId: "m-1" };

  it("opens its message only for this sign-in's binding and a workspace the phone shows", () => {
    expect(alertTarget({ ...data, deliveryId: "d" }, 4, list)).toEqual({
      workspaceId: "ws-1",
      threadId: "t-1",
      messageId: "m-1",
    });
    expect(alertTarget(data, 5, list)).toBeNull();
    expect(alertTarget(data, null, list)).toBeNull();
    expect(alertTarget({ ...data, workspaceId: "ws-2" }, 4, list)).toBeNull();
    expect(alertTarget({ ...data, workspaceId: "ws-3" }, 4, list)).toBeNull();
    expect(alertTarget({ ...data, messageId: "" }, 4, list)).toBeNull();
    expect(alertTarget({ ...data, generation: "4" }, 4, list)).toBeNull();
  });

  function tapping() {
    const server = testServer();
    let current = true;
    const signIn: SignIn = {
      origin: OWNER.origin,
      userId: OWNER.userId,
      email: "ice@example.com",
      isCurrent: () => current,
      client: createServerClient({
        origin: OWNER.origin,
        token: "t",
        fetch: server.fetch,
        signal: new AbortController().signal,
      }),
    };
    const listed = (workspaces: unknown) => ({ status: 200, body: { ok: true, workspaces } });
    const tap = () => openTap(signIn, data, () => 4, null);
    return { server, signIn, listed, tap, end: () => (current = false) };
  }

  it("opens only what the server lists now, waits offline, and drops a tap the sign-in outlived", async () => {
    const { server, listed, tap, end } = tapping();
    server.on("GET", "/sync/account/workspaces", listed(list));
    expect(await tap()).toEqual({ workspaceId: "ws-1", threadId: "t-1", messageId: "m-1" });
    server.on("GET", "/sync/account/workspaces", listed([{ ...list[0], canOpen: false }]));
    expect(await tap()).toBe("home");
    server.on("GET", "/sync/account/workspaces", { status: 403, body: { ok: false } });
    expect(await tap()).toBe("home");
    server.on("GET", "/sync/account/workspaces", "offline");
    expect(await tap()).toBe("offline");
    const held = deferred<Answer>();
    server.on("GET", "/sync/account/workspaces", () => held.promise);
    const late = tap();
    end();
    held.resolve(listed(list));
    expect(await late).toBeNull();
  });

  it("opens its workspace on the phone, though the list the phone kept had it closed", async () => {
    const { server, signIn, listed } = tapping();
    server.on(
      "GET",
      "/sync/account/workspaces",
      listed([{ ...list[0], canOpen: false }]),
      listed(list),
    );
    const workspaces = createWorkspaceList(signIn);
    const open = createOpenWorkspace({ signIn, list: workspaces, cache: createReadCache() });
    open.subscribe(() => {});
    workspaces.reload();
    await vi.waitFor(() => expect(workspaces.state()).toMatchObject({ status: "ready" }));
    expect(open.state().currentWorkspaceId).toBeNull();
    expect(await openTap(signIn, data, () => 4, workspaces)).toMatchObject({ workspaceId: "ws-1" });
    open.choose("ws-1");
    expect(open.state().currentWorkspaceId).toBe("ws-1");
    open.stop();
  });

  it("keeps a workspace hidden that the person hid while the tap was reading the list", async () => {
    const { server, signIn, listed } = tapping();
    server.on("GET", "/sync/account/workspaces", listed(list));
    server.on("PATCH", "/sync/account/workspaces/ws-1", {
      status: 200,
      body: { ok: true, showOnPhone: false },
    });
    const workspaces = createWorkspaceList(signIn);
    workspaces.reload();
    await vi.waitFor(() => expect(workspaces.state()).toMatchObject({ status: "ready" }));
    const held = deferred<Answer>();
    server.on("GET", "/sync/account/workspaces", () => held.promise);
    const tapped = openTap(signIn, data, () => 4, workspaces);
    server.on("GET", "/sync/account/workspaces", listed([{ ...list[0], showOnPhone: false }]));
    workspaces.setShowOnPhone("ws-1", false);
    await vi.waitFor(() =>
      expect(workspaces.state()).toMatchObject({
        workspaces: [{ showOnPhone: false }],
        pending: new Set(),
      }),
    );
    held.resolve(listed(list));
    expect(await tapped).toBe("home");
    expect(workspaces.state()).toMatchObject({ workspaces: [{ showOnPhone: false }] });
  });
});
