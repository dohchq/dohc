import { describe, expect, it, vi } from "vitest";
import { appTeardown } from "../apps/appStore";
import { createScopedEnds } from "../pages/pageLive";
import { createAccount } from "../server/account";
import { signedIn } from "../server/testApps";
import { cacheScope, createReadCache } from "../server/workspaceData";
import {
  deferred,
  memoryStore,
  serveSessionEnd,
  testServer,
  type Answer,
  type Call,
} from "../server/testServer";
import type { RecordValue } from "../server/phoneCollections";
import {
  canUndo,
  createWorkspaceCollections,
  newRecordKey,
  recordKey,
  type WorkspaceCollections,
} from "./collectionStore";

const D = "00000000-0000-4000-8000-000000000001";
const OPS = "/sync/ws-1/ops";
const SHA = "a".repeat(64);
const field = (fieldId: string, name: string, type: string, editable: boolean) => ({
  fieldId,
  name,
  type,
  editable,
  reversible: editable,
});
const table = (tableId: string, name: string) => ({
  tableId,
  name,
  primaryFieldId: "f-name",
  fields: [field("f-name", "Name", "text", true), field("f-paid", "Paid", "checkbox", false)],
  createFields: [],
  canCreate: true,
  canDelete: true,
});
const describedAs = (revision: number): Answer => ({
  status: 200,
  body: {
    ok: true,
    result: {
      datasetId: D,
      name: "Registrations",
      revision,
      revisionSha256: SHA,
      tables: [table("t-people", "People"), table("t-notes", "Notes")],
    },
  },
});
const description = describedAs(3);
const ok = (result: unknown): Answer => ({ status: 200, body: { ok: true, result } });
const records = (
  names: string[],
  next: string | null,
  relations: Record<string, Record<string, string>> = {},
): Answer =>
  ok({
    status: "ready",
    rows: names.map((name) => ({ id: name, version: 1, values: { "f-name": name } })),
    nextCursor: next === null ? null : { id: next, value: next },
    files: {},
    relations,
  });
const names = (rows: readonly { id: unknown }[] | undefined) => rows?.map((row) => row.id);
/** Waits until the server has had `count` requests. */
async function sent(server: ReturnType<typeof testServer>, count: number) {
  while (server.calls.length < count) await new Promise((done) => setTimeout(done, 0));
}

function setup(isCurrent = () => true, cache = createReadCache(), stores = createScopedEnds()) {
  const server = testServer();
  const collections = createWorkspaceCollections(
    signedIn(server, isCurrent),
    "ws-1",
    stores,
    cache,
  );
  server.on("POST", `${OPS}/collection`, description);
  return { server, stores, collections };
}

