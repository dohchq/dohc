import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { fixture, limits } from "../../../../services/sync-relay/src/datasetTestFixture";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { parseDatasetDescription, type DatasetDefinition } from "@dohc/security-contract/dataset";
import type { DatasetReplicaSource } from "@dohc/app-backend-runtime/replica";
import type { OwnerDatasetData } from "./remoteDataset";
import { createOwnerDatasetCopy } from "./ownerDatasetCopy";
import { DatasetCopyOfflineError } from "./remoteDatasetReplica";

// Set to make this computer's copy fail to write what the server sent, as a full disk does.
const disk = vi.hoisted(() => ({ full: false }));
vi.mock("@dohc/app-backend-runtime/replica", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dohc/app-backend-runtime/replica")>();
  return {
    ...actual,
    createDatasetReplica: async (...args: Parameters<typeof actual.createDatasetReplica>) => {
      const replica = await actual.createDatasetReplica(...args);
      return Object.assign(Object.create(replica) as typeof replica, {
        catchUp: (...catchUp: Parameters<typeof replica.catchUp>) =>
          disk.full
            ? Promise.reject(
                Object.assign(new Error("ENOSPC: no space left on device, write"), {
                  code: "ENOSPC",
                }),
              )
            : replica.catchUp(...catchUp),
      });
    },
  };
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("persists real owner reads across restart, catches up, and refuses offline writes and revoked access", async () => {
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), "desktop-owner-copy-"));
  const host = await f.storage.createDatasetHost({
    publicEditRelease: undefined,
    directory: join(directory, "host"),
    limits,
    onShutdownError(error) {
      throw error;
    },
  });
  const actor = { kind: "named" as const, workspaceId: "w", userId: "owner" },
    scope = { workspaceId: "w", datasetId: id(1) };
  const definition: DatasetDefinition = {
    formatVersion: 1,
    datasetId: id(1),
    name: "Entries",
    schemaPath: "schema.sql",
    operationsPath: "actions.js",
    tables: [
      {
        tableId: id(2),
        name: "Entries",
        sqlName: "entries",
        primaryKey: "id",
        fields: [
          {
            fieldId: id(3),
            name: "ID",
            sqlColumn: "id",
            type: "number",
            required: true,
            unique: true,
          },
          {
            fieldId: id(4),
            name: "Name",
            sqlColumn: "name",
            type: "text",
            required: true,
            unique: false,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: id(5),
        name: "add",
        label: "Add",
        kind: "create",
        tableId: id(2),
        access: "owner",
        readOnly: false,
        fieldIds: [id(4)],
      },
      {
        operationId: id(6),
        name: "read",
        label: "Read",
        kind: "read",
        tableId: id(2),
        access: "owner",
        readOnly: true,
        fieldIds: [id(4)],
      },
    ],
  };
  const schemaSql = "CREATE TABLE entries(id INTEGER PRIMARY KEY,name TEXT NOT NULL);",
    operationSource =
      "globalThis.operations={add(ctx,input){ctx.db.execute('INSERT INTO entries(name) VALUES(?)',[input.name]);return null;},read(ctx){return ctx.db.query('SELECT * FROM entries ORDER BY id');}};";
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  const options = {
    directory: join(directory, "copy"),
    scope,
    ownerKey: "owner",
    origin: "https://relay",
    assertOwner() {},
    onChanged: () => heard?.(),
  };
  // Settles when the copy next says what it shows changed.
  let heard: (() => void) | undefined;
  const changed = () =>
    new Promise<void>((resolve) => {
      heard = resolve;
    });
  await mkdir(options.directory);
  let copy = await createOwnerDatasetCopy(options),
    offline = false,
    denied = false,
    archived = false;
  const blob = vi.fn(async (input: Parameters<DatasetReplicaSource["blob"]>[0]) =>
    host.replicaBlob(actor, { ...scope, ...input }),
  );
  const source: DatasetReplicaSource = {
    async capture() {
      if (denied) {
        copy.accessLost();
        throw Error("revoked");
      }
      if (offline) throw new DatasetCopyOfflineError("offline");
      // As the host refuses a copy of an archived Collection.
      if (archived) throw Error("archived");
      return host.replicaCapture(actor, scope);
    },
    async page(input) {
      return host.replicaPage(actor, { ...scope, ...input });
    },
    blob,
  };
  const pinned = { ...scope, revision: 1, revisionSha256: revision.revisionSha256 };
  const sent = vi.fn();
  let dropped = false;
  const invoke = vi.fn(
    async ({ after: _after, ...input }: Parameters<OwnerDatasetData["invoke"]>[0]) => {
      // As fetch fails when the connection never opens.
      if (offline)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
        });
      sent();
      // As fetch fails when the connection drops after the request went out.
      if (dropped) throw new TypeError("fetch failed");
      return host.invoke(actor, { ...input, workspaceId: "w", access: { kind: "data" } });
    },
  );
  const remote = {
    invoke,
    async describe() {
      if (offline) throw new TypeError("fetch failed");
      return { ...host.describe(actor, scope), archived, ...(archived ? { operations: [] } : {}) };
    },
  } as unknown as OwnerDatasetData;
  const signal = new AbortController().signal;
  try {
    await host.activate(actor, { workspaceId: "w", revision, schemaSql, operationSource });
    await invoke({
      ...pinned,
      operationId: id(5),
      input: { name: "Mom" },
      idempotencyKey: "first",
    });
    expect((await copy.data(remote, source, signal).describe(id(1))).name).toBe("Entries");
    expect(blob).not.toHaveBeenCalled();
    archived = true;
    expect(await copy.data(remote, source, signal).inspect!(id(1))).toMatchObject({
      dataset: { archived: true },
    });
    expect(blob).not.toHaveBeenCalled();
    if (process.platform !== "win32") {
      const marker = join(options.directory, "archived.json");
      await copy.close();
      const writableByEveryUser = 0o666;
      await chmod(marker, writableByEveryUser);
      copy = await createOwnerDatasetCopy(options);
      offline = true;
      await expect(copy.data(remote, source, signal).inspect!(id(1))).rejects.toThrow(
        "This Collection needs relay, which dohc can't reach.",
      );
      await chmod(marker, 0o600);
      offline = false;
    }
    await copy.close();
    copy = await createOwnerDatasetCopy(options);
    offline = true;
    // The copy shows what it kept at once, then finds the server out of reach.
    let found = changed();
    expect(await copy.data(remote, source, signal).inspect!(id(1))).toMatchObject({
      dataset: { archived: true },
    });
    await found;
    expect(await copy.data(remote, source, signal).inspect!(id(1))).toMatchObject({
      dataset: { archived: true },
      copy: { offline: true, host: "relay" },
    });
    await expect(
      copy
        .data(remote, source, signal)
        .invoke({ ...pinned, operationId: id(6), input: {}, idempotencyKey: "archived" }),
    ).rejects.toThrow(/archived/);
    offline = false;
    archived = false;
    found = changed();
    await copy.data(remote, source, signal).inspect!(id(1));
    await found;
    const inspect = await copy.data(remote, source, signal).inspect!(id(1));
    expect(inspect.copy?.offline).toBe(false);
    expect(() => parseDatasetDescription(inspect.dataset)).not.toThrow();
    expect(inspect.dataset.tables[0]!.fields.map((field) => field.fieldId)).toEqual([id(4)]);
    const { archived: _archived, ...authorityDescription } = await remote.describe(id(1));
    expect(inspect.dataset).toEqual(authorityDescription);
    expect(inspect.dataset.tables[0]!.fields[0]).not.toHaveProperty("sqlColumn");
    await copy.close();
    copy = await createOwnerDatasetCopy(options);
    offline = true;
    // A description read from the kept copy also goes to bring it up to date.
    found = changed();
    expect((await copy.data(remote, source, signal).describe(id(1))).name).toBe("Entries");
    await found;
    const offlineDescription = await copy.data(remote, source, signal).inspect!(id(1));
    expect(parseDatasetDescription(offlineDescription.dataset)).toEqual(inspect.dataset);
    expect(offlineDescription.copy).toMatchObject({ offline: true, host: "relay" });
    const read = { ...pinned, operationId: id(6), input: {}, idempotencyKey: "read" };
    expect(await copy.data(remote, source, signal).invoke(read)).toMatchObject({
      result: [{ id: 1, name: "Mom" }],
      copy: { offline: true },
    });
    await expect(
      copy.data(remote, source, signal).invoke({ ...read, operationId: id(5) }),
    ).rejects.toThrow(
      "dohc didn't save this change. This Collection is read-only until relay is reachable.",
    );
    expect(sent).toHaveBeenCalledOnce();
    offline = false;
    // The server may have the change, so the words do not say it was not saved.
    dropped = true;
    await expect(
      copy
        .data(remote, source, signal)
        .invoke({ ...read, operationId: id(5), input: { name: "Maybe" } }),
    ).rejects.toThrow("This Collection needs relay, which dohc can't reach.");
    dropped = false;
    await invoke({
      ...pinned,
      operationId: id(5),
      input: { name: "Friend" },
      idempotencyKey: "second",
    });
    // The copy shows what it kept until the server answers again.
    found = changed();
    expect(await copy.data(remote, source, signal).invoke(read)).toMatchObject({
      copy: { offline: true },
    });
    await found;
    expect(await copy.data(remote, source, signal).invoke(read)).toMatchObject({
      result: [
        { id: 1, name: "Mom" },
        { id: 2, name: "Friend" },
      ],
      copy: { offline: false },
    });
    // Access ends: the next update finds out, and the copy goes.
    denied = true;
    found = changed();
    // This read shows the copy, or is refused if the update already found out.
    await copy
      .data(remote, source, signal)
      .invoke(read)
      .catch(() => undefined);
    await found;
    await expect(copy.data(remote, source, signal).invoke(read)).rejects.toThrow(/unavailable/);
    offline = true;
    await expect(copy.data(remote, source, signal).invoke(read)).rejects.toThrow(/unavailable/);
  } finally {
    await copy.close();
    await host.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});

