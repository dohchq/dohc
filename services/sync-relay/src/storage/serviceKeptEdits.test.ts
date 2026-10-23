import {afterEach, expect, it} from "vitest";
import {fixture as ticketFixture, binding, scope} from "../liveTickets.test-helper";
import {openSyncRelayStorage} from "../storage";
import {SERVICE_KEPT_EDITS} from "./serviceKeptEdits";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close();});
const document = {workspaceId: scope.workspaceId, objectId: binding.objectId};

it("keeps a server-held refusal and its copy across a relay restart, and refuses a changed table", async () => {
  const f = await ticketFixture(); cleanups.push(f.close);
  const refuse = () => f.storage.recordServiceKeptEdits({outboxId: "outbox-1", binding, reason: "invalid-update", headDeliveryId: "delivery-1", nowMs: 5});
  refuse();
  expect(f.storage.serviceKeptEditsHeld(document)).toBe(true);
  expect(() => f.storage.recordServiceKeptEdits({outboxId: "outbox-1", binding, reason: "invented", headDeliveryId: "delivery-1", nowMs: 5})).toThrow();
  expect(f.storage.confirmServiceKeptEditsCopy({workspaceId: scope.workspaceId, outboxId: "outbox-1", generation: 1})).toBe(true);
  refuse();
  const reopened = openSyncRelayStorage(f.path, f.config);
  try {
    // The second refusal is not covered by the copy of the first.
    expect(reopened.listServiceKeptEdits(scope.workspaceId)).toEqual([{workspaceId: scope.workspaceId, outboxId: "outbox-1", objectId: binding.objectId,
      binding, reason: "invalid-update", headDeliveryId: "delivery-1", generation: 2, retrying: false, copied: false}]);
    expect(reopened.serviceKeptEditsHeld(document)).toBe(true);
  } finally {reopened.close();}
  f.raw.exec(`DROP INDEX idx_sync_relay_service_kept_edits_object`);
  expect(() => openSyncRelayStorage(f.path, f.config)).toThrow("Service kept edits constraints are damaged.");
  expect(f.raw.prepare(`SELECT count(*) AS count FROM ${SERVICE_KEPT_EDITS}`).get()!.count).toBe(1);
});
