import {join} from "node:path";
import {expect, it, vi} from "vitest";
import {EngineRequestError, type EngineClient} from "@dohc/workspace-engine-client/daemon";
import type {OwnerYDocOutboxRecovery} from "@dohc/workspace-engine-client";
import {createUnwrittenReleases, recoverySnapshot} from "./ownerLiveReleases";
import {createTestScratch} from "./testTemp";

// The engine's queue heads, by outbox, as the outbox read answers them.
const outboxes = vi.hoisted(() => ({heads: new Map<string, unknown>(), pending: new Map<string, unknown>(), retried: [] as unknown[],
  reads: [] as string[]}));
vi.mock("@dohc/workspace-engine-client", async original => ({
  ...await original<typeof import("@dohc/workspace-engine-client")>(),
  OwnerYDocOutbox: class {
    // A delivery head never transfers the base. A head set to an error is the engine's refusal of it.
    readDeliveryHead(outboxId: string) {
      outboxes.reads.push(`delivery:${outboxId}`);
      const head = outboxes.heads.get(outboxId);
      return head instanceof Error ? Promise.reject(head) : Promise.resolve(head);
    }
    readHead(outboxId: string) {outboxes.reads.push(`head:${outboxId}`); return Promise.resolve(outboxes.heads.get(outboxId));}
    readRecovery(outboxId: string) {outboxes.reads.push(`recovery:${outboxId}`); return Promise.resolve(outboxes.pending.get(outboxId));}
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

// The engine refusing one queue's head leaves that queue an unreadable row,
// naming the refusal, and the others usable; an engine that cannot answer at
// all still fails the whole read. A queue a strict read names fails it too.
it("keeps an unreadable row for a queue whose head the engine refuses, and fails a strict read of it", async () => {
  head("before", "invalid-update"); head("after", "invalid-update");
  const waiting = new EngineRequestError(1, {code: "INVALID_PARAMS", message: "owner-outbox-accepted-state-incomplete", retry: "no"});
  outboxes.heads.set("outbox-waiting", waiting);
  outboxes.heads.set("outbox-damaged", new EngineRequestError(1, {code: "INTERNAL", message: "owner-outbox-state-corrupt", retry: "no"}));
  const client = {sendRequest: vi.fn(), ownerYDocStopList: vi.fn(async () => []),
    ownerYDocListDrafts: vi.fn(async () => ({drafts: ["before", "waiting", "damaged", "after"].map(id => draft(id, "quarantined")), next: null}))} as unknown as EngineClient;
  const unreadable = (objectId: string, reason: string) => ({...record(objectId, "unreadable"), reason, headDeliveryId: null});
  const heads = new Map();
  for (let pass = 0; pass < 2; pass++) expect(await readOwnerLiveQuarantines(client, "handle", {heads})).toEqual([record("before", "paused"),
    unreadable("waiting", "owner-outbox-accepted-state-incomplete"), unreadable("damaged", "owner-outbox-state-corrupt"), record("after", "paused")]);
  // Never cached: each read asks the engine again.
  expect(heads.has("outbox-waiting")).toBe(false);
  await expect(readOwnerLiveQuarantines(client, "handle", {strict: binding => binding.objectId === "waiting"})).rejects.toBe(waiting);
  await expect(readOwnerLiveQuarantines(client, "handle", {strict: binding => binding.objectId === "before"})).resolves.toHaveLength(4);
  const unavailable = new EngineRequestError(1, {code: "WORKSPACE_UNAVAILABLE", message: "workspace unavailable", retry: "afterBackoff"});
  outboxes.heads.set("outbox-waiting", unavailable);
  await expect(readOwnerLiveQuarantines(client, "handle")).rejects.toBe(unavailable);
  outboxes.heads.delete("outbox-waiting"); outboxes.heads.delete("outbox-damaged");
});

// Whether the record came from that queue is unknown, so it keeps its own row.
it("keeps a record its own row beside an unreadable queue of the same document", async () => {
  outboxes.heads.set("outbox-only", new EngineRequestError(1, {code: "INVALID_PARAMS", message: "owner-outbox-accepted-state-incomplete", retry: "no"}));
  const client = {sendRequest: vi.fn(), ownerYDocStopList: vi.fn(async () => []),
    ownerYDocListDrafts: vi.fn(async () => ({drafts: [draft("only", "quarantined")], next: null}))} as unknown as EngineClient;
  const release = {workspaceId: "workspace", objectId: "only", path: "only.md", reason: "invalid-update", binding: binding("only"), headDeliveryId: null, snapshot: "1".repeat(64), retry: true};
  expect(await readOwnerLiveQuarantines(client, "handle", {unwritten: [release]})).toEqual([
    {...record("only", "unreadable"), reason: "owner-outbox-accepted-state-incomplete", headDeliveryId: null},
    {objectId: "only", path: "only.md", reason: "invalid-update", outboxId: null, binding: binding("only"), headDeliveryId: null, recovery: "not-written"}]);
  outboxes.heads.delete("outbox-only");
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

it("keeps a release that could not write the file only while the queue it came from is gone, with Try again only while it offers one", async () => {
  outboxes.reads.length = 0;
  head("q", "invalid-update"); head("rebuilt", "invalid-update"); head("restored", "invalid-update");
  // The queue each record's package came from, and a restore that repeats a binding and head with fewer edits.
  const contents = (objectId: string, deliveries: string[]) => ({outboxId: `outbox-${objectId}`, binding: binding(objectId), baseUpdateDigest: "b".repeat(64),
    checkpoint: null, state: "quarantined", entries: deliveries.map((deliveryId, index) => ({sequence: index + 1, deliveryId, appendKey: deliveryId,
      updateDigest: "d".repeat(64), update: new Uint8Array([index + 1]), byteLength: 1, createdAtMs: 1}))}) as unknown as OwnerYDocOutboxRecovery;
  outboxes.pending.set("outbox-q", contents("q", ["delivery-q"]));
  outboxes.pending.set("outbox-restored", contents("restored", ["delivery-restored"]));
  const client = {sendRequest: vi.fn(), ownerYDocStopList: vi.fn(async () => []),
    ownerYDocListDrafts: vi.fn(async () => ({drafts: [draft("q", "quarantined"), draft("rebuilt", "quarantined"), draft("restored", "quarantined")], next: null}))} as unknown as EngineClient;
  const unwritten = [{workspaceId: "workspace", objectId: "q", path: "q.md", reason: "invalid-update", binding: binding("q"), headDeliveryId: "delivery-q",
    snapshot: recoverySnapshot(contents("q", ["delivery-q"])), retry: true},
    // An engine store reset rebuilt this document's queue under the identical binding.
    {workspaceId: "workspace", objectId: "rebuilt", path: "rebuilt.md", reason: "invalid-update", binding: binding("rebuilt"), headDeliveryId: "delivery-before-reset", snapshot: "1".repeat(64), retry: true},
    {workspaceId: "workspace", objectId: "restored", path: "restored.md", reason: "invalid-update", binding: binding("restored"), headDeliveryId: "delivery-restored",
      snapshot: recoverySnapshot(contents("restored", ["delivery-restored", "delivery-later"])), retry: true},
    {workspaceId: "workspace", objectId: "gone", path: "gone.md", reason: "capacity-refused", binding: binding("gone"), headDeliveryId: "delivery-gone", snapshot: "2".repeat(64), retry: true},
    {workspaceId: "workspace", objectId: "ended", path: "ended.md", reason: "capacity-refused", binding: binding("ended"), headDeliveryId: "delivery-ended", snapshot: "3".repeat(64), retry: false},
    {workspaceId: "workspace", objectId: "damaged", path: "damaged.md", reason: "unreadable-record", binding: null, headDeliveryId: null, snapshot: null, retry: false}];
  const heads = new Map();
  for (let pass = 0; pass < 2; pass++) expect(await readOwnerLiveQuarantines(client, "handle", {unwritten, heads})).toEqual([
    record("q", "paused"),
    record("rebuilt", "paused"),
    record("restored", "paused"),
    {objectId: "rebuilt", path: "rebuilt.md", reason: "invalid-update", outboxId: null, binding: binding("rebuilt"), headDeliveryId: "delivery-before-reset", recovery: "not-written"},
    {objectId: "restored", path: "restored.md", reason: "invalid-update", outboxId: null, binding: binding("restored"), headDeliveryId: "delivery-restored", recovery: "not-written"},
    {objectId: "gone", path: "gone.md", reason: "capacity-refused", outboxId: null, binding: binding("gone"), headDeliveryId: "delivery-gone", recovery: "not-written"},
    {objectId: "ended", path: "ended.md", reason: "capacity-refused", outboxId: null, binding: binding("ended"), headDeliveryId: "delivery-ended", recovery: "cannot-write"},
    {objectId: "damaged", path: "damaged.md", reason: "unreadable-record", outboxId: null, binding: null, headDeliveryId: null, recovery: "cannot-write"},
  ]);
  // Only a queue a record may have come from is read whole, and once while its draft is unchanged.
  expect(outboxes.reads.filter(read => read.startsWith("recovery:"))).toEqual(["recovery:outbox-q", "recovery:outbox-restored"]);
});

// A record damaged in another field keeps the head and snapshot of the queue
// it came from, but no binding the queue's row could speak for. It keeps its
// own row, so Save recovery copy can end it.
it("shows a damaged record beside the queue it came from, even with that queue's head and snapshot", async () => {
  head("intact", "invalid-update");
  const contents = {outboxId: "outbox-intact", binding: binding("intact"), baseUpdateDigest: "b".repeat(64), checkpoint: null, state: "quarantined",
    entries: [{sequence: 1, deliveryId: "delivery-intact", appendKey: "a", updateDigest: "d".repeat(64), update: new Uint8Array([1]), byteLength: 1, createdAtMs: 1}]} as unknown as OwnerYDocOutboxRecovery;
  outboxes.pending.set("outbox-intact", contents);
  const client = {sendRequest: vi.fn(), ownerYDocStopList: vi.fn(async () => []),
    ownerYDocListDrafts: vi.fn(async () => ({drafts: [draft("intact", "quarantined")], next: null}))} as unknown as EngineClient;
  const damaged = {workspaceId: "workspace", objectId: "intact", path: "intact.md", reason: "invalid-update", binding: null,
    headDeliveryId: "delivery-intact", snapshot: recoverySnapshot(contents), retry: false};
  expect(await readOwnerLiveQuarantines(client, "handle", {unwritten: [damaged]})).toEqual([record("intact", "paused"),
    {objectId: "intact", path: "intact.md", reason: "invalid-update", outboxId: null, binding: null, headDeliveryId: "delivery-intact", recovery: "cannot-write"}]);
});

// A Stop's release failed, then the server accepted another edit, which moved
// the queue's checkpoint. The next Stop's put keeps the first package of the
// same refused edits, and the queue's row still speaks for their record.
it("keeps one release's record and package across a checkpoint advance, and the queue's row still hides it", async () => {
  head("plan", "invalid-update");
  const queue = (checkpoint: number): OwnerYDocOutboxRecovery => ({outboxId: "outbox-plan", binding: binding("plan"), baseUpdateDigest: "b".repeat(64),
    baseUpdate: new Uint8Array([0]), checkpoint: new Uint8Array([checkpoint]), checkpointDigest: String(checkpoint).repeat(64).slice(0, 64), state: "quarantined", pendingBytes: 1, oldestEntryAtMs: 1,
    quarantineReason: "invalid-update", observedBinding: null, retryDeliveryId: null,
    entries: [{sequence: 1, deliveryId: "delivery-plan", appendKey: "a", updateDigest: "d".repeat(64), update: new Uint8Array([1]), byteLength: 1, createdAtMs: 1}]});
  const release = (contents: OwnerYDocOutboxRecovery) => ({workspaceId: "workspace", objectId: "plan", path: "plan.md", reason: "invalid-update",
    binding: binding("plan"), headDeliveryId: "delivery-plan", snapshot: recoverySnapshot(contents), retry: true});
  const scratch = await createTestScratch("dohc-checkpoint-advance-");
  const releases = createUnwrittenReleases(() => join(scratch, "owner-live-releases.json"));
  await releases.put(release(queue(1)), "before the advance");
  await releases.put(release(queue(2)), "after the advance");
  expect(await releases.recovery("workspace", "plan")).toBe("before the advance");
  outboxes.pending.set("outbox-plan", queue(2));
  const client = {sendRequest: vi.fn(), ownerYDocStopList: vi.fn(async () => [stop("plan", "requested")]),
    ownerYDocListDrafts: vi.fn(async () => ({drafts: [draft("plan", "quarantined")], next: null}))} as unknown as EngineClient;
  expect(await readOwnerLiveQuarantines(client, "handle", {unwritten: await releases.list("workspace")})).toEqual([record("plan", "stopping")]);
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