it.each(["delete", "status", "closing"])(
  "erases a cached Collection after confirmed %s and cannot reopen it offline",
  async (mode) => {
    const f = fixture(),
      directory = await mkdtemp(join(tmpdir(), "desktop-deleted-copy-"));
    const host = await f.storage.createDatasetHost({
      publicEditRelease: undefined,
      directory: join(directory, "host"),
      limits,
      onShutdownError(error) {
        throw error;
      },
    });
    const actor = { kind: "named" as const, workspaceId: "w", userId: "owner" },
      scope = { workspaceId: "w", datasetId: id(1) };
    const definition: DatasetDefinition = {
      formatVersion: 1,
      datasetId: id(1),
      name: "Entries",
      schemaPath: "schema.sql",
      operationsPath: "actions.js",
      tables: [
        {
          tableId: id(2),
          name: "Entries",
          sqlName: "entries",
          primaryKey: "id",
          fields: [
            {
              fieldId: id(3),
              name: "ID",
              sqlColumn: "id",
              type: "number",
              required: true,
              unique: true,
            },
          ],
        },
      ],
      operations: [
        {
          operationId: id(5),
          name: "seed",
          label: "Seed",
          kind: "create",
          tableId: id(2),
          access: "owner",
          readOnly: false,
          fieldIds: [id(3)],
        },
        {
          operationId: id(6),
          name: "read",
          label: "Read",
          kind: "read",
          tableId: id(2),
          access: "owner",
          readOnly: true,
          fieldIds: [id(3)],
        },
      ],
    };
    const schemaSql = "CREATE TABLE entries(id INTEGER PRIMARY KEY);",
      operationSource =
        "globalThis.operations={seed(ctx){ctx.db.execute('INSERT INTO entries VALUES(1)');return null;},read(ctx){return ctx.db.query('SELECT id FROM entries');}};";
    const revision = describeDatasetRevision({
      definition,
      revision: 1,
      schemaSql,
      operationSource,
    });
    const options = {
      directory: join(directory, "copy"),
      scope,
      ownerKey: "owner",
      origin: "https://relay",
      assertOwner() {},
    };
    await mkdir(options.directory);
    let copy = await createOwnerDatasetCopy(options),
      offline = false,
      holdMutation = false;
    let mutationStarted!: () => void, releaseMutation!: () => void;
    const started = new Promise<void>((resolve) => {
        mutationStarted = resolve;
      }),
      release = new Promise<void>((resolve) => {
        releaseMutation = resolve;
      });
    let deletionStarted!: () => void, releaseDeletion!: () => void;
    const deleting = new Promise<void>((resolve) => {
        deletionStarted = resolve;
      }),
      releaseDelete = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
      });
    const source: DatasetReplicaSource = {
      async capture() {
        if (offline) throw new DatasetCopyOfflineError("offline");
        return host.replicaCapture(actor, scope);
      },
      async page(input) {
        return host.replicaPage(actor, { ...scope, ...input });
      },
      async blob(input) {
        return host.replicaBlob(actor, { ...scope, ...input });
      },
    };
    const remote = {
      async describe() {
        if (offline) throw new TypeError("fetch failed");
        return host.describe(actor, scope);
      },
      async invoke(input: Parameters<OwnerDatasetData["invoke"]>[0]) {
        if (holdMutation) {
          mutationStarted();
          await release;
          return { result: null, revision: 2, replayed: false };
        }
        return host.invoke(actor, { ...input, workspaceId: "w", access: { kind: "data" } });
      },
      async deleteDataset(input: Parameters<NonNullable<OwnerDatasetData["deleteDataset"]>>[0]) {
        if (mode === "closing") {
          deletionStarted();
          await releaseDelete;
        }
        return host.deleteDataset(actor, { ...input, workspaceId: "w" });
      },
      async deletionStatus() {
        return host.deletionStatus(actor, scope);
      },
    } as unknown as OwnerDatasetData;
    const signal = new AbortController().signal,
      pinned = { ...scope, revision: 1, revisionSha256: revision.revisionSha256 };
    const read = { ...pinned, operationId: id(6), input: {}, idempotencyKey: "read" };
    try {
      await host.activate(actor, { workspaceId: "w", revision, schemaSql, operationSource });
      await remote.invoke({ ...pinned, operationId: id(5), input: {}, idempotencyKey: "seed" });
      expect(await copy.data(remote, source, signal).invoke(read)).toMatchObject({
        result: [{ id: 1 }],
      });
      expect(await copy.data(remote, source, signal).deletionStatus!({ datasetId: id(1) })).toEqual(
        { deleted: false },
      );
      holdMutation = true;
      const pendingMutation = copy
        .data(remote, source, signal)
        .invoke({ ...read, operationId: id(5), idempotencyKey: "pending" })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await started;
      host.archiveDataset(actor, scope);
      const preview = host.deletePreview(actor, scope),
        deletion = {
          datasetId: id(1),
          expected: preview.cursor,
          reviewToken: preview.reviewToken,
          acknowledge: true as const,
        };
      if (mode === "closing") {
        const deletionRequest = copy.data(remote, source, signal).deleteDataset!(deletion);
        await deleting;
        const closeRequest = copy.close();
        releaseDeletion();
        await Promise.all([deletionRequest, closeRequest]);
      } else if (mode === "delete")
        await copy.data(remote, source, signal).deleteDataset!(deletion);
      else {
        await remote.deleteDataset!(deletion);
        expect(
          await copy.data(remote, source, signal).deletionStatus!({ datasetId: id(1) }),
        ).toEqual({ deleted: true });
      }
      releaseMutation();
      expect(await pendingMutation).toMatchObject({
        error: expect.objectContaining({ message: expect.stringContaining("unavailable") }),
      });
      offline = true;
      await expect(copy.data(remote, source, signal).invoke(read)).rejects.toThrow("unavailable");
      expect(
        (await readdir(options.directory)).filter(
          (name) =>
            name.startsWith("read-") ||
            name === "archived.json" ||
            /^[a-f0-9-]{36}\.sqlite$/.test(name),
        ),
      ).toHaveLength(0);
      await copy.close();
      copy = await createOwnerDatasetCopy(options);
      await expect(copy.data(remote, source, signal).invoke(read)).rejects.toThrow(
        "This Collection needs relay, which dohc can't reach.",
      );
    } finally {
      await copy.close();
      await host.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  },
  30_000,
);

