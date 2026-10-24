import {afterEach, expect, it} from "vitest";
import {fixture as ticketFixture, binding, scope} from "../liveTickets.test-helper";
import {openSyncRelayStorage} from "../storage";
import {SERVICE_KEPT_EDITS, SERVICE_KEPT_EDITS_PAGE} from "./serviceKeptEdits";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
const document = {workspaceId: scope.workspaceId, objectId: binding.objectId};
const identity = {replicationEpoch: "epoch-1", streamIdentity: "stream-1"};
const queue = (outboxId: string, of = identity) => ({workspaceId: scope.workspaceId, identity: of, outboxId});

it("keeps a server-held refusal and its copy across a relay restart, and refuses a changed table", async () => {
  const f = await ticketFixture(); cleanups.push(f.close);
  const refuse = (refusalKey: string) => f.storage.recordServiceKeptEdits({identity, outboxId: "outbox-1", binding, reason: "invalid-update", headDeliveryId: "delivery-1", refusalKey, nowMs: 5});
  refuse("refusal-1");
  const first = f.storage.readServiceKeptEdits(queue("outbox-1"))!.generation;
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(true);
  expect(() => f.storage.recordServiceKeptEdits({identity, outboxId: "outbox-1", binding, reason: "invented", headDeliveryId: "delivery-1", refusalKey: "refusal-2", nowMs: 5})).toThrow();
  expect(f.storage.confirmServiceKeptEditsCopy({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: first, checkpointDigest: null})).toBe(true);
  // The same refusal recorded again, as when its quarantine is written again, changes nothing.
  refuse("refusal-1");
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(false);
  refuse("refusal-2");
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {
    // The second refusal is not covered by the copy of the first.
    expect(reopened.listServiceKeptEdits(scope.workspaceId)).toEqual({keptEdits: [{workspaceId: scope.workspaceId, identity, outboxId: "outbox-1", objectId: binding.objectId,
      binding, reason: "invalid-update", headDeliveryId: "delivery-1", generation: first + 1, retrying: false, copied: false}], nextCursor: null});
    expect(reopened.serviceKeptEditsHeld(document, identity)).toBe(true);
  } finally {reopened.close();}
  f.raw.exec(`DROP INDEX idx_sync_relay_service_kept_edits_object`);
  expect(() => openSyncRelayStorage(f.path, f.config)).toThrow("Service kept edits constraints are damaged.");
  expect(f.raw.prepare(`SELECT count(*) AS count FROM ${SERVICE_KEPT_EDITS}`).get()!.count).toBe(1);
});

// Proves: a refusal's token is never handed out again, even once its row is
// forgotten and the same queue is refused again, so no earlier confirmation or
// Try again names a later refusal.
it("never reuses a refusal's token for a later refusal of the same queue", async () => {
  const f = await ticketFixture(); cleanups.push(f.close);
  const refuse = (refusalKey: string) => {
    f.storage.recordServiceKeptEdits({identity, outboxId: "outbox-1", binding, reason: "invalid-update", headDeliveryId: "delivery-1", refusalKey, nowMs: 5});
    return f.storage.readServiceKeptEdits(queue("outbox-1"))!.generation;
  };
  const read = refuse("refusal-1");
  // A Try again elsewhere delivers the queue, and it is forgotten; then it is refused again.
  f.storage.forgetServiceKeptEdits(queue("outbox-1"));
  const later = refuse("refusal-2");
  expect(later).not.toBe(read);
  expect(f.storage.confirmServiceKeptEditsCopy({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: read, checkpointDigest: null})).toBe(false);
  expect(f.storage.markServiceKeptEditsRetrying({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: read})).toBe(false);
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(true);
  // A Try again is marked once per refusal, and the host can end it.
  expect(f.storage.markServiceKeptEditsRetrying({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: later})).toBe(true);
  expect(f.storage.markServiceKeptEditsRetrying({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: later})).toBe(false);
  f.storage.endServiceKeptEditsRetry(queue("outbox-1"));
  expect(f.storage.readServiceKeptEdits(queue("outbox-1"))).toMatchObject({generation: later, retrying: false});
});

