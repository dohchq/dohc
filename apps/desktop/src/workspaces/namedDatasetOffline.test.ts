import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createNamedDatasetCacheRegistry } from "./namedDatasetCache";
import { createNamedDatasetData } from "./namedDataset";
import { NamedDatasetOfflineError } from "./namedDatasetTransport";

const disk = vi.hoisted(() => ({ beforeSync: null as null | (() => Promise<void>) }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args), sync = file.sync.bind(file);
    file.sync = async () => { await disk.beforeSync?.(); await sync(); };
    return file;
  } };
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { disk.beforeSync = null; for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const owner = "a".repeat(64), fingerprint = "b".repeat(64), revisionSha256 = "c".repeat(64);
const description = { datasetId: id(1), name: "Registrations", revision: 1, revisionSha256,
  tables: [{ tableId: id(2), name: "Registrations", fields: [{ fieldId: id(3), name: "Name", type: "text", required: true, unique: false }] }],
  operations: [
    { operationId: id(4), name: "read", label: "Read", kind: "read", tableId: id(2), readOnly: true, access: "helper", fieldIds: [id(3)] },
    { operationId: id(5), name: "edit", label: "Edit", kind: "edit", tableId: id(2), readOnly: false, access: "helper", fieldIds: [id(3)] },
  ] };
const invocation = { datasetId: id(1), revision: 1, revisionSha256, operationId: id(4), input: { limit: 50 }, idempotencyKey: "read" };
const result = { result: { rows: [{ id: "mine", values: { [id(3)]: "Sarah" } }], nextCursor: null }, revision: 7, replayed: false };
async function fixture(maxBytes?: number) {
  const directory = await mkdtemp(join(tmpdir(), "named-dataset-pages-"));
  let registry = createNamedDatasetCacheRegistry({ directory: () => directory, maxBytes });
  await registry.credentialsChanged(owner);
  cleanups.push(async () => { await registry.close(); await rm(directory, { recursive: true, force: true }); });
  let offline = false, status = 200, generation = 1;
  const relayResponse = vi.fn(async (_credentials: unknown, path: string) => {
    if (offline) throw new NamedDatasetOfflineError("fetch failed");
    return Response.json(status === 200 ? path.endsWith("/invoke") ? result : path.endsWith("/datasets") ? { datasets: [description], nextCursor: null } : description : { message: "refused" },
      { status, headers: { "x-dohc-dataset-access": fingerprint } });
  });
  const saves: Promise<unknown>[] = [];
  const cache = (binding: unknown = ["workspace", "share"]) => {
    const scoped = registry.scope({ owner, binding, assertCurrent() {} });
    return { ...scoped, put: (...args: Parameters<typeof scoped.put>) => {
      const pending = scoped.put(...args); saves.push(pending.catch(() => undefined)); return pending;
    } };
  };
  const data = (binding?: unknown) => createNamedDatasetData({ workspaceId: "local-share", credentials: { userId: "helper", token: "private-token", email: "helper@example", serverUrl: "https://account", relayUrl: "https://relay" },
    shareView: { shareId: "share", recipientUserId: "helper", relayUrl: "https://relay", grantedSelector: { paths: ["app"], versionId: null, access: "view" } },
    credentialGeneration: generation, currentCredentialGeneration: () => generation, assertCurrent() {}, signal: new AbortController().signal,
    relayJson: async () => { throw Error("unexpected transport"); }, offline: { cache: cache(binding), relayResponse } });
  return { directory, data, cache, relayResponse, registry: () => registry,
    async settled() { await Promise.all(saves.splice(0)); },
    offline(value = true) { offline = value; }, status(value: number) { status = value; },
    accountChanged() { generation++; },
    async restart() { await registry.close(); registry = createNamedDatasetCacheRegistry({ directory: () => directory, maxBytes }); await registry.credentialsChanged(owner); },
  };
}

it("saves only exact authorized result pages across restart, with honest stale scope and no offline writes", async () => {
  const f = await fixture();
  expect(await f.data().inspect!(id(1))).toEqual({ dataset: description, copy: undefined });
  expect(await f.data().invoke(invocation)).toEqual(result);
  await f.restart(); f.offline();
  expect(await f.data().invoke({ ...invocation, idempotencyKey: "another-read" })).toMatchObject({ ...result, copy: { offline: true, coverage: "saved-pages" } });
  await expect(f.data().invoke({ ...invocation, input: { limit: 100 } })).rejects.toThrow(/not saved/);
  await expect(f.data().invoke({ ...invocation, operationId: id(5) })).rejects.toThrow(/offline/);
  const bytes = await readFile(join(f.directory, "pages.json"), "utf8");
  expect(bytes).toContain("Sarah");
  for (const forbidden of ["private-token", "operationSource", "schemaSql", "history", "retry"]) expect(bytes).not.toContain(forbidden);
});

it.each([401, 403, 404, 409])("removes saved pages after explicit %i and never later falls back", async status => {
  const f = await fixture(); await f.data().describe(id(1)); await f.data().invoke(invocation);
  f.status(status); await expect(f.data().describe(id(1))).rejects.toThrow(/access or rules changed/);
  f.offline(); await expect(f.data().describe(id(1))).rejects.toThrow(/not saved/);
  await expect(readFile(join(f.directory, "pages.json"))).rejects.toMatchObject({ code: "ENOENT" });
});


it("purges prior pages after a known grant fingerprint change, including on malformed responses", async () => {
  const f = await fixture(); await f.data().describe(id(1)); await f.data().invoke(invocation);
  f.token("d".repeat(64)); f.malformed();
  await expect(f.data().describe(id(1))).rejects.toThrow();
  f.offline(); await expect(f.data().describe(id(1))).rejects.toThrow(/not saved/);
});

it("isolates share/workspace scopes and removes the previous account's disk pages", async () => {
  const f = await fixture(); await f.data().describe(id(1)); await f.restart(); f.offline();
  await expect(f.data(["other-workspace", "share"]).describe(id(1))).rejects.toThrow(/not saved/);
  const old = f.data(); f.accountChanged();
  await expect(old.describe(id(1))).rejects.toThrow(/session changed/);
  await f.registry().credentialsChanged("f".repeat(64));
  await expect(f.cache().read(["describe", id(1)])).rejects.toThrow(/account changed/);
  await expect(readFile(join(f.directory, "pages.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("cannot relabel an older in-flight response after a new grant or revocation was observed", async () => {
  const f = await fixture(), cache = f.cache();
  const start = await cache.begin(); await cache.accept(fingerprint, start);
  const old = await cache.begin(); await cache.accept("d".repeat(64), old);
  await expect(cache.accept(fingerprint, old)).rejects.toThrow(/access changed/);
  await expect(cache.put("old", result, fingerprint)).rejects.toThrow(/access changed/);
  const revoked = await cache.begin(); await cache.clear();
  await expect(cache.accept("d".repeat(64), revoked)).rejects.toThrow(/access changed/);
});

it("bounds saved pages and declines oversized pages instead of claiming they were saved", async () => {
  const f = await fixture(1800), cache = f.cache(); await cache.accept(fingerprint, await cache.begin());
  for (let i = 0; i < 5; i++) await cache.put(i, "x".repeat(300), fingerprint);
  expect((await readFile(join(f.directory, "pages.json"))).byteLength).toBeLessThanOrEqual(1800);
  expect(await cache.read(0)).toBeNull(); expect(await cache.read(4)).not.toBeNull();
  await cache.put("large", "x".repeat(1000), fingerprint);
  expect(await cache.read("large")).toBeNull();
});

it("never exposes a failed save as an offline page, while retaining the prior durable page", async () => {
  const f = await fixture(); await f.data().describe(id(1)); await f.restart();
  const failed = Promise.withResolvers<void>();
  disk.beforeSync = async () => { disk.beforeSync = null; failed.resolve(); throw Error("disk full"); };
  expect(await f.data().invoke(invocation)).toEqual(result);
  await failed.promise; await f.settled();
  await f.restart(); f.offline();
  expect(await f.data().inspect!(id(1))).toMatchObject({ dataset: description, copy: { offline: true } });
  await expect(f.data().invoke(invocation)).rejects.toThrow(/not saved/);
});

it("purges an active delayed write after an account change even with write failure and cannot revive it on restart", async () => {
  const f = await fixture(), cache = f.cache(); await cache.accept(fingerprint, await cache.begin());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  disk.beforeSync = async () => { disk.beforeSync = null; entered.resolve(); await release.promise; throw Error("disk full"); };
  const save = cache.put("delayed", result, fingerprint).catch(error => error);
  try {
    await entered.promise;
    const purge = f.registry().credentialsChanged("f".repeat(64));
    release.resolve();
    await purge;
    const saved = await save;
    expect(saved).toBeInstanceOf(Error);
    await f.restart();
    expect(await f.cache().read("delayed")).toBeNull();
    await expect(readFile(join(f.directory, "pages.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { release.resolve(); await save; }
});

it("stops new cache work during close and drains a save already admitted", async () => {
  const f = await fixture(), cache = f.cache(); await cache.accept(fingerprint, await cache.begin());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  disk.beforeSync = async () => { disk.beforeSync = null; entered.resolve(); await release.promise; };
  const saved = cache.put("admitted", result, fingerprint);
  try {
    await entered.promise;
    const closed = f.registry().close();
    await expect(cache.put("late", result, fingerprint)).rejects.toThrow(/closing/);
    release.resolve();
    await saved; await closed; await f.restart();
    expect(await f.cache().read("admitted")).toMatchObject({ value: result });
    expect(await f.cache().read("late")).toBeNull();
  } finally { release.resolve(); await saved; }
});

it("fences in-memory metadata after fingerprint, local authority, revocation and account changes", async () => {
  const f = await fixture(), cache = f.cache();
  await cache.accept(fingerprint, await cache.begin()); await cache.put("metadata", description, fingerprint);
  expect(await cache.peek("metadata")).toEqual(description);
  const next = "d".repeat(64);
  await cache.accept(next, await cache.begin());
  expect(await cache.peek("metadata")).toBeNull();
  await cache.put("metadata", description, next); await cache.clear();
  expect(await cache.peek("metadata")).toBeNull();
  await cache.accept(next, await cache.begin()); await cache.put("metadata", description, next);
  const narrowed = f.registry().scope({ owner, binding: ["workspace", "share"], localAuthority: "narrower", assertCurrent() {} });
  expect(await narrowed.peek("metadata")).toBeNull();
  await f.registry().credentialsChanged("f".repeat(64));
  await expect(cache.peek("metadata")).rejects.toThrow(/account changed/);
});