/** A signed-in account whose Sign out runs `hook` after the teardown, and its workspace's store, open on `D`. */
async function signedInStore(
  hook: (leave: () => Promise<void>, collections: WorkspaceCollections) => Promise<void>,
) {
  const server = testServer();
  serveSessionEnd(server);
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
  collections = createWorkspaceCollections(state.signIn, "ws-1", stores, createReadCache());
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

  it("empties at a 404 for the workspace, and a read on its way neither shows nor saves", async () => {
    const cache = createReadCache();
    const stores = createScopedEnds();
    const { server, collections } = setup(() => true, cache, stores);
    const late = deferred<Answer>();
    server.on("POST", `${OPS}/collections`, () => late.promise);
    const reading = collections.refresh();
    const scope = cacheScope(signedIn(server), "ws-1");
    cache.drop(scope);
    appTeardown(stores).hide("ws-1");
    late.resolve(ok({ collections: [{ datasetId: D, name: "Registrations" }], nextCursor: null }));
    await reading;
    expect(collections.state().collections).toBeNull();
    expect(cache.get(scope, "collections")).toBeUndefined();
  });

  it("neither shows nor saves a read that lands after its workspace's store stopped", async () => {
    const cache = createReadCache();
    const server = testServer();
    let open = true;
    const collections = createWorkspaceCollections(
      signedIn(server),
      "ws-1",
      createScopedEnds(),
      cache,
      "member",
      () => open,
    );
    const late = deferred<Answer>();
    server.on("POST", `${OPS}/collections`, () => late.promise);
    const reading = collections.refresh();
    open = false;
    late.resolve(ok({ collections: [{ datasetId: D, name: "Registrations" }], nextCursor: null }));
    await reading;
    expect(collections.state().collections).toBeNull();
    expect(
      cache.get(cacheScope(signedIn(server), "ws-1", "member"), "collections"),
    ).toBeUndefined();
  });

  it("shows the list read last at once in the workspace's next store", async () => {
    const cache = createReadCache();
    const { server, collections } = setup(() => true, cache);
    const listed = [{ datasetId: D, name: "Registrations" }];
    server.on("POST", `${OPS}/collections`, ok({ collections: listed, nextCursor: null }));
    await collections.refresh();
    collections.stop();
    const next = createWorkspaceCollections(signedIn(server), "ws-1", createScopedEnds(), cache);
    expect(next.state().collections).toEqual(listed);
    const other = createWorkspaceCollections(signedIn(server), "ws-2", createScopedEnds(), cache);
    expect(other.state().collections).toBeNull();
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
    expect(collections.view()?.opened).toEqual({
      tableId: "t-people",
      record: a2,
      files: {},
      relations: {},
    });
    // One that has it takes its new values.
    server.on(
      "POST",
      `${OPS}/collectionRecords`,
      ok({
        status: "ready",
        rows: [{ id: "a2", version: 2, values: { "f-name": "A2" } }],
        nextCursor: null,
        files: { f: "x.png" },
        relations: {},
      }),
    );
    await collections.reload();
    expect(collections.view()?.opened).toEqual({
      tableId: "t-people",
      record: { id: "a2", version: 2, values: { "f-name": "A2" } },
      files: { f: "x.png" },
      relations: {},
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

  it("shows a Collection opened again at once while it reads again, and keeps it through a failed read", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    collections.openRecord(collections.view()!.rows[0]!);
    collections.close(D);
    const held = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, () => held.promise);
    const reopen = collections.open(D);
    expect(collections.view()).toMatchObject({
      description: { name: "Registrations" },
      tableId: "t-people",
      reading: "first",
      opened: null,
    });
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1"]);
    held.resolve(records(["b0"], null));
    await reopen;
    expect(names(collections.view()?.rows)).toEqual(["b0"]);
    collections.close(D);
    server.on("POST", `${OPS}/collection`, "offline");
    await collections.open(D);
    expect(collections.view()).toMatchObject({ problem: { cause: "offline", more: false } });
    expect(names(collections.view()?.rows)).toEqual(["b0"]);
  });

  it("reads a reopened Collection's tables again when another table is chosen before they answer", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    collections.close(D);
    const held = deferred<Answer>();
    server.on("POST", `${OPS}/collection`, () => held.promise, { status: 404 });
    void collections.open(D);
    await collections.chooseTable("t-notes");
    expect(server.calls.filter((call) => call.path.endsWith("/collection"))).toHaveLength(3);
    expect(collections.view()).toMatchObject({
      description: null,
      rows: [],
      problem: { cause: "refused", more: false },
    });
    held.resolve(description);
  });

  it("reads a reopened Collection's tables again for a table chosen before its first page answers", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    collections.close(D);
    server.on("POST", `${OPS}/collection`, describedAs(4));
    const held = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, (call: Call) =>
      (call.body as { tableId: string }).tableId === "t-people"
        ? held.promise
        : ok({ status: "refused", reason: "no-read" }),
    );
    void collections.open(D);
    await sent(server, 4);
    await collections.chooseTable("t-notes");
    expect(server.calls.filter((call) => call.path.endsWith("/collection"))).toHaveLength(3);
    expect(collections.view()?.description?.revision).toBe(4);
    held.resolve(records(["late"], null));
  });

  it("clears a table's records when its next page refuses them, and keeps none of it on reopen", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    server.on("POST", `${OPS}/collectionRecords`, ok({ status: "refused", reason: "no-read" }));
    await collections.more();
    expect(collections.view()).toMatchObject({ refused: true, rows: [], files: {}, next: null });
    collections.close(D);
    server.on("POST", `${OPS}/collection`, () => new Promise<Answer>(() => {}));
    void collections.open(D);
    expect(collections.view()).toMatchObject({ description: null, rows: [] });
  });

  it("closes a record opened from a reopened Collection whose table or Collection is then refused", async () => {
    for (const refusal of [ok({ status: "refused", reason: "no-read" }), { status: 404 }]) {
      const { server, collections } = setup();
      pages(server);
      await collections.open(D);
      collections.close(D);
      const held = deferred<Answer>();
      server.on("POST", `${OPS}/collectionRecords`, () => held.promise);
      void collections.open(D);
      await sent(server, 4);
      collections.openRecord(collections.view()!.rows[0]!);
      expect(collections.view()?.opened).not.toBeNull();
      held.resolve(refusal);
      await vi.waitFor(() => expect(collections.view()?.reading).toBeNull());
      expect(collections.view()?.opened).toBeNull();
    }
  });

  it("keeps an open record and the rows when a reopened Collection's page is too large", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    collections.close(D);
    const held = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, () => held.promise);
    void collections.open(D);
    await sent(server, 4);
    collections.openRecord(collections.view()!.rows[0]!);
    held.resolve({ status: 413 });
    await vi.waitFor(() => expect(collections.view()?.reading).toBeNull());
    expect(collections.view()?.opened).not.toBeNull();
    expect(collections.view()?.rows.length).toBeGreaterThan(0);
  });

  it("clears what a Collection showed when the server refuses its records", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    server.on("POST", `${OPS}/collectionRecords`, { status: 404 });
    await collections.reload();
    expect(collections.view()).toMatchObject({
      description: null,
      rows: [],
      problem: { cause: "refused", more: false },
    });
  });

  it("shows a Collection the server refuses when opened again as on its first open, and forgets it", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    collections.close(D);
    server.on("POST", `${OPS}/collection`, { status: 404 });
    await collections.open(D);
    expect(collections.view()).toMatchObject({
      description: null,
      rows: [],
      problem: { cause: "refused", more: false },
    });
    collections.close(D);
    server.on("POST", `${OPS}/collection`, () => new Promise<Answer>(() => {}));
    void collections.open(D);
    expect(collections.view()).toMatchObject({ description: null, rows: [], problem: null });
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

describe("a record's change", () => {
  const KEY = recordKey(D, "t-people", "a0");
  const EDIT = `${OPS}/collectionEdit`;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  /** A store open on record `a0`. */
  async function onRecord() {
    const f = setup();
    pages(f.server);
    await f.collections.open(D);
    f.collections.openRecord(f.collections.view()!.rows[0]!);
    return f;
  }
  const state = (collections: WorkspaceCollections) => collections.changes().get(KEY)?.state;
  /** Waits until the record's change has an answer. */
  async function answered(collections: WorkspaceCollections) {
    while (state(collections)?.kind === "saving") await new Promise((done) => setTimeout(done, 0));
  }
  const edits = (server: ReturnType<typeof testServer>) =>
    server.calls.filter((call) => call.path === EDIT).map((call) => call.body);
  /** Opens the field's editor and saves `value` at once. */
  const change = (collections: WorkspaceCollections, fieldId: string, value: RecordValue) => {
    const edit = collections.edit(fieldId);
    if (edit) collections.change(edit, value);
  };
  const page = (
    rows: unknown[],
    files: Record<string, string> = {},
    relations: Record<string, Record<string, string>> = {},
  ) => ok({ status: "ready", rows, nextCursor: null, files, relations });

  it("sends the field's change with a random key and the rules' stamp, then shows it saved, with Undo", async () => {
    const { server, collections } = await onRecord();
    server.on(
      "POST",
      EDIT,
      ok({ saved: { version: 2, priorValue: "a0" } }),
      ok({ saved: { version: 3, priorValue: "Maya" } }),
    );
    change(collections, "f-name", "Maya");
    expect(state(collections)).toEqual({ kind: "saving" });
    await answered(collections);
    const [sent] = edits(server) as [Record<string, unknown>];
    expect(sent).toEqual({
      datasetId: D,
      tableId: "t-people",
      recordId: "a0",
      fieldId: "f-name",
      value: "Maya",
      expectedVersion: 1,
      revision: 3,
      revisionSha256: SHA,
      idempotencyKey: expect.stringMatching(UUID),
    });
    expect(state(collections)).toEqual({ kind: "saved", version: 2, priorValue: "a0" });
    const shown = { id: "a0", version: 2, values: { "f-name": "Maya" } };
    expect(collections.view()?.opened?.record).toEqual(shown);
    expect(collections.view()?.rows[0]).toEqual(shown);
    expect(canUndo(collections.changes().get(KEY))).toBe(true);

    // Undo: the prior value at the saved version, under the same stamp, with a new key.
    collections.undo(KEY);
    await answered(collections);
    const undo = edits(server)[1] as Record<string, unknown>;
    expect(undo).toMatchObject({ value: "a0", expectedVersion: 2, revision: 3 });
    expect(undo.idempotencyKey).not.toBe(sent.idempotencyKey);
    expect(collections.view()?.opened?.record).toEqual({
      id: "a0",
      version: 3,
      values: { "f-name": "a0" },
    });
    // An Undo has no Undo of its own.
    expect(canUndo(collections.changes().get(KEY))).toBe(false);
  });

  it("offers no Undo for an edit that gave no prior value", async () => {
    const { server, collections } = await onRecord();
    server.on("POST", EDIT, ok({ saved: { version: 2 } }));
    change(collections, "f-name", "Maya");
    await answered(collections);
    expect(canUndo(collections.changes().get(KEY))).toBe(false);
    collections.undo(KEY);
    expect(edits(server)).toHaveLength(1);
  });

  it("keeps a change that got no answer, and Try again sends it with the same key and stamp", async () => {
    const { server, collections } = await onRecord();
    server.on("POST", EDIT, "offline", { status: 503 }, ok({ saved: { version: 2 } }));
    change(collections, "f-name", "Maya");
    await answered(collections);
    expect(state(collections)).toEqual({ kind: "failed", problem: "offline" });
    // The record shows what the server last said.
    expect(collections.view()?.opened?.record.values).toEqual({ "f-name": "a0" });
    collections.retry(KEY);
    await answered(collections);
    expect(state(collections)).toEqual({ kind: "failed", problem: "server-busy" });
    collections.retry(KEY);
    await answered(collections);
    expect(state(collections)).toEqual({ kind: "saved", version: 2 });
    const [first, ...tries] = edits(server);
    expect(tries).toEqual([first, first]);
  });

  it("sends nothing for a field it can't change, or while the record's last change is saving", async () => {
    const { server, collections } = await onRecord();
    expect(collections.edit("f-paid")).toBeNull();
    const held = deferred<Answer>();
    server.on("POST", EDIT, () => held.promise);
    change(collections, "f-name", "Maya");
    change(collections, "f-name", "Other");
    collections.discard(KEY);
    await sent(server, 3);
    expect(edits(server)).toHaveLength(1);
    expect(state(collections)).toEqual({ kind: "saving" });
    held.resolve(ok({ saved: { version: 2 } }));
    await answered(collections);
    expect(state(collections)?.kind).toBe("saved");
  });

  it("shows a refusal and a rules change, and Discard drops either", async () => {
    const { server, collections } = await onRecord();
    const refusal = { code: "stale_record", message: "This record changed." };
    server.on("POST", EDIT, ok({ refused: refusal }), ok({ rulesChanged: true }));
    change(collections, "f-name", "Maya");
    await answered(collections);
    expect(state(collections)).toEqual({ kind: "refused", ...refusal });
    collections.discard(KEY);
    expect(collections.changes().size).toBe(0);
    change(collections, "f-name", "Maya");
    await answered(collections);
    expect(state(collections)).toEqual({ kind: "rulesChanged" });
    // Try again is only for a change with no answer.
    collections.retry(KEY);
    expect(edits(server)).toHaveLength(2);
  });

  it("reads the rules and the record again on Reload, and drops its change", async () => {
    const { server, collections } = await onRecord();
    server.on("POST", EDIT, ok({ rulesChanged: true }));
    change(collections, "f-name", "Maya");
    await answered(collections);
    server.on("POST", `${OPS}/collection`, describedAs(4));
    server.on(
      "POST",
      `${OPS}/collectionRecords`,
      ok({
        status: "ready",
        rows: [{ id: "a0", version: 5, values: { "f-name": "Ana" } }],
        nextCursor: null,
        files: {},
        relations: {},
      }),
    );
    expect(await collections.reloadRecord()).toBe(true);
    expect(server.calls.at(-1)?.body).toEqual({
      datasetId: D,
      tableId: "t-people",
      recordId: "a0",
    });
    expect(collections.changes().size).toBe(0);
    const fresh = { id: "a0", version: 5, values: { "f-name": "Ana" } };
    expect(collections.view()?.opened?.record).toEqual(fresh);
    expect(collections.view()?.rows[0]).toEqual(fresh);
    expect(collections.view()?.description?.revision).toBe(4);
    // The next change names the new version and rules.
    server.on("POST", EDIT, ok({ saved: { version: 6 } }));
    change(collections, "f-name", "Maya");
    await answered(collections);
    expect(edits(server).at(-1)).toMatchObject({ expectedVersion: 5, revision: 4 });
  });

  it("leaves a record that's gone on Reload, and keeps the change when Reload fails", async () => {
    const { server, collections } = await onRecord();
    server.on("POST", EDIT, ok({ refused: { code: "stale_record", message: "Changed." } }));
    change(collections, "f-name", "Maya");
    await answered(collections);
    server.on("POST", `${OPS}/collection`, "offline");
    expect(await collections.reloadRecord()).toBe(false);
    expect(state(collections)?.kind).toBe("refused");
    expect(collections.view()?.problem).toEqual({ cause: "offline", more: false });
    server.on("POST", `${OPS}/collection`, description);
    server.on(
      "POST",
      `${OPS}/collectionRecords`,
      ok({ status: "ready", rows: [], nextCursor: null, files: {}, relations: {} }),
    );
    expect(await collections.reloadRecord()).toBe(false);
    expect(collections.view()?.opened).toBeNull();
    expect(names(collections.view()?.rows)).toEqual(["a1"]);
  });

  it("saves against the version and rules its editor opened with, not a refresh's", async () => {
    const { server, collections } = await onRecord();
    const edit = collections.edit("f-name")!;
    // A return to the foreground reads version 2 and new rules while the editor is open.
    server.on("POST", `${OPS}/collection`, describedAs(4));
    server.on(
      "POST",
      `${OPS}/collectionRecords`,
      page([{ id: "a0", version: 2, values: { "f-name": "Ana" } }]),
    );
    await collections.reload();
    expect(collections.view()?.opened?.record.version).toBe(2);
    server.on("POST", EDIT, ok({ refused: { code: "stale_record", message: "Changed." } }));
    collections.change(edit, "Maya");
    await answered(collections);
    expect(edits(server)).toEqual([
      expect.objectContaining({ value: "Maya", expectedVersion: 1, revision: 3 }),
    ]);
    expect(state(collections)?.kind).toBe("refused");
  });

  it("keeps a confirmed edit over an older read that lands after it, from the table or Reload", async () => {
    const { server, collections } = await onRecord();
    const held = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, () => held.promise);
    const refresh = collections.reload();
    await sent(server, 4);
    server.on("POST", EDIT, ok({ saved: { version: 2, priorValue: "a0" } }));
    change(collections, "f-name", "Maya");
    await answered(collections);
    held.resolve(records(["a0", "a1"], null));
    await refresh;
    const saved = { id: "a0", version: 2, values: { "f-name": "Maya" } };
    expect(collections.view()?.rows).toEqual([
      saved,
      { id: "a1", version: 1, values: { "f-name": "a1" } },
    ]);
    expect(collections.view()?.opened?.record).toEqual(saved);
    server.on(
      "POST",
      `${OPS}/collectionRecords`,
      page([{ id: "a0", version: 1, values: { "f-name": "a0" } }]),
    );
    expect(await collections.reloadRecord()).toBe(true);
    expect(collections.view()?.opened?.record).toEqual(saved);
    expect(collections.view()?.rows[0]).toEqual(saved);
  });

  it("keeps a later read over a replayed receipt for an older version", async () => {
    const { server, collections } = await onRecord();
    server.on("POST", EDIT, "offline", ok({ saved: { version: 2, priorValue: "a0" } }));
    change(collections, "f-name", "Maya");
    await answered(collections);
    // The first try saved version 2; a later change elsewhere made version 3, which a refresh reads.
    server.on(
      "POST",
      `${OPS}/collectionRecords`,
      page([{ id: "a0", version: 3, values: { "f-name": "Ana" } }]),
    );
    await collections.reload();
    collections.retry(KEY);
    await answered(collections);
    expect(state(collections)).toMatchObject({ kind: "saved", version: 2 });
    const later = { id: "a0", version: 3, values: { "f-name": "Ana" } };
    expect(collections.view()?.opened?.record).toEqual(later);
    expect(collections.view()?.rows[0]).toEqual(later);
  });

  it("lands no Reload once its screen closes, another record opens, or a newer Reload starts", async () => {
    const { server, collections } = await onRecord();
    const read = (version: number) =>
      page([{ id: "a0", version, values: { "f-name": `v${version}` } }]);
    const version = () => collections.view()?.opened?.record.version;

    const closing = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, () => closing.promise);
    const closed = collections.reloadRecord();
    await sent(server, 4);
    collections.closeRecord();
    closing.resolve(read(5));
    expect(await closed).toBe(false);
    expect(version()).toBe(1);

    const opening = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, () => opening.promise);
    const other = collections.reloadRecord();
    await sent(server, 6);
    collections.openRecord(collections.view()!.rows[1]!);
    opening.resolve(read(6));
    expect(await other).toBe(false);
    expect(collections.view()?.opened?.record.id).toBe("a1");

    collections.openRecord(collections.view()!.rows[0]!);
    const slow = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, () => slow.promise, read(8));
    const first = collections.reloadRecord();
    await sent(server, 8);
    expect(await collections.reloadRecord()).toBe(true);
    slow.resolve(read(9));
    expect(await first).toBe(false);
    expect(version()).toBe(8);
  });

  it("keeps a change made while Reload reads", async () => {
    const { server, collections } = await onRecord();
    server.on("POST", EDIT, ok({ refused: { code: "stale_record", message: "Changed." } }));
    change(collections, "f-name", "Maya");
    await answered(collections);
    const held = deferred<Answer>();
    server.on("POST", `${OPS}/collectionRecords`, () => held.promise);
    const reload = collections.reloadRecord();
    await sent(server, 5);
    server.on("POST", EDIT, "offline");
    change(collections, "f-name", "Ana");
    await answered(collections);
    held.resolve(page([{ id: "a0", version: 1, values: { "f-name": "a0" } }]));
    expect(await reload).toBe(true);
    expect(state(collections)).toEqual({ kind: "failed", problem: "offline" });
    expect(collections.changes().get(KEY)?.change.value).toBe("Ana");
  });

  it("opens no editor while the record's change is saving", async () => {
    const { server, collections } = await onRecord();
    const held = deferred<Answer>();
    server.on("POST", EDIT, () => held.promise);
    change(collections, "f-name", "Maya");
    expect(collections.edit("f-name")).toBeNull();
    held.resolve(ok({ saved: { version: 2 } }));
    await answered(collections);
    expect(collections.edit("f-name")).not.toBeNull();
  });

  it("takes Reload's file names, and clears the view's problem", async () => {
    const { server, collections } = await onRecord();
    server.on("POST", `${OPS}/collectionRecords`, "offline");
    await collections.more();
    expect(collections.view()?.problem).toEqual({ cause: "offline", more: true });
    server.on(
      "POST",
      `${OPS}/collectionRecords`,
      page([{ id: "a0", version: 2, values: { "f-name": "a0" } }], { "file-1": "receipt.pdf" }),
    );
    expect(await collections.reloadRecord()).toBe(true);
    expect(collections.view()?.opened?.files).toEqual({ "file-1": "receipt.pdf" });
    expect(collections.view()?.files).toEqual({ "file-1": "receipt.pdf" });
    expect(collections.view()?.problem).toBeNull();
  });

  it("lands a change's answer after the Collection closes", async () => {
    const { server, collections } = await onRecord();
    const held = deferred<Answer>();
    server.on("POST", EDIT, () => held.promise);
    change(collections, "f-name", "Maya");
    collections.close(D);
    held.resolve(ok({ saved: { version: 2 } }));
    await answered(collections);
    expect(state(collections)).toEqual({ kind: "saved", version: 2 });
  });

  it("drops a change, and its late answer, at a workspace switch", async () => {
    const { server, stores, collections } = await onRecord();
    const held = deferred<Answer>();
    server.on("POST", EDIT, () => held.promise);
    change(collections, "f-name", "Maya");
    await sent(server, 3);
    appTeardown(stores).open("ws-2");
    expect(collections.changes().size).toBe(0);
    let painted = 0;
    collections.subscribe(() => painted++);
    held.resolve(ok({ saved: { version: 2 } }));
    await new Promise((done) => setTimeout(done, 0));
    expect(collections.changes().size).toBe(0);
    expect(collections.view()).toBeNull();
    expect(painted).toBe(0);
  });
});