// Proves: a row names the store that holds its queue, and only rows of the
// attached store's identity hold the document. A later store's queue with the
// same outbox ID, as after re-adopting the same lineage and base, is a row of
// its own: recording, forgetting, ending a Try again of or copying either one
// leaves the other as it was, and each refusal is found by its generation.
it("keeps one row per store for queues that share an outbox ID", async () => {
  const f = await ticketFixture(); cleanups.push(f.close);
  const rotated = {replicationEpoch: "epoch-2", streamIdentity: "stream-2"};
  const refuse = (of: typeof identity, refusalKey: string) => f.storage.recordServiceKeptEdits({identity: of, outboxId: "outbox-x", binding, reason: "invalid-update",
    headDeliveryId: "delivery-1", refusalKey, nowMs: 5});
  refuse(identity, "refusal-1");
  const old = f.storage.readServiceKeptEdits(queue("outbox-x"))!;
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(true);
  // After a rotation the old row holds nothing under the new identity.
  expect(f.storage.serviceKeptEditsHeld(document, rotated)).toBe(false);
  // The same refusal key from the later store is that store's refusal.
  refuse(rotated, "refusal-1");
  const later = f.storage.readServiceKeptEdits(queue("outbox-x", rotated))!;
  expect(later.generation).not.toBe(old.generation);
  expect(f.storage.serviceKeptEditsHeld(document, rotated)).toBe(true);
  refuse(rotated, "refusal-2");
  expect(f.storage.readServiceKeptEdits(queue("outbox-x"))).toEqual(old);
  expect(f.storage.readServiceKeptEditsRefusal({workspaceId: scope.workspaceId, outboxId: "outbox-x", generation: old.generation})).toEqual(old);
  const current = f.storage.readServiceKeptEdits(queue("outbox-x", rotated))!;
  expect(f.storage.readServiceKeptEditsRefusal({workspaceId: scope.workspaceId, outboxId: "outbox-x", generation: later.generation})).toBeNull();
  // Copying the later store's row leaves the old one uncopied; a Try again of it ends only its own.
  expect(f.storage.markServiceKeptEditsRetrying({workspaceId: scope.workspaceId, outboxId: "outbox-x", generation: old.generation})).toBe(true);
  f.storage.endServiceKeptEditsRetry(queue("outbox-x", rotated));
  expect(f.storage.confirmServiceKeptEditsCopy({workspaceId: scope.workspaceId, outboxId: "outbox-x", generation: current.generation, checkpointDigest: null})).toBe(true);
  expect(f.storage.readServiceKeptEdits(queue("outbox-x"))).toMatchObject({copied: false, retrying: true});
  f.storage.endServiceKeptEditsRetry(queue("outbox-x"));
  // Forgetting the later store's queue, as when it delivers again, keeps the old row.
  f.storage.forgetServiceKeptEdits(queue("outbox-x", rotated));
  expect(f.storage.readServiceKeptEdits(queue("outbox-x"))).toEqual(old);
  expect(f.storage.serviceKeptEditsHeld(document, rotated)).toBe(false);
});

