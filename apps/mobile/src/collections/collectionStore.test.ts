import { describe, expect, it } from "vitest";
import { appTeardown } from "../apps/appStore";
import { createScopedEnds } from "../pages/pageLive";
import { createAccount } from "../server/account";
import { signedIn } from "../server/testApps";
import { deferred, memoryStore, testServer, type Answer, type Call } from "../server/testServer";
import { createWorkspaceCollections, type WorkspaceCollections } from "./collectionStore";

const D = "00000000-0000-4000-8000-000000000001";
const OPS = "/sync/ws-1/ops";
const table = (tableId: string, name: string) => ({
  tableId,
  name,
  primaryFieldId: "f-name",
  fields: [{ fieldId: "f-name", name: "Name", type: "text" }],
});
const description: Answer = {
  status: 200,
  body: {
    ok: true,
    result: {
      datasetId: D,
      name: "Registrations",
      tables: [table("t-people", "People"), table("t-notes", "Notes")],
    },
  },
};
const ok = (result: unknown): Answer => ({ status: 200, body: { ok: true, result } });
const records = (names: string[], next: string | null): Answer =>
  ok({
    status: "ready",
    rows: names.map((name) => ({ id: name, version: 1, values: { "f-name": name } })),
    nextCursor: next === null ? null : { id: next, value: next },
    files: {},
  });
const names = (rows: readonly { id: unknown }[] | undefined) => rows?.map((row) => row.id);
/** Waits until the server has had `count` requests. */
async function sent(server: ReturnType<typeof testServer>, count: number) {
  while (server.calls.length < count) await new Promise((done) => setTimeout(done, 0));
}

function setup(isCurrent = () => true) {
  const server = testServer();
  const stores = createScopedEnds();
  const collections = createWorkspaceCollections(signedIn(server, isCurrent), "ws-1", stores);
  server.on("POST", `${OPS}/collection`, description);
  return { server, stores, collections };
}

/** A signed-in account whose Sign out runs `hook` after the teardown, and its workspace's store, open on `D`. */
async function signedInStore(
  hook: (leave: () => Promise<void>, collections: WorkspaceCollections) => Promise<void>,
) {
  const server = testServer();
  const stored = { origin: server.origin, token: "tok", userId: "u-1", email: "a@example.com" };
  const stores = createScopedEnds();
  const teardown = appTeardown(stores);
  let collections: WorkspaceCollections | undefined;
  const account = createAccount({
    store: memoryStore(stored).store,
    fetch: server.fetch,
    onSignOut: teardown.signOut((leave) => hook(leave, collections!)),
  });
  teardown.follow(account);
  await account.restore();
  const state = account.state();
  if (state.status !== "signed-in") throw Error("not signed in");
  collections = createWorkspaceCollections(state.signIn, "ws-1", stores);
  server.on("POST", `${OPS}/collection`, description);
  pages(server);
  await collections.open(D);
  return { server, account, collections };
}

/** Answers the first page, then the page after `a1`, by the cursor each request sends. */
function pages(server: ReturnType<typeof testServer>) {
  server.on("POST", `${OPS}/collectionRecords`, (call: Call) => {
    const body = call.body as { tableId: string; after?: { id: string } };
    if (body.tableId === "t-notes") return ok({ status: "refused", reason: "no-read" });
    return body.after?.id === "a1" ? records(["a2"], null) : records(["a0", "a1"], "a1");
  });
}

describe("the Collections list", () => {
  it("pages through the list, and a refresh replaces it", async () => {
    const { server, collections } = setup();
    server.on(
      "POST",
      `${OPS}/collections`,
      ok({ collections: [{ datasetId: D, name: "Registrations" }], nextCursor: D }),
      ok({ collections: [{ datasetId: "d-2", name: "Signups" }], nextCursor: null }),
      ok({ collections: [], nextCursor: null }),
    );
    await collections.refresh();
    expect(collections.state().collections).toEqual([
      { datasetId: D, name: "Registrations" },
      { datasetId: "d-2", name: "Signups" },
    ]);
    expect(server.calls.map((call) => call.body)).toEqual([{}, { cursor: D }]);
    await collections.refresh();
    expect(collections.state().collections).toEqual([]);
  });

  it("counts a failed read, and keeps what it read before", async () => {
    const { server, collections } = setup();
    server.on(
      "POST",
      `${OPS}/collections`,
      ok({ collections: [{ datasetId: D, name: "Registrations" }], nextCursor: null }),
      { status: 503 },
    );
    await collections.refresh();
    await collections.refresh();
    expect(collections.state()).toEqual({
      collections: [{ datasetId: D, name: "Registrations" }],
      problem: "server-busy",
      failures: 1,
    });
  });
});

