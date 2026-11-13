import { afterEach, expect, it } from "vitest";
import { fixture as ticketFixture, binding, scope } from "../liveTickets.test-helper";
import { openSyncRelayStorage } from "../storage";
import { SERVICE_KEPT_EDITS } from "./serviceKeptEdits";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const document = { workspaceId: scope.workspaceId, objectId: binding.objectId };
const identity = { replicationEpoch: "epoch-1", streamIdentity: "stream-1" };
const queue = (outboxId: string, of = identity) => ({
  workspaceId: scope.workspaceId,
  identity: of,
  outboxId,
});

it("keeps a server-held refusal and its copy across a relay restart, and refuses a changed table", async () => {
  const f = await ticketFixture();
  cleanups.push(f.close);
  const refuse = (refusalKey: string) =>
    f.storage.recordServiceKeptEdits({
      identity,
      outboxId: "outbox-1",
      binding,
      reason: "invalid-update",
      headDeliveryId: "delivery-1",
      refusalKey,
      nowMs: 5,
    });
  refuse("refusal-1");
  const first = f.storage.readServiceKeptEdits(queue("outbox-1"))!.generation;
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(true);
  expect(() =>
    f.storage.recordServiceKeptEdits({
      identity,
      outboxId: "outbox-1",
      binding,
      reason: "invented",
      headDeliveryId: "delivery-1",
      refusalKey: "refusal-2",
      nowMs: 5,
    }),
  ).toThrow();
  expect(
    f.storage.confirmServiceKeptEditsCopy({
      workspaceId: scope.workspaceId,
      outboxId: "outbox-1",
      generation: first,
      checkpointDigest: null,
    }),
  ).toBe(true);
  // The same refusal recorded again, as when its quarantine is written again, changes nothing.
  refuse("refusal-1");
  expect(f.storage.serviceKeptEditsHeld(document, identity)).toBe(false);
  refuse("refusal-2");
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {
    // The second refusal is not covered by the copy of the first.
    expect(reopened.listServiceKeptEdits(scope.workspaceId)).toEqual({
      keptEdits: [
        {
          workspaceId: scope.workspaceId,
          identity,
          outboxId: "outbox-1",
          objectId: binding.objectId,
          binding,
          reason: "invalid-update",
          headDeliveryId: "delivery-1",
          generation: first + 1,
          retrying: false,
          copied: false,
        },
      ],
      nextCursor: null,
    });
    expect(reopened.serviceKeptEditsHeld(document, identity)).toBe(true);
  } finally {
    reopened.close();
  }
  f.raw.exec(`DROP INDEX idx_sync_relay_service_kept_edits_object`);
  expect(() => openSyncRelayStorage(f.path, f.config)).toThrow(
    "Service kept edits constraints are damaged.",
  );
  expect(f.raw.prepare(`SELECT count(*) AS count FROM ${SERVICE_KEPT_EDITS}`).get()!.count).toBe(1);
});

// Proves: a row names the store that holds its queue, and only rows of the
// attached store's identity hold the document. A later store's queue with the
// same outbox ID, as after re-adopting the same lineage and base, is a row of
// its own: recording, forgetting, ending a Try again of or copying either one
// leaves the other as it was, and each refusal is found by its generation.
it("keeps one row per store for queues that share an outbox ID", async () => {
  const f = await ticketFixture();
  cleanups.push(f.close);
  const rotated = { replicationEpoch: "epoch-2", streamIdentity: "stream-2" };
  const refuse = (of: typeof identity, refusalKey: string) =>
    f.storage.recordServiceKeptEdits({
      identity: of,
      outboxId: "outbox-x",
      binding,
      reason: "invalid-update",
      headDeliveryId: "delivery-1",
      refusalKey,
      nowMs: 5,
    });
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
  expect(
    f.storage.readServiceKeptEditsRefusal({
      workspaceId: scope.workspaceId,
      outboxId: "outbox-x",
      generation: old.generation,
    }),
  ).toEqual(old);
  const current = f.storage.readServiceKeptEdits(queue("outbox-x", rotated))!;
  expect(
    f.storage.readServiceKeptEditsRefusal({
      workspaceId: scope.workspaceId,
      outboxId: "outbox-x",
      generation: later.generation,
    }),
  ).toBeNull();
  // Copying the later store's row leaves the old one uncopied; a Try again of it ends only its own.
  expect(
    f.storage.markServiceKeptEditsRetrying({
      workspaceId: scope.workspaceId,
      outboxId: "outbox-x",
      generation: old.generation,
    }),
  ).toBe(true);
  f.storage.endServiceKeptEditsRetry(queue("outbox-x", rotated));
  expect(
    f.storage.confirmServiceKeptEditsCopy({
      workspaceId: scope.workspaceId,
      outboxId: "outbox-x",
      generation: current.generation,
      checkpointDigest: null,
    }),
  ).toBe(true);
  expect(f.storage.readServiceKeptEdits(queue("outbox-x"))).toMatchObject({
    copied: false,
    retrying: true,
  });
  f.storage.endServiceKeptEditsRetry(queue("outbox-x"));
  // Forgetting the later store's queue, as when it delivers again, keeps the old row.
  f.storage.forgetServiceKeptEdits(queue("outbox-x", rotated));
  expect(f.storage.readServiceKeptEdits(queue("outbox-x"))).toEqual(old);
  expect(f.storage.serviceKeptEditsHeld(document, rotated)).toBe(false);
});

// Proves: while a queue stays frozen at its owner's adoption seed, a copy
// counts only for the checkpoint a copy reads now. A copy confirmed before a
// later accepted edit holds the document and keeps its row until a copy of
// the newer checkpoint; a copy made after the edit lets it go at once.
