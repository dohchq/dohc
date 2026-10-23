import {afterEach, expect, it} from "vitest";
import {fixture as ticketFixture, binding, scope} from "../liveTickets.test-helper";
import {openSyncRelayStorage} from "../storage";
import {SERVICE_KEPT_EDITS, SERVICE_KEPT_EDITS_PAGE} from "./serviceKeptEdits";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
const document = {workspaceId: scope.workspaceId, objectId: binding.objectId};
const identity = {replicationEpoch: "epoch-1", streamIdentity: "stream-1"};

it("keeps a server-held refusal and its copy across a relay restart, and refuses a changed table", async () => {
  const f = await ticketFixture(); cleanups.push(f.close);
  const refuse = (refusalKey: string) => f.storage.recordServiceKeptEdits({identity, outboxId: "outbox-1", binding, reason: "invalid-update", headDeliveryId: "delivery-1", refusalKey, nowMs: 5});
  refuse("refusal-1");
  const first = f.storage.readServiceKeptEdits(scope.workspaceId, "outbox-1")!.generation;
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(true);
  expect(() => f.storage.recordServiceKeptEdits({identity, outboxId: "outbox-1", binding, reason: "invented", headDeliveryId: "delivery-1", refusalKey: "refusal-2", nowMs: 5})).toThrow();
  expect(f.storage.confirmServiceKeptEditsCopy({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: first})).toBe(true);
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
    return f.storage.readServiceKeptEdits(scope.workspaceId, "outbox-1")!.generation;
  };
  const read = refuse("refusal-1");
  // A Try again elsewhere delivers the queue, and it is forgotten; then it is refused again.
  f.storage.forgetServiceKeptEdits({workspaceId: scope.workspaceId, outboxId: "outbox-1"});
  const later = refuse("refusal-2");
  expect(later).not.toBe(read);
  expect(f.storage.confirmServiceKeptEditsCopy({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: read})).toBe(false);
  expect(f.storage.markServiceKeptEditsRetrying({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: read})).toBe(false);
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(true);
  // A Try again is marked once per refusal, and the host can end it.
  expect(f.storage.markServiceKeptEditsRetrying({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: later})).toBe(true);
  expect(f.storage.markServiceKeptEditsRetrying({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: later})).toBe(false);
  f.storage.endServiceKeptEditsRetry({workspaceId: scope.workspaceId, outboxId: "outbox-1"});
  expect(f.storage.readServiceKeptEdits(scope.workspaceId, "outbox-1")).toMatchObject({generation: later, retrying: false});
});

// Proves: a row names the store that holds its queue, and only rows of the
// attached store's identity hold the document. A refusal recorded again from
// another store's queue is a new row of that store.
it("holds a document only by uncopied rows of the attached store's identity", async () => {
  const f = await ticketFixture(); cleanups.push(f.close);
  const rotated = {replicationEpoch: "epoch-2", streamIdentity: "stream-2"};
  f.storage.recordServiceKeptEdits({identity, outboxId: "outbox-old", binding, reason: "invalid-update", headDeliveryId: "delivery-1", refusalKey: "refusal-1", nowMs: 5});
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(true);
  // After a rotation the old row cannot be copied, and it holds nothing under the new identity.
  expect(f.storage.serviceKeptEditsHeld(document, rotated)).toBe(false);
  expect(f.storage.readServiceKeptEdits(scope.workspaceId, "outbox-old")).toMatchObject({identity, copied: false});
  f.storage.recordServiceKeptEdits({identity: rotated, outboxId: "outbox-new", binding, reason: "invalid-update", headDeliveryId: "delivery-2", refusalKey: "refusal-2", nowMs: 6});
  expect(f.storage.serviceKeptEditsHeld(document, rotated)).toBe(true);
  // The same refusal key from another store is that store's refusal.
  f.storage.recordServiceKeptEdits({identity: rotated, outboxId: "outbox-old", binding, reason: "invalid-update", headDeliveryId: "delivery-1", refusalKey: "refusal-1", nowMs: 7});
  expect(f.storage.readServiceKeptEdits(scope.workspaceId, "outbox-old")).toMatchObject({identity: rotated});
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
  const own = f.storage.readServiceKeptEdits(scope.workspaceId, "outbox-0")!;
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
  expect(f.storage.readServiceKeptEdits(scope.workspaceId, "outbox-0")).toEqual(own);
  f.storage.confirmServiceKeptEditsCopy({workspaceId: scope.workspaceId, outboxId: "outbox-0", generation: own.generation});
  f.storage.releaseServiceKeptEdits(document);
  expect(f.storage.readServiceKeptEdits(scope.workspaceId, "outbox-0")).toBeNull();
  expect(f.storage.readServiceKeptEdits(scope.workspaceId, "outbox-1")).toMatchObject({copied: false});
});
