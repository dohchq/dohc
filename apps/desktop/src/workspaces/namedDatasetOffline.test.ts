import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createNamedDatasetCacheRegistry } from "./namedDatasetCache";
import { createNamedDatasetData } from "./namedDataset";
import { NamedDatasetOfflineError } from "./namedDatasetTransport";
import { createHash } from "node:crypto";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
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
  const cache = (binding: unknown = ["workspace", "share"]) => registry.scope({ owner, binding, assertCurrent() {} });
  const data = (binding?: unknown) => createNamedDatasetData({ workspaceId: "local-share", credentials: { userId: "helper", token: "private-token", email: "helper@example", serverUrl: "https://account", relayUrl: "https://relay" },
    shareView: { shareId: "share", relayUrl: "https://relay", grantedSelector: { paths: ["app"], versionId: null, access: "view" } },
    credentialGeneration: generation, currentCredentialGeneration: () => generation, assertCurrent() {}, signal: new AbortController().signal,
    relayJson: async () => { throw Error("unexpected transport"); }, offline: { cache: cache(binding), relayResponse } });
  return { directory, data, cache, relayResponse, registry: () => registry,
    offline(value = true) { offline = value; }, status(value: number) { status = value; }, token(value: string) { token = value; }, malformed() { malformed = true; },
    accountChanged() { generation++; },
    async restart() { await registry.close(); registry = createNamedDatasetCacheRegistry({ directory: () => directory, maxBytes }); await registry.credentialsChanged(owner); },
  };
}

it("saves only exact authorized result pages across restart, with honest stale scope and no offline writes", async () => {
  const f = await fixture();
  expect(await f.data().inspect!(id(1))).toMatchObject({ copy: { offline: false, coverage: "saved-pages" } });
  expect(await f.data().invoke(invocation)).toMatchObject({ ...result, copy: { offline: false, coverage: "saved-pages" } });
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
  const f = await fixture(); await f.data().describe(id(1));
  f.relayResponse.mockResolvedValueOnce(Response.json({ code: "capacity_reached", message: "Choose another time." }, { status: 409, headers: { "x-dohc-dataset-access": fingerprint } }));
  await expect(f.data().invoke(invocation)).rejects.toMatchObject({ refusal: { code: "capacity_reached", message: "Choose another time." } });
  const bytes = Buffer.alloc(3 * 1024 * 1024, 120), file = { fileId: "a".repeat(32), name: "receipt.png", contentType: "image/png", byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  f.relayResponse.mockResolvedValueOnce(Response.json({ file, bytesBase64: bytes.toString("base64") }, { headers: { "x-dohc-dataset-access": fingerprint } }));
  expect((await f.data().file({ action: "file", workspaceId: "local-share", ...invocation, fileId: file.fileId,
    read: { operationId: id(4), fieldId: id(3), input: {} } })).file).toEqual(file);
  expect(await readFile(join(f.directory, "pages.json"), "utf8")).not.toContain("bytesBase64");
});

it("isolates share/workspace scopes and removes the previous account's disk pages", async () => {
  const f = await fixture(); await f.data().describe(id(1)); f.offline();
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
  expect(await cache.put("large", "x".repeat(1000), fingerprint)).toBeNull();
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
