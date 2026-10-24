import {afterEach, expect, it} from "vitest";
import {cleanupLiveDeliveryFixtures, registered} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";
import {openSyncRelayStorage} from "../storage";
import {readServiceActivationRetirement, SERVICE_ACTIVATION_RETIREMENTS} from "./serviceActivationRetirement";
import type {StorageContext} from "./context";

afterEach(cleanupLiveDeliveryFixtures);
const activationId = `ordinary-activation-${"e".repeat(64)}`;

// Proves: once Pause or the loss of the last Edit grant commits, an update the
// relay validated earlier is refused at its commit. The retirement keeps the
// journal cursor the fence closed at, and Resume or a restored grant does not
// reopen admission while it is pending.
it.each(["pause", "revoke"] as const)("refuses a validated update whose commit follows the fence: %s", cause => {
  const f = registered({deployment: true});
  try {
    const document = f.input.evidence.document;
    f.storage.claimWorkspaceIdentity({workspaceId: "workspace", replicationEpoch: "epoch", streamIdentity: "stream"});
    const enrollment = {workspaceId: "workspace", path: "docs/a.md", shareId: "share", ownerUserId: "owner", nowMs: 10, guard() {}};
    f.storage.enrollServiceHostDocument(enrollment);
    expect(f.storage.commitLiveUpdateJournal(f.capture(f.update("title", "First"), "first")).result.kind).toBe("accepted");
    f.write(db => db.prepare(`INSERT INTO sync_relay_service_activations VALUES ('history',?,?,'main',?,?,'{}','{}',?,x'0000','owner','share','{}',1)`)
      .run(activationId, document.workspaceId, document.objectId, document.lineageClaimId, document.lineageClaimId));
    const delayed = f.capture(f.update("title", "Delayed"), "delayed");
    if (cause === "pause") f.storage.setServiceHostEnrollmentEnabled({...enrollment, enabled: false, nowMs: 20});
    else expect(f.storage.revokeShareGrant({shareId: "share", grantId: "grant", revokedAtMs: 20}).ok).toBe(true);
    expect(f.storage.commitLiveUpdateJournal(delayed).result).toEqual({kind: "refused", reason: "authority-refused"});
    const cursor = f.raw.prepare("SELECT journal_cursor FROM sync_relay_live_update_journal WHERE delivery_id='first'").get()!.journal_cursor;
    const recorded = {relayDatabaseNamespace: "history", activationId, ...document, restoreFenceGeneration: 1, acceptedThrough: cursor};
    expect(readServiceActivationRetirement(f.storage as StorageContext, document)).toEqual(recorded);
    if (cause === "pause") f.storage.setServiceHostEnrollmentEnabled({...enrollment, enabled: true, nowMs: 30});
    else f.write(db => db.prepare("UPDATE sync_relay_share_grants SET status='active',revoked_at_ms=NULL WHERE grant_id='grant'").run());
    expect(f.storage.commitLiveUpdateJournal(delayed).result).toEqual({kind: "refused", reason: "authority-refused"});
    expect(() => f.capture(f.update("title", "After return"), "after")).toThrow("host-unavailable");
    expect(f.raw.prepare(`SELECT count(*) AS count FROM ${SERVICE_ACTIVATION_RETIREMENTS}`).get()!.count).toBe(1);
  } finally {f.close();}
});

it("refuses altered retirement storage on reopen", () => {
  const f = registered();
  try {
    f.write(db => db.exec(`CREATE TRIGGER unexpected_retirement_trigger AFTER INSERT ON ${SERVICE_ACTIVATION_RETIREMENTS} BEGIN SELECT 1; END`));
    expect(() => openSyncRelayStorage(f.path)).toThrow("Service activation retirement constraints are damaged.");
  } finally {f.close();}
});