it("says this computer can't update its copy, not that the server is out of reach, and recovers", async () => {
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), "desktop-copy-disk-full-"));
  const host = await f.storage.createDatasetHost({
    publicEditRelease: undefined,
    directory: join(directory, "host"),
    limits,
    onShutdownError(error) {
      throw error;
    },
  });
  const actor = { kind: "named" as const, workspaceId: "w", userId: "owner" },
    scope = { workspaceId: "w", datasetId: id(1) };
  const definition: DatasetDefinition = {
    formatVersion: 1,
    datasetId: id(1),
    name: "Entries",
    schemaPath: "schema.sql",
    operationsPath: "actions.js",
    tables: [
      {
        tableId: id(2),
        name: "Entries",
        sqlName: "entries",
        primaryKey: "id",
        fields: [
          {
            fieldId: id(3),
            name: "ID",
            sqlColumn: "id",
            type: "number",
            required: true,
            unique: true,
          },
        ],
      },
    ],
    operations: [
      {
        operationId: id(5),
        name: "seed",
        label: "Seed",
        kind: "create",
        tableId: id(2),
        access: "owner",
        readOnly: false,
        fieldIds: [id(3)],
      },
    ],
  };
  const schemaSql = "CREATE TABLE entries(id INTEGER PRIMARY KEY);",
    operationSource =
      "globalThis.operations={seed(ctx){ctx.db.execute('INSERT INTO entries DEFAULT VALUES');return null;}};";
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
  const options = {
    directory: join(directory, "copy"),
    scope,
    ownerKey: "owner",
    origin: "https://relay",
    assertOwner() {},
    onChanged: () => heard?.(),
  };
  let heard: (() => void) | undefined;
  const changed = () =>
    new Promise<void>((resolve) => {
      heard = resolve;
    });
  await mkdir(options.directory);
  let copy = await createOwnerDatasetCopy(options);
  // Set to hold the server's answer to an update until the test lets it go.
  let held: Promise<void> | undefined,
    asked: (() => void) | undefined,
    release = () => {};
  const source: DatasetReplicaSource = {
    capture: async () => {
      asked?.();
      await held;
      return host.replicaCapture(actor, scope);
    },
    page: async (input) => host.replicaPage(actor, { ...scope, ...input }),
    blob: async (input) => host.replicaBlob(actor, { ...scope, ...input }),
  };
  const invoke = vi.fn(
    async ({ after: _after, ...input }: Parameters<OwnerDatasetData["invoke"]>[0]) =>
      host.invoke(actor, { ...input, workspaceId: "w", access: { kind: "data" } }),
  );
  const remote = {
    invoke,
    describe: async () => host.describe(actor, scope),
  } as unknown as OwnerDatasetData;
  const pinned = { ...scope, revision: 1, revisionSha256: revision.revisionSha256 };
  const refusal =
    "dohc didn't save this change. This Collection is read-only until dohc can update its copy on this device.";
  const signal = new AbortController().signal;
  try {
    await host.activate(actor, { workspaceId: "w", revision, schemaSql, operationSource });
    expect(await copy.data(remote, source, signal).inspect!(id(1))).toMatchObject({
      copy: { offline: false },
    });
    // A change on the server leaves the copy behind, and this computer can't write it.
    await host.invoke(actor, {
      ...scope,
      revision: 1,
      revisionSha256: revision.revisionSha256,
      operationId: id(5),
      input: {},
      idempotencyKey: "elsewhere",
      workspaceId: "w",
      access: { kind: "data" },
    });
    disk.full = true;
    let found = changed();
    await copy.data(remote, source, signal).inspect!(id(1));
    await found;
    expect(await copy.data(remote, source, signal).inspect!(id(1))).toMatchObject({
      copy: { offline: true, updateFailed: true },
    });
    // A change the copy knows how to make is refused too, before it reaches the server.
    await expect(
      copy
        .data(remote, source, signal)
        .invoke({ ...pinned, operationId: id(5), input: {}, idempotencyKey: "stale" }),
    ).rejects.toThrow(refusal);
    expect(invoke).not.toHaveBeenCalled();
    disk.full = false;
    found = changed();
    await copy.data(remote, source, signal).inspect!(id(1));
    await found;
    const recovered = await copy.data(remote, source, signal).inspect!(id(1));
    expect(recovered.copy).toMatchObject({ offline: false });
    expect(recovered.copy).not.toHaveProperty("updateFailed");

    // A retry the server is slow to answer shows the server out of reach while
    // it waits. When this computer then fails to write again, the page hears it.
    await copy.close();
    copy = await createOwnerDatasetCopy({ ...options, slowMs: 200, retryMs: 300 });
    await host.invoke(actor, {
      ...pinned,
      operationId: id(5),
      input: {},
      idempotencyKey: "again",
      workspaceId: "w",
      access: { kind: "data" },
    });
    disk.full = true;
    const hold = () => {
      held = new Promise((resolve) => (release = resolve));
      return new Promise<void>((resolve) => (asked = resolve));
    };
    let waiting = hold();
    found = changed();
    await copy.data(remote, source, signal).inspect!(id(1));
    await waiting;
    await found;
    found = changed();
    release();
    await found;
    waiting = hold();
    found = changed();
    expect(await copy.data(remote, source, signal).inspect!(id(1))).toMatchObject({
      copy: { offline: true, updateFailed: true },
    });
    // That read or the retry after it asks the server again.
    await waiting;
    await found;
    const slow = await copy.data(remote, source, signal).inspect!(id(1));
    expect(slow.copy).toMatchObject({ offline: true });
    expect(slow.copy).not.toHaveProperty("updateFailed");
    let heardOnce = false;
    void changed().then(() => (heardOnce = true));
    held = undefined;
    // The next retry asks once this one has ended.
    waiting = new Promise((resolve) => (asked = resolve));
    release();
    await waiting;
    expect(heardOnce).toBe(true);
    expect(await copy.data(remote, source, signal).inspect!(id(1))).toMatchObject({
      copy: { offline: true, updateFailed: true },
    });
  } finally {
    disk.full = false;
    release();
    await copy.close();
    await host.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});
