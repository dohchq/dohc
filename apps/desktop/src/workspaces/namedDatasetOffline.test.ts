import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createNamedDatasetCacheRegistry } from "./namedDatasetCache";
import { createNamedDatasetData } from "./namedDataset";
import { NamedDatasetOfflineError } from "./namedDatasetTransport";
import { createHash } from "node:crypto";

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
  let offline = false, status = 200, token = fingerprint, generation = 1, malformed = false;
  const relayResponse = vi.fn(async (_credentials: unknown, path: string) => {
    if (offline) throw new NamedDatasetOfflineError("fetch failed");
    if (malformed) return new Response("not json", { headers: { "x-dohc-dataset-access": token } });
    return Response.json(status === 200 ? path.endsWith("/invoke") ? result : path.endsWith("/datasets") ? { datasets: [description], nextCursor: null } : description : { message: "refused" },
      { status, headers: { "x-dohc-dataset-access": token } });
  });
  const saves: Promise<unknown>[] = [];
  const cache = (binding: unknown = ["workspace", "share"]) => {
    const scoped = registry.scope({ owner, binding, assertCurrent() {} });
    return { ...scoped, put: (...args: Parameters<typeof scoped.put>) => {
      const pending = scoped.put(...args); saves.push(pending.catch(() => undefined)); return pending;
    } };
  };
  const data = (binding?: unknown) => createNamedDatasetData({ workspaceId: "local-share", credentials: { userId: "helper", token: "private-token", email: "helper@example", serverUrl: "https://account", relayUrl: "https://relay" },
    shareView: { shareId: "share", relayUrl: "https://relay", grantedSelector: { paths: ["app"], versionId: null, access: "view" } },
    credentialGeneration: generation, currentCredentialGeneration: () => generation, assertCurrent() {}, signal: new AbortController().signal,
    relayJson: async () => { throw Error("unexpected transport"); }, offline: { cache: cache(binding), relayResponse } });
  return { directory, data, cache, relayResponse, registry: () => registry,
    async settled() { await Promise.all(saves.splice(0)); },
    offline(value = true) { offline = value; }, status(value: number) { status = value; }, token(value: string) { token = value; }, malformed() { malformed = true; },
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

it("does not treat malformed JSON or server failures as offline", async () => {
  const f = await fixture(); await f.data().describe(id(1));
  f.status(503); await expect(f.data().describe(id(1))).rejects.toThrow(/503/);
  f.status(200); f.malformed(); await expect(f.data().describe(id(1))).rejects.toThrow();
});

it("does not classify a TypeError from response handling as transport failure", async () => {
  const f = await fixture(); await f.data().describe(id(1));
  f.relayResponse.mockRejectedValueOnce(new TypeError("response processing failed"));
  await expect(f.data().describe(id(1))).rejects.toThrow("response processing failed");
});

it("retains operation correction messages and allows full-sized online attachments without caching their bytes", async () => {
  const f = await fixture(); await f.data().describe(id(1)); await f.settled();
  f.relayResponse.mockResolvedValueOnce(Response.json({ code: "capacity_reached", message: "Choose another time." }, { status: 409, headers: { "x-dohc-dataset-access": fingerprint } }));
  await expect(f.data().invoke(invocation)).rejects.toMatchObject({ refusal: { code: "capacity_reached", message: "Choose another time." } });
  const bytes = Buffer.alloc(3 * 1024 * 1024, 120), file = { fileId: "a".repeat(32), name: "receipt.png", contentType: "image/png", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  f.relayResponse.mockResolvedValueOnce(Response.json({ file, bytesBase64: bytes.toString("base64") }, { headers: { "x-dohc-dataset-access": fingerprint } }));
  expect((await f.data().file({ action: "file", workspaceId: "local-share", ...invocation, fileId: file.fileId,
    read: { operationId: id(4), fieldId: id(3), input: {} } })).file).toEqual(file);
  expect(await readFile(join(f.directory, "pages.json"), "utf8")).not.toContain("bytesBase64");
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
  for (let i = 0; i < 20; i++) await cache.put(i, "x".repeat(300), fingerprint);
  expect((await readFile(join(f.directory, "pages.json"))).byteLength).toBeLessThanOrEqual(1800);
  expect(await cache.read(0)).toBeNull(); expect(await cache.read(19)).not.toBeNull();
  await cache.put("large", "x".repeat(1000), fingerprint);
  expect(await cache.read("large")).toBeNull();
});

it("removes interrupted cache writes when signing out instead of leaving former account bytes behind", async () => {
  const f = await fixture(); await f.data().describe(id(1));
  const interrupted = join(f.directory, `pages.json.${id(1)}`);
  await writeFile(interrupted, "private former account data");
  await f.registry().credentialsChanged(null);
  await expect(readFile(interrupted)).rejects.toMatchObject({ code: "ENOENT" });
});

it("discards saved pages when a local share marker records narrower authority while offline", async () => {
  const f = await fixture(); await f.data().describe(id(1)); await f.data().invoke(invocation);
  const narrowed = f.registry().scope({ owner, binding: ["workspace", "share"], localAuthority: { access: "view", paths: ["narrower"] }, assertCurrent() {} });
  expect(await narrowed.read(["describe", id(1)])).toBeNull();
  await expect(readFile(join(f.directory, "pages.json"))).rejects.toMatchObject({ code: "ENOENT" });
});


it("returns consecutive online reads before disk sync and advertises only durable offline pages", async () => {
  const f = await fixture(); await f.data().describe(id(1)); await f.restart();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  disk.beforeSync = async () => { disk.beforeSync = null; entered.resolve(); await release.promise; };
  try {
    expect(await f.data().invoke(invocation)).toEqual(result);
    await entered.promise;
    expect(await f.data().invoke({ ...invocation, input: { limit: 25 } })).toEqual(result);
    expect(await f.data().inspect!(id(1))).toEqual({ dataset: description, copy: undefined });
    const key = ["invoke", id(1), 1, revisionSha256, id(4), invocation.input];
    expect(await f.cache().read(key)).toBeNull();
  } finally { release.resolve(); }
  await f.restart(); f.offline();
  expect(await f.data().invoke(invocation)).toMatchObject({ ...result, copy: { offline: true, coverage: "saved-pages" } });
  expect(await f.data().invoke({ ...invocation, input: { limit: 25 } })).toMatchObject({ ...result, copy: { offline: true } });
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

it.each([["clear", false], ["account", false], ["clear", true], ["account", true]] as const)("purges an active delayed write after %s even with write failure %s and cannot revive it on restart", async (action, fail) => {
  const f = await fixture(), cache = f.cache(); await cache.accept(fingerprint, await cache.begin());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  disk.beforeSync = async () => { disk.beforeSync = null; entered.resolve(); await release.promise; if (fail) throw Error("disk full"); };
  const save = cache.put("delayed", result, fingerprint).catch(error => error);
  try {
    await entered.promise;
    const purge = action === "clear" ? cache.clear() : f.registry().credentialsChanged("f".repeat(64));
    release.resolve();
    await purge;
    const saved = await save;
    if (action === "account") expect(saved).toBeInstanceOf(Error);
    await f.restart();
    expect(await f.cache().read("delayed")).toBeNull();
    await expect(readFile(join(f.directory, "pages.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { release.resolve(); await save; }
});

it("accounts for UTF-8 bytes, scope metadata and many evictions without serializing the full file per eviction", async () => {
  const f = await fixture(10000), cache = f.cache(); await cache.accept(fingerprint, await cache.begin());
  for (let i = 0; i < 40; i++) await cache.put(i, "漢字".repeat(20), fingerprint);
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    await cache.put("large", "漢字".repeat(700), fingerprint);
    const fullFiles = stringify.mock.calls.filter(([value]) => value && typeof value === "object" &&
      "scopes" in value && Array.isArray(value.scopes) && value.scopes.some((scope: { pages: unknown[] }) => scope.pages.length));
    expect(fullFiles).toHaveLength(1);
  } finally { stringify.mockRestore(); }
  expect((await readFile(join(f.directory, "pages.json"))).byteLength).toBeLessThanOrEqual(10000);
  expect(await cache.read(0)).toBeNull(); expect(await cache.read("large")).not.toBeNull();
  for (let i = 0; i < 40; i++) {
    const another = f.cache(["workspace", `share-${i}`]); await another.accept(fingerprint, await another.begin());
    expect((await readFile(join(f.directory, "pages.json"))).byteLength).toBeLessThanOrEqual(10000);
  }
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


it.each([false, true])("uses authorized in-memory metadata during the first save without an extra describe (changed fingerprint: %s)", async changed => {
  const f = await fixture(), cache = f.cache();
  await cache.accept(fingerprint, await cache.begin());
  if (changed) { await f.data().describe(id(1)); await f.settled(); f.token("d".repeat(64)); }
  f.relayResponse.mockClear();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let purges = changed ? 1 : 0;
  disk.beforeSync = async () => {
    if (purges-- > 0) return;
    disk.beforeSync = null; entered.resolve(); await release.promise;
  };
  try {
    expect(await f.data().inspect!(id(1))).toEqual({ dataset: description, copy: undefined });
    await entered.promise;
    expect(await cache.read(["describe", id(1)])).toBeNull();
    expect(await cache.peek(["describe", id(1)])).toEqual(description);
    expect(await f.data().invoke(invocation)).toEqual(result);
    expect(f.relayResponse.mock.calls.map(([, path]) => path.split("/").at(-1))).toEqual([id(1), "invoke"]);
  } finally { release.resolve(); await f.settled(); }
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