// Proves: a workspace with more rows than one page lists them all through its
// cursor, so does one document's departure scan, and a document that left
// with every refusal copied gives up its rows while another document's
// uncopied rows stay listed.
it("pages every row of a workspace and of a document, and releases a document's copied rows once it left", async () => {
  const f = await ticketFixture(); cleanups.push(f.close);
  const total = SERVICE_KEPT_EDITS_PAGE + 3;
  for (let index = 0; index < total; index++) {
    f.storage.recordServiceKeptEdits({identity, outboxId: `outbox-${index}`, binding: index === 0 ? binding : {...binding, objectId: `other-object-${index}`},
      reason: "invalid-update", headDeliveryId: "delivery-1", refusalKey: `refusal-${index}`, nowMs: 5});
  }
  const first = f.storage.listServiceKeptEdits(scope.workspaceId);
  expect(first.keptEdits).toHaveLength(SERVICE_KEPT_EDITS_PAGE);
  const second = f.storage.listServiceKeptEdits(scope.workspaceId, first.nextCursor!);
  expect(second).toMatchObject({nextCursor: null});
  expect(new Set([...first.keptEdits, ...second.keptEdits].map(row => row.outboxId)).size).toBe(total);
  const own = f.storage.readServiceKeptEdits(queue("outbox-0"))!;
  expect(f.storage.serviceKeptEditsOf(document)).toEqual({keptEdits: [own], nextCursor: null});
  // One document with more queues than a page reaches its last through the cursor.
  const crowded = {workspaceId: scope.workspaceId, objectId: "crowded-object"};
  for (let index = 0; index <= SERVICE_KEPT_EDITS_PAGE; index++) {
    f.storage.recordServiceKeptEdits({identity, outboxId: `crowded-${index}`, binding: {...binding, objectId: crowded.objectId},
      reason: "invalid-update", headDeliveryId: "delivery-1", refusalKey: `crowded-refusal-${index}`, nowMs: 5});
  }
  const page = f.storage.serviceKeptEditsOf(crowded);
  expect(page.keptEdits).toHaveLength(SERVICE_KEPT_EDITS_PAGE);
  expect(f.storage.serviceKeptEditsOf(crowded, page.nextCursor!)).toMatchObject({keptEdits: [{outboxId: `crowded-${SERVICE_KEPT_EDITS_PAGE}`}], nextCursor: null});
  // An uncopied row stays, even once its document left.
  f.storage.releaseServiceKeptEdits(document);
  expect(f.storage.readServiceKeptEdits(queue("outbox-0"))).toEqual(own);
  f.storage.confirmServiceKeptEditsCopy({workspaceId: scope.workspaceId, outboxId: "outbox-0", generation: own.generation, checkpointDigest: null});
  f.storage.releaseServiceKeptEdits(document);
  expect(f.storage.readServiceKeptEdits(queue("outbox-0"))).toBeNull();
  expect(f.storage.readServiceKeptEdits(queue("outbox-1"))).toMatchObject({copied: false});
});

// Proves: while a queue stays frozen at its owner's adoption seed, a copy
// counts only for the checkpoint a copy reads now. A copy confirmed before a
// later accepted edit holds the document and keeps its row until a copy of
// the newer checkpoint; a copy made after the edit lets it go at once.
it("releases a frozen seed's row only for a copy of the checkpoint the host saw last", async () => {
  const f = await ticketFixture(); cleanups.push(f.close);
  const [older, newer] = ["a", "b"].map(digit => digit.repeat(64)) as [string, string];
  const refuse = (outboxId: string) => {
    f.storage.recordServiceKeptEdits({identity, outboxId, binding, reason: "invalid-update", headDeliveryId: "delivery-1", refusalKey: `${outboxId}-refusal`, nowMs: 5});
    return f.storage.readServiceKeptEdits(queue(outboxId))!.generation;
  };
  const copy = (outboxId: string, generation: number, checkpointDigest: string | null) =>
    f.storage.confirmServiceKeptEditsCopy({workspaceId: scope.workspaceId, outboxId, generation, checkpointDigest});
  // Copy, then a later accepted edit: the host now sees the newer checkpoint.
  const before = refuse("copied-first");
  expect(copy("copied-first", before, older)).toBe(true);
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(false);
  f.storage.observeServiceKeptEditsCheckpoint(queue("copied-first"), newer);
  expect(f.storage.readServiceKeptEdits(queue("copied-first"))).toMatchObject({copied: false});
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(true);
  f.storage.releaseServiceKeptEdits(document);
  expect(f.storage.readServiceKeptEdits(queue("copied-first"))).not.toBeNull();
  // A copy of no checkpoint never stands in for one.
  expect(copy("copied-first", before, null)).toBe(true);
  f.storage.releaseServiceKeptEdits(document);
  expect(f.storage.readServiceKeptEdits(queue("copied-first"))).toMatchObject({copied: false});
  expect(copy("copied-first", before, newer)).toBe(true);
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(false);
  // An edit, then a copy that holds it.
  const after = refuse("edited-first");
  f.storage.observeServiceKeptEditsCheckpoint(queue("edited-first"), newer);
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(true);
  expect(copy("edited-first", after, newer)).toBe(true);
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(false);
  f.storage.releaseServiceKeptEdits(document);
  expect(f.storage.serviceKeptEditsOf(document)).toEqual({keptEdits: [], nextCursor: null});
  expect(() => copy("edited-first", after, "x")).toThrow("Invalid kept edits checkpoint.");
});