describe("a new record and a deletion", () => {
  const CREATE = `${OPS}/collectionCreate`;
  const DELETE = `${OPS}/collectionDelete`;
  const EDIT = `${OPS}/collectionEdit`;
  const RECORDS = `${OPS}/collectionRecords`;
  const NEW = newRecordKey(D, "t-people");
  const A0 = recordKey(D, "t-people", "a0");
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const row = (id: string, version = 1, name = id) => ({ id, version, values: { "f-name": name } });
  // The server's starting values, which the create's answer doesn't carry.
  const N1 = { id: "n1", version: 1, values: { "f-name": "", "f-paid": true } };
  const created = ok({ saved: { id: "n1", version: 1 } });
  const bodies = (server: ReturnType<typeof testServer>, path: string) =>
    server.calls.filter((call) => call.path === path).map((call) => call.body);
  const tick = () => new Promise((done) => setTimeout(done, 0));
  /** The server's People in key order, read two at a time, or one by its key. */
  const people =
    (stored: Map<string, unknown>) =>
    (call: Call): Answer => {
      const body = call.body as { after?: { id: string }; recordId?: string };
      const ids = [...stored.keys()].sort();
      const all = ids.map((id) => stored.get(id));
      if (body.recordId !== undefined)
        return ok({
          status: "ready",
          rows: stored.has(body.recordId) ? [stored.get(body.recordId)] : [],
          nextCursor: null,
          files: {},
          relations: {},
        });
      const start = body.after ? ids.indexOf(body.after.id) + 1 : 0;
      const last = start + 2 < ids.length ? ids[start + 1]! : null;
      return ok({
        status: "ready",
        rows: all.slice(start, start + 2),
        nextCursor: last === null ? null : { id: last, value: last },
        files: {},
        relations: {},
      });
    };
  /** Saves `record` on the server, then answers that it saved. */
  const adds =
    (stored: Map<string, unknown>, record: { id: string } = N1, answer: Answer = created) =>
    () => {
      stored.set(record.id, record);
      return answer;
    };
  const deletes = (stored: Map<string, unknown>) => (call: Call) => {
    stored.delete((call.body as { recordId: string }).recordId);
    return ok({ saved: {} });
  };
  async function onList() {
    const f = setup();
    const stored = new Map<string, unknown>(["a0", "a1", "a2"].map((id) => [id, row(id)]));
    f.server.on("POST", RECORDS, people(stored));
    await f.collections.open(D);
    return { ...f, stored };
  }
  async function onRecord() {
    const f = await onList();
    f.collections.openRecord(f.collections.view()!.rows[0]!);
    return f;
  }
  async function settled(collections: WorkspaceCollections, key: string) {
    while (collections.actions().get(key)?.state.kind === "saving") await tick();
  }
  async function read(collections: WorkspaceCollections) {
    while (collections.view()?.reading) await tick();
  }

  it("adds a record with a random key and the rules' stamp, lists it first, and opens it as the server has it", async () => {
    const { server, collections, stored } = await onList();
    server.on("POST", CREATE, adds(stored));
    expect(await collections.create()).toBe(true);
    expect(bodies(server, CREATE)).toEqual([
      {
        datasetId: D,
        tableId: "t-people",
        revision: 3,
        revisionSha256: SHA,
        idempotencyKey: expect.stringMatching(UUID),
      },
    ]);
    expect(bodies(server, RECORDS).at(-1)).toEqual({
      datasetId: D,
      tableId: "t-people",
      recordId: "n1",
    });
    expect(collections.view()?.rows[0]).toEqual(N1);
    expect(names(collections.view()?.rows)).toEqual(["n1", "a0", "a1"]);
    expect(collections.view()?.opened).toEqual({
      tableId: "t-people",
      record: N1,
      files: {},
      relations: {},
    });
    expect(collections.actions().size).toBe(0);
  });

  it("lists a new record, but doesn't open it, when a record opened while it saved", async () => {
    const { server, collections, stored } = await onList();
    const held = deferred<Answer>();
    server.on("POST", CREATE, () => held.promise);
    const adding = collections.create();
    // A second press while it saves sends nothing.
    expect(await collections.create()).toBe(false);
    collections.openRecord(collections.view()!.rows[1]!);
    stored.set("n1", N1);
    held.resolve(created);
    expect(await adding).toBe(false);
    expect(names(collections.view()?.rows)).toEqual(["n1", "a0", "a1"]);
    expect(collections.view()?.opened?.record.id).toBe("a1");
    expect(bodies(server, CREATE)).toHaveLength(1);
  });

  it("keeps a new record that got no answer, and Try again sends the same key and stamp", async () => {
    const { server, collections, stored } = await onList();
    server.on("POST", CREATE, "offline", adds(stored));
    expect(await collections.create()).toBe(false);
    expect(collections.actions().get(NEW)?.state).toEqual({ kind: "failed", problem: "offline" });
    // It may have saved, so another waits for Try again or Discard.
    expect(await collections.create()).toBe(false);
    expect(bodies(server, CREATE)).toHaveLength(1);
    expect(await collections.retryAction(NEW)).toBe(true);
    const [first, again] = bodies(server, CREATE);
    expect(again).toEqual(first);
    expect(collections.view()?.opened?.record.id).toBe("n1");
  });

  it("shows a replayed new record as it is now: changed since, or gone", async () => {
    const { server, collections, stored } = await onList();
    // It saved, but its answer was lost; Try again replays the first answer.
    server.on("POST", CREATE, adds(stored, N1, "offline"), created);
    expect(await collections.create()).toBe(false);
    await collections.more();
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1", "a2", "n1"]);
    collections.openRecord(collections.view()!.rows[3]!);
    server.on("POST", EDIT, () => {
      stored.set("n1", { ...N1, version: 2, values: { ...N1.values, "f-name": "Maya" } });
      return ok({ saved: { version: 2, priorValue: "" } });
    });
    collections.change(collections.edit("f-name")!, "Maya");
    while (collections.changes().get(recordKey(D, "t-people", "n1"))?.state.kind === "saving")
      await tick();
    expect(await collections.retryAction(NEW)).toBe(true);
    expect(collections.view()?.opened?.record).toEqual({
      id: "n1",
      version: 2,
      values: { "f-name": "Maya", "f-paid": true },
    });
    expect(names(collections.view()?.rows)).toEqual(["n1", "a0", "a1", "a2"]);
    expect(collections.edit("f-name")?.from.expectedVersion).toBe(2);

    // Deleted before Try again: it doesn't come back.
    const gone = await onList();
    gone.server.on("POST", CREATE, adds(gone.stored, N1, "offline"), created);
    gone.server.on("POST", DELETE, deletes(gone.stored));
    await gone.collections.create();
    await gone.collections.more();
    gone.collections.openRecord(gone.collections.view()!.rows[3]!);
    gone.collections.remove();
    await settled(gone.collections, recordKey(D, "t-people", "n1"));
    expect(await gone.collections.retryAction(NEW)).toBe(false);
    expect(names(gone.collections.view()?.rows)).toEqual(["a0", "a1", "a2"]);
    expect(gone.collections.actions().get(NEW)).toBeUndefined();
    expect(gone.collections.actions().get(recordKey(D, "t-people", "n1"))?.state).toEqual({
      kind: "saved",
    });
  });

  it("keeps a new record over a read of the table that started before it saved", async () => {
    const { server, collections, stored } = await onList();
    const answer = people(stored);
    const late = deferred<void>();
    let first = true;
    server.on("POST", RECORDS, (call: Call) => {
      const now = answer(call);
      if (!first) return now;
      first = false;
      return late.promise.then(() => now);
    });
    // `a00` sorts into the first page.
    const A00 = row("a00");
    server.on("POST", CREATE, adds(stored, A00, ok({ saved: { id: "a00", version: 1 } })));
    const reading = collections.reload();
    await sent(server, 4);
    expect(await collections.create()).toBe(true);
    late.resolve();
    await reading;
    await read(collections);
    expect(names(collections.view()?.rows)).toEqual(["a0", "a00"]);
    expect(collections.view()?.opened?.record).toEqual(A00);
  });

  it("lists a new record once when a next page holds it too", async () => {
    const { server, collections, stored } = await onList();
    server.on("POST", CREATE, adds(stored));
    await collections.create();
    await collections.more();
    expect(names(collections.view()?.rows)).toEqual(["n1", "a0", "a1", "a2"]);
  });

  it("takes a next page's newer version of a record it already lists", async () => {
    const { server, collections, stored } = await onList();
    server.on("POST", CREATE, adds(stored));
    await collections.create();
    // Another device changes the new record before the next page brings it.
    stored.set("n1", { ...N1, version: 2, values: { ...N1.values, "f-name": "Maya" } });
    await collections.more();
    const listed = collections.view()?.rows.find((row) => row.id === "n1");
    expect(listed?.version).toBe(2);
    collections.openRecord(listed!);
    expect(collections.edit("f-name")?.from.expectedVersion).toBe(2);
  });

  it("doesn't bring back a record deleted while a replayed create read it back", async () => {
    const { server, collections, stored } = await onList();
    const answer = people(stored);
    const held = deferred<void>();
    let holding = false;
    server.on("POST", RECORDS, (call: Call) => {
      const now = answer(call);
      const byKey = (call.body as { recordId?: unknown }).recordId !== undefined;
      if (!holding || !byKey) return now;
      holding = false;
      return held.promise.then(() => now);
    });
    server.on("POST", CREATE, adds(stored, N1, "offline"), created);
    server.on("POST", DELETE, deletes(stored));
    await collections.create();
    await collections.more();
    // Try again replays the create; its read-back is held until after the deletion saves.
    holding = true;
    const retried = collections.retryAction(NEW);
    while (holding) await tick();
    collections.openRecord(collections.view()!.rows.find((row) => row.id === "n1")!);
    collections.remove();
    await settled(collections, recordKey(D, "t-people", "n1"));
    held.resolve();
    expect(await retried).toBe(false);
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1", "a2"]);
    expect(collections.actions().get(recordKey(D, "t-people", "n1"))?.state).toEqual({
      kind: "saved",
    });
  });

  it("deletes the open record, drops its row, and keeps a read that started before from showing it", async () => {
    const { server, collections, stored } = await onRecord();
    const answer = people(stored);
    const late = deferred<void>();
    let first = true;
    server.on("POST", RECORDS, (call: Call) => {
      const now = answer(call);
      if (!first) return now;
      first = false;
      return late.promise.then(() => now);
    });
    server.on("POST", DELETE, deletes(stored));
    const reading = collections.reload();
    await sent(server, 4);
    collections.remove();
    await settled(collections, A0);
    expect(bodies(server, DELETE)).toEqual([
      {
        datasetId: D,
        tableId: "t-people",
        recordId: "a0",
        expectedVersion: 1,
        revision: 3,
        revisionSha256: SHA,
        idempotencyKey: expect.stringMatching(UUID),
      },
    ]);
    expect(collections.actions().get(A0)?.state).toEqual({ kind: "saved" });
    // Its screen takes no change and no second deletion.
    expect(collections.edit("f-name")).toBeNull();
    collections.remove();
    expect(bodies(server, DELETE)).toHaveLength(1);
    late.resolve();
    await reading;
    await read(collections);
    expect(names(collections.view()?.rows)).toEqual(["a1", "a2"]);
  });

  it("shows a deleted record that was added again, and lets it change", async () => {
    const { server, collections, stored } = await onRecord();
    server.on("POST", DELETE, deletes(stored));
    collections.remove();
    await settled(collections, A0);
    stored.set("a0", row("a0", 1, "Again"));
    await collections.reload();
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1"]);
    collections.openRecord(collections.view()!.rows[0]!);
    expect(collections.actions().size).toBe(0);
    expect(collections.edit("f-name")?.from.value).toBe("Again");
  });

  it("keeps a record whose deletion was refused, and Discard lets it be deleted again with a new key", async () => {
    const { server, collections, stored } = await onRecord();
    const refusal = { code: "stale_record", message: "This record changed." };
    server.on("POST", DELETE, ok({ refused: refusal }), deletes(stored));
    collections.remove();
    await settled(collections, A0);
    expect(collections.actions().get(A0)?.state).toEqual({ kind: "refused", ...refusal });
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1"]);
    // Try again is only for one with no answer.
    await collections.retryAction(A0);
    expect(bodies(server, DELETE)).toHaveLength(1);
    collections.discardAction(A0);
    expect(collections.actions().size).toBe(0);
    collections.remove();
    await settled(collections, A0);
    const [first, second] = bodies(server, DELETE) as [
      { idempotencyKey: string },
      { idempotencyKey: string },
    ];
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(names(collections.view()?.rows)).toEqual(["a1"]);
  });

  it("deletes nothing while a change to the record saves, and changes nothing while it deletes", async () => {
    const { server, collections } = await onRecord();
    const held = deferred<Answer>();
    server.on("POST", EDIT, () => held.promise);
    server.on("POST", DELETE, ok({ saved: {} }));
    collections.change(collections.edit("f-name")!, "Maya");
    collections.remove();
    expect(bodies(server, DELETE)).toHaveLength(0);
    held.resolve(ok({ saved: { version: 2 } }));
    while (collections.changes().get(A0)?.state.kind === "saving") await tick();
    collections.remove();
    expect(collections.edit("f-name")).toBeNull();
    await settled(collections, A0);
    // At the version the saved change left it.
    expect(bodies(server, DELETE)).toEqual([expect.objectContaining({ expectedVersion: 2 })]);
    expect(collections.changes().size).toBe(0);
  });

  it("sends no Try again of a change while the record deletes, nor of a deletion while it changes", async () => {
    const one = await onRecord();
    const removing = deferred<Answer>();
    one.server.on("POST", EDIT, "offline");
    one.server.on("POST", DELETE, () => removing.promise);
    one.collections.change(one.collections.edit("f-name")!, "Maya");
    while (one.collections.changes().get(A0)?.state.kind === "saving") await tick();
    one.collections.remove();
    one.collections.retry(A0);
    expect(bodies(one.server, EDIT)).toHaveLength(1);
    removing.resolve(ok({ saved: {} }));
    await settled(one.collections, A0);

    const two = await onRecord();
    const changing = deferred<Answer>();
    two.server.on("POST", DELETE, "offline");
    two.server.on("POST", EDIT, () => changing.promise);
    two.collections.remove();
    await settled(two.collections, A0);
    two.collections.change(two.collections.edit("f-name")!, "Maya");
    await two.collections.retryAction(A0);
    expect(bodies(two.server, DELETE)).toHaveLength(1);
    changing.resolve(ok({ saved: { version: 2 } }));
  });

  it("lands neither a new record nor a deletion after a workspace switch", async () => {
    const { server, stores, collections } = await onRecord();
    const create = deferred<Answer>();
    const remove = deferred<Answer>();
    server.on("POST", CREATE, () => create.promise);
    server.on("POST", DELETE, () => remove.promise);
    collections.remove();
    const adding = collections.create();
    await sent(server, 4);
    appTeardown(stores).open("ws-2");
    expect(collections.actions().size).toBe(0);
    let painted = 0;
    collections.subscribe(() => painted++);
    create.resolve(created);
    remove.resolve(ok({ saved: {} }));
    expect(await adding).toBe(false);
    await new Promise((done) => setTimeout(done, 0));
    expect(collections.actions().size).toBe(0);
    expect(collections.view()).toBeNull();
    expect(painted).toBe(0);
  });

  it("creates records with values, retries failed creates with the same values, and allows resubmit after refusal", async () => {
    const { server, collections, stored } = await onList();
    server.on(
      "POST",
      CREATE,
      ok({ refused: { code: "not_unique", message: "Duplicate." } }),
      "offline",
      adds(stored),
    );
    expect(await collections.create({ "f-name": "Dup" })).toBe(false);
    expect(collections.actions().get(NEW)?.state).toMatchObject({
      kind: "refused",
      code: "not_unique",
    });
    // After a refusal, a fresh create with edited values uses a new key.
    expect(await collections.create({ "f-name": "Ada" })).toBe(false);
    expect(collections.actions().get(NEW)?.state).toEqual({ kind: "failed", problem: "offline" });
    // Retry resends the exact failed values and idempotencyKey.
    expect(await collections.retryAction(NEW)).toBe(true);
    const [first, second, third] = bodies(server, CREATE) as Array<{
      idempotencyKey: string;
      values?: Record<string, unknown>;
    }>;
    expect(first?.values).toEqual({ "f-name": "Dup" });
    expect(second?.values).toEqual({ "f-name": "Ada" });
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
    expect(third).toEqual(second);
  });
});

