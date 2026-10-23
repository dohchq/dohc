import {expect, it, vi} from "vitest";
import type {EngineClient} from "@dohc/workspace-engine-client/daemon";

// The engine's queue heads, by outbox, as the outbox read answers them.
const outboxes = vi.hoisted(() => ({heads: new Map<string, unknown>(), pending: new Map<string, unknown>(), retried: [] as unknown[],
  reads: [] as string[]}));
vi.mock("@dohc/workspace-engine-client", async original => ({
  ...await original<typeof import("@dohc/workspace-engine-client")>(),
  OwnerYDocOutbox: class {
    // A delivery head never transfers the base.
    readDeliveryHead(outboxId: string) {outboxes.reads.push(`delivery:${outboxId}`); return Promise.resolve(outboxes.heads.get(outboxId));}
    readHead(outboxId: string) {outboxes.reads.push(`head:${outboxId}`); return Promise.resolve(outboxes.heads.get(outboxId));}
    readPending(outboxId: string) {return Promise.resolve(outboxes.pending.get(outboxId));}
    retry(input: unknown) {outboxes.retried.push(input); return Promise.resolve({retryDeliveryId: "delivery-a"});}
    dispose() {}
  },
}));
const {readOwnerLiveQuarantines, readOwnerLiveQueue, retryOwnerLiveQuarantine} = await import("./ownerLiveQuarantine");

const binding = (objectId: string, restoreFenceGeneration = 1) => ({workspaceId: "workspace", mainVersionId: "main", objectId, lineageClaimId: "a".repeat(64),
  currentPath: `${objectId}.md`, selectorPaths: [`${objectId}.md`], restoreFenceGeneration});
const draft = (objectId: string, state: "active" | "quarantined" | null, revision = 1, pendingBytes = 10) =>
  ({binding: binding(objectId), outboxId: state === null ? null : `outbox-${objectId}`, state, revision, pendingBytes});
const head = (objectId: string, quarantineReason: string, retryDeliveryId: string | null = null) => outboxes.heads.set(`outbox-${objectId}`,
  {outboxId: `outbox-${objectId}`, binding: binding(objectId), state: "quarantined", quarantineReason, retryDeliveryId,
    entry: {deliveryId: `delivery-${objectId}`}});
const stop = (objectId: string, state: "requested" | "released", options: {retirementOwed?: boolean; deferred?: boolean; generation?: number; version?: string} = {}) =>
  ({document: {objectId, mainVersionId: options.version ?? "main", currentPath: `${objectId}.md`}, binding: binding(objectId, options.generation ?? 1),
    state, retirementOwed: options.retirementOwed ?? state === "requested", ...(options.deferred ? {deferred: {unsentEdits: 40, editable: false}} : {})});
const record = (objectId: string, recovery: string, extra: object = {}) => ({objectId, path: `${objectId}.md`, reason: "invalid-update",
  outboxId: `outbox-${objectId}`, binding: binding(objectId), headDeliveryId: `delivery-${objectId}`, recovery, ...extra});

it("reads every refused queue from durable state, and leaves binding changes to enrollment", async () => {
  head("a", "invalid-update"); head("b", "binding-changed"); head("c", "capacity-refused", "delivery-c");
  head("d", "invalid-update"); head("e", "stale-binding");
  const listDrafts = vi.fn()
    .mockResolvedValueOnce({drafts: [draft("a", "quarantined"), draft("b", "quarantined"), draft("live", "active")], next: {mainVersionId: "main", objectId: "live", lineageClaimId: "a".repeat(64)}})
    .mockResolvedValueOnce({drafts: [draft("c", "quarantined"), draft("d", "quarantined"), draft("e", "quarantined"), draft("none", null)], next: null});
  const client = {ownerYDocListDrafts: listDrafts, sendRequest: vi.fn(),
    ownerYDocStopList: vi.fn(async () => [stop("d", "released", {deferred: true})])} as unknown as EngineClient;
  expect(await readOwnerLiveQuarantines(client, "handle")).toEqual([
    record("a", "paused"),
    record("c", "retrying", {reason: "capacity-refused"}),
    record("d", "stopped-kept"),
  ]);
  expect(listDrafts.mock.calls.map(call => call[1].after?.objectId ?? null)).toEqual([null, "live"]);
});