describe("a Collection's records", () => {
  it("reads the first table's first page, then the next as asked, and stops at the end", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    expect(collections.view()).toMatchObject({
      tableId: "t-people",
      next: { id: "a1", value: "a1" },
      reading: null,
    });
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1"]);
    await collections.more();
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1", "a2"]);
    expect(collections.view()?.next).toBeNull();
    const sent = server.calls.length;
    await collections.more();
    expect(server.calls.length).toBe(sent);
  });

  it("keeps an opened record through a refresh whose first page lacks it, and shows why a refresh failed", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    await collections.more();
    const a2 = collections.view()!.rows[2]!;
    collections.openRecord(a2);
    // A return to the foreground reads the first page again, which doesn't have it.
    await collections.reload();
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1"]);
    expect(collections.view()?.opened).toEqual({ tableId: "t-people", record: a2, files: {} });
    // One that has it takes its new values.
    server.on(
      "POST",
      `${OPS}/collectionRecords`,
      ok({
        status: "ready",
        rows: [{ id: "a2", version: 2, values: { "f-name": "A2" } }],
        nextCursor: null,
        files: { f: "x.png" },
      }),
    );
    await collections.reload();
    expect(collections.view()?.opened).toEqual({
      tableId: "t-people",
      record: { id: "a2", values: { "f-name": "A2" } },
      files: { f: "x.png" },
    });
    server.on("POST", `${OPS}/collection`, "offline");
    await collections.reload();
    expect(collections.view()).toMatchObject({
      problem: { cause: "offline", more: false },
      opened: { record: { id: "a2" } },
    });
  });

  it("keeps the records while it reads again, then replaces them from the first page", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    await collections.more();
    const held = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, () => held.promise);
    const reload = collections.reload();
    // The Collection, its first page, the next, then the Collection again and the held page.
    await sent(server, 5);
    expect(collections.view()?.reading).toBe("refresh");
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1", "a2"]);
    held.resolve(records(["b0"], null));
    await reload;
    expect(names(collections.view()?.rows)).toEqual(["b0"]);
    expect(server.calls.filter((call) => call.path.endsWith("/collection")).length).toBe(2);
  });

  it("drops a next page that a newer read of the table overtook", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    const held = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, () => held.promise, records(["c0"], null));
    const more = collections.more();
    await sent(server, 3);
    await collections.reload();
    held.resolve(records(["late"], null));
    await more;
    expect(names(collections.view()?.rows)).toEqual(["c0"]);
  });

  it("switches tables, and shows a table nothing reads as refused", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    await collections.chooseTable("t-notes");
    expect(collections.view()).toMatchObject({ tableId: "t-notes", refused: true, rows: [] });
    await collections.chooseTable("t-people");
    expect(collections.view()).toMatchObject({ tableId: "t-people", refused: false });
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1"]);
  });

  it("says why it couldn't read, and a failed next page keeps what shows", async () => {
    const { server, collections } = setup();
    server.on("POST", `${OPS}/collection`, { status: 404 });
    await collections.open(D);
    expect(collections.view()).toMatchObject({
      description: null,
      problem: { cause: "refused", more: false },
    });
    server.on("POST", `${OPS}/collection`, description);
    pages(server);
    await collections.reload();
    server.on("POST", `${OPS}/collectionRecords`, "offline");
    await collections.more();
    expect(collections.view()).toMatchObject({ problem: { cause: "offline", more: true } });
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1"]);
  });

  it("leaves the Collection on close, unless another replaced it", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    collections.close("other");
    expect(collections.view()?.datasetId).toBe(D);
    collections.close(D);
    expect(collections.view()).toBeNull();
  });
});

describe("teardown", () => {
  it("paints nothing from an answer that arrives after a workspace switch", async () => {
    const { server, stores, collections } = setup();
    const held = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, () => held.promise);
    const open = collections.open(D);
    await sent(server, 2);
    let painted = 0;
    collections.subscribe(() => painted++);
    appTeardown(stores).open("ws-2");
    expect(collections.view()).toBeNull();
    expect(painted).toBe(1);
    held.resolve(records(["late"], null));
    await open;
    expect(collections.view()).toBeNull();
    expect(collections.state().collections).toBeNull();
    expect(painted).toBe(1);
  });

  it("drops what it read before Sign out's delete, and at a 401", async () => {
    for (const end of ["sign-out", "401"] as const) {
      let atDelete: unknown = "not run";
      const { server, account, collections } = await signedInStore(async (leave, collections) => {
        atDelete = collections.view();
        await leave();
      });
      expect(names(collections.view()?.rows), end).toEqual(["a0", "a1"]);
      if (end === "sign-out") {
        await account.signOut();
        expect(atDelete, end).toBeNull();
      } else {
        server.on("POST", `${OPS}/collectionRecords`, { status: 401 });
        await collections.more();
      }
      expect(account.state().status, end).toBe("signed-out");
      expect(collections.view(), end).toBeNull();
    }
  });

  it("reads the same workspace again after a Sign out whose delete failed", async () => {
    let atDelete: unknown = "not run";
    const { server, account, collections } = await signedInStore(async (_leave, collections) => {
      atDelete = collections.view();
      throw new Error("not deleted");
    });
    await expect(account.signOut()).rejects.toThrow("not deleted");
    expect(atDelete).toBeNull();
    expect(account.state().status).toBe("signed-in");
    server.on(
      "POST",
      `${OPS}/collections`,
      ok({ collections: [{ datasetId: D, name: "Registrations" }], nextCursor: null }),
    );
    await collections.refresh();
    expect(collections.state().collections).toEqual([{ datasetId: D, name: "Registrations" }]);
    await collections.open(D);
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1"]);
  });

  it("reads nothing more once it has stopped", async () => {
    const { server, collections } = setup();
    collections.stop();
    await collections.refresh();
    await collections.open(D);
    expect(server.calls).toEqual([]);
    expect(collections.view()).toBeNull();
  });

  it("ends only the workspace that hides", async () => {
    const { server, stores, collections } = setup();
    pages(server);
    await collections.open(D);
    appTeardown(stores).hide("ws-2");
    expect(collections.view()?.datasetId).toBe(D);
    appTeardown(stores).hide("ws-1");
    expect(collections.view()).toBeNull();
  });

  it("lands nothing once its sign-in is no longer current", async () => {
    let current = true;
    const { server, collections } = setup(() => current);
    const held = deferred<Answer>();
    server.on("POST", `${OPS}/collections`, () => held.promise);
    const refresh = collections.refresh();
    current = false;
    held.resolve(ok({ collections: [{ datasetId: D, name: "Registrations" }], nextCursor: null }));
    await refresh;
    expect(collections.state().collections).toBeNull();
  });
});