describe("search, sort, and relation labels", () => {
  it("forwards search and sort, resets query on table switch, and handles unsupported-query without clearing the description", async () => {
    const { server, collections } = setup();
    pages(server);
    await collections.open(D);
    await collections.setQuery({ search: "Ana", sort: { fieldId: "f-name", direction: "desc" } });
    expect(server.calls.at(-1)?.body).toEqual({
      datasetId: D,
      tableId: "t-people",
      search: "Ana",
      sort: { fieldId: "f-name", direction: "desc" },
    });
    await collections.more();
    expect(server.calls.at(-1)?.body).toEqual({
      datasetId: D,
      tableId: "t-people",
      after: { id: "a1", value: "a1" },
      search: "Ana",
      sort: { fieldId: "f-name", direction: "desc" },
    });
    server.on(
      "POST",
      `${OPS}/collectionRecords`,
      ok({ status: "refused", reason: "unsupported-query" }),
    );
    await collections.setQuery({ search: "Custom" });
    expect(collections.view()).toMatchObject({
      description: { name: "Registrations" },
      queryUnsupported: true,
      refused: false,
      rows: [],
    });
    pages(server);
    await collections.setQuery({ search: "", sort: null });
    expect(collections.view()?.queryUnsupported).toBe(false);
    expect(names(collections.view()?.rows)).toEqual(["a0", "a1"]);
    await collections.chooseTable("t-notes");
    expect(collections.view()).toMatchObject({ search: "", sort: null });
  });

  it("refreshes the active search/sort query after create or edit without prepending non-matching records", async () => {
    const { server, collections } = setup();
    server.on("POST", `${OPS}/collectionRecords`, records(["anna"], null));
    await collections.open(D);
    server.on("POST", `${OPS}/collectionRecords`, records(["anna"], null));
    await collections.setQuery({ search: "Anna" });
    server.on("POST", `${OPS}/collectionCreate`, ok({ saved: { id: "bob", version: 1 } }));
    server.on("POST", `${OPS}/collectionRecords`, records(["bob"], null), records(["anna"], null));
    expect(await collections.create({ "f-name": "Bob" })).toBe(true);
    expect(collections.view()?.opened?.record.id).toBe("bob");
    while (collections.view()?.reading) await new Promise((done) => setTimeout(done, 0));
    expect(collections.view()?.rows.map((r) => r.id)).toEqual(["anna"]);
    expect(server.calls.at(-1)?.body).toEqual({
      datasetId: D,
      tableId: "t-people",
      search: "Anna",
    });

    server.on("POST", `${OPS}/collectionEdit`, ok({ saved: { version: 2, priorValue: "Bob" } }));
    server.on("POST", `${OPS}/collectionRecords`, records(["anna", "bob"], null));
    collections.change(collections.edit("f-name")!, "Anna Bob");
    const key = recordKey(D, "t-people", "bob");
    while (collections.changes().get(key)?.state.kind === "saving" || collections.view()?.reading)
      await new Promise((done) => setTimeout(done, 0));
    expect(collections.view()?.rows.map((r) => r.id)).toEqual(["anna", "bob"]);

    collections.close(D);
    server.on("POST", `${OPS}/collection`, "offline");
    await collections.open(D);
    expect(collections.view()?.search).toBe("");
    expect(collections.view()?.rows).toEqual([]);
    expect(collections.view()?.next).toBeNull();
  });

  it("merges relation labels on edits including retries and loads relation options", async () => {
    const { server, collections } = setup();
    server.on(
      "POST",
      `${OPS}/collectionRecords`,
      records(["a0"], null, { "f-name": { '"a0"': "Alpha" } }),
    );
    await collections.open(D);
    collections.openRecord(collections.view()!.rows[0]!);
    expect(collections.view()?.opened?.relations).toEqual({ "f-name": { '"a0"': "Alpha" } });
    server.on(
      "POST",
      `${OPS}/collectionEdit`,
      "offline",
      ok({ saved: { version: 2, priorValue: "a0" } }),
    );
    collections.change(collections.edit("f-name")!, "b0", { '"b0"': "Beta" });
    const key = recordKey(D, "t-people", "a0");
    while (collections.changes().get(key)?.state.kind === "saving")
      await new Promise((done) => setTimeout(done, 0));
    collections.retry(key);
    while (collections.changes().get(key)?.state.kind === "saving")
      await new Promise((done) => setTimeout(done, 0));
    expect(collections.view()?.opened?.relations["f-name"]).toEqual({
      '"a0"': "Alpha",
      '"b0"': "Beta",
    });
    server.on(
      "POST",
      `${OPS}/collectionRelationOptions`,
      ok({ options: [{ value: "c-1", label: "Acme" }], nextCursor: null }),
    );
    expect(await collections.relationOptions("t-people", "f-org", "Ac", null)).toEqual({
      options: [{ value: "c-1", label: "Acme" }],
      next: null,
      searchUnsupported: false,
    });
    expect(server.calls.at(-1)?.body).toEqual({
      datasetId: D,
      tableId: "t-people",
      fieldId: "f-org",
      search: "Ac",
    });
  });
});