// A Stop that asked the server but has no confirmed retirement and release is
// still waiting; only one for the queue's own version and binding counts.
it("tells a waiting Stop from a finished one, and ignores a Stop for another version or binding", async () => {
  for (const id of ["w", "o", "x", "v"]) head(id, "invalid-update");
  const client = {sendRequest: vi.fn(),
    ownerYDocListDrafts: vi.fn(async () => ({drafts: ["w", "o", "x", "v"].map(id => draft(id, "quarantined")), next: null})),
    ownerYDocStopList: vi.fn(async () => [stop("w", "requested"), stop("o", "released", {retirementOwed: true}),
      stop("x", "released", {deferred: true, generation: 2}), stop("v", "requested", {version: "older"})])} as unknown as EngineClient;
  expect((await readOwnerLiveQuarantines(client, "handle")).map(row => [row.objectId, row.recovery])).toEqual([
    ["w", "stopping"], ["o", "stopping"], ["x", "paused"], ["v", "paused"],
  ]);
});

it("keeps a release that could not write the file only while its queue is gone", async () => {
  head("q", "invalid-update");
  const client = {sendRequest: vi.fn(), ownerYDocStopList: vi.fn(async () => []),
    ownerYDocListDrafts: vi.fn(async () => ({drafts: [draft("q", "quarantined")], next: null}))} as unknown as EngineClient;
  const unwritten = [{workspaceId: "workspace", objectId: "q", path: "q.md", reason: "invalid-update", binding: binding("q")},
    {workspaceId: "workspace", objectId: "gone", path: "gone.md", reason: "capacity-refused", binding: binding("gone")}];
  expect(await readOwnerLiveQuarantines(client, "handle", {unwritten})).toEqual([
    record("q", "paused"),
    {objectId: "gone", path: "gone.md", reason: "capacity-refused", outboxId: null, binding: binding("gone"), headDeliveryId: null, recovery: "not-written"},
  ]);
});

// A large parked queue is read once: its base never, its head only when the draft changed.
it("reads an unchanged queue's head once, and never its base", async () => {
  outboxes.reads.length = 0;
  head("big", "capacity-refused");
  let revision = 4;
  const client = {sendRequest: vi.fn(), ownerYDocStopList: vi.fn(async () => []),
    ownerYDocListDrafts: vi.fn(async () => ({drafts: [draft("big", "quarantined", revision, 9_000_000)], next: null}))} as unknown as EngineClient;
  const heads = new Map();
  for (let pass = 0; pass < 5; pass++) expect(await readOwnerLiveQuarantines(client, "handle", {heads})).toEqual([record("big", "paused", {reason: "capacity-refused"})]);
  expect(outboxes.reads).toEqual(["delivery:outbox-big"]);
  revision = 5;
  await readOwnerLiveQuarantines(client, "handle", {heads});
  expect(outboxes.reads).toEqual(["delivery:outbox-big", "delivery:outbox-big"]);
  // A granted Try again is never trusted from the cache.
  head("big", "capacity-refused", "delivery-big");
  revision = 6;
  await readOwnerLiveQuarantines(client, "handle", {heads}); await readOwnerLiveQuarantines(client, "handle", {heads});
  expect(outboxes.reads).toHaveLength(4);
});

it("asks the engine for one more attempt at the binding the queue was refused at", async () => {
  await retryOwnerLiveQuarantine({sendRequest: vi.fn()} as unknown as EngineClient, "handle",
    {...record("a", "paused"), outboxId: "outbox-a", headDeliveryId: "delivery-a", recovery: "paused"});
  expect(outboxes.retried).toEqual([{outboxId: "outbox-a", binding: binding("a")}]);
});

it("reads a whole queue for a recovery copy only while it is still the one the owner saw", async () => {
  const queue = {...record("a", "paused"), outboxId: "outbox-a", headDeliveryId: "delivery-a", recovery: "paused" as const};
  outboxes.pending.set("outbox-a", {state: "quarantined", binding: binding("a"), entries: []});
  await expect(readOwnerLiveQueue({sendRequest: vi.fn()} as unknown as EngineClient, "handle", queue)).resolves.toMatchObject({state: "quarantined"});
  outboxes.pending.set("outbox-a", {state: "quarantined", binding: binding("a", 2), entries: []});
  await expect(readOwnerLiveQueue({sendRequest: vi.fn()} as unknown as EngineClient, "handle", queue)).rejects.toThrow("This document changed.");
});
