import {afterEach, expect, it} from "vitest";
import {cleanupLiveDeliveryFixtures, registered} from "../../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js";

afterEach(cleanupLiveDeliveryFixtures);
const declaration = {automationId: "collection:Tasks#mark", attribution: {actorKind: "automation" as const,
  onBehalfOf: "reader", depth: 1, run: {claimId: "claim", automationName: "Mark done"}}};
function fixture() {
  const f = registered({deployment: true});
  f.write(db => db.prepare(`INSERT INTO sync_relay_shares (share_id,workspace_id,granter_user_id,selector_json,created_at_ms)
    SELECT 'owner-share',workspace_id,granter_user_id,selector_json,created_at_ms FROM sync_relay_shares WHERE share_id='share'`).run());
  f.write(db => db.prepare(`INSERT INTO sync_relay_automation_presses
    (host_press_id,workspace_id,share_id,grant_id,grant_generation,press_id,user_id,automation_id,collection_path,
      definition_hash,record_id,state,accepted_by,accepted_generation,created_at_ms,updated_at_ms)
    VALUES ('press','workspace','share','grant',4,'recipient-press','reader',?,'docs',?,'record','accepted','server',1,1,1)`)
    .run(declaration.automationId, "a".repeat(16)));
  const input = {...f.capture(f.update(), "automation", {kind: "owner", userId: "owner", shareId: "owner-share"}),
    trustedAutomation: declaration, trustedAutomationPress: {hostPressId: "press", automationId: declaration.automationId}};
  return {...f, input};
}
it.each([
  "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2 WHERE grant_id='grant'",
  "UPDATE sync_relay_share_grants SET access='view',generation=5 WHERE grant_id='grant'",
  "UPDATE sync_relay_share_grants SET generation=5 WHERE grant_id='grant'",
  `UPDATE sync_relay_shares SET selector_json='{"paths":["docs/a.md"],"versionId":null}' WHERE share_id='share'`,
])("refuses an unaccepted queued write when its presser's original grant changes at admission: %s", sql => {
  const f = fixture();
  try {
    // Delivery captured the owner host while the reader still had its grant.
    // The transaction must read the grant again when that offline draft reaches it.
    f.write(db => db.exec(sql));
    expect(f.storage.commitLiveUpdateJournal(f.input)).toMatchObject({result: {kind: "refused", reason: "authority-refused"}, admitted: null});
    expect(f.journalRows().journal).toHaveLength(0);
  } finally {f.close();}
});
it("preserves the exact accepted receipt after the presser is revoked", () => {
  const f = fixture();
  try {
    const accepted = f.storage.commitLiveUpdateJournal(f.input);
    expect(accepted.result).toMatchObject({kind: "accepted", replayed: false});
    f.write(db => db.exec("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2 WHERE grant_id='grant'"));
    expect(f.storage.commitLiveUpdateJournal(f.input)).toMatchObject({result: {kind: "accepted", replayed: true,
      receipt: accepted.admitted!.metadata.accepted.receipt}});
    expect(f.journalRows().journal).toHaveLength(1);
  } finally {f.close();}
});
it("keeps owner Undo independent of the recipient's revoked grant", () => {
  const f = fixture();
  try {
    f.write(db => db.exec("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2 WHERE grant_id='grant'"));
    expect(f.storage.commitLiveUpdateJournal(f.input).result).toEqual({kind: "refused", reason: "authority-refused"});
    const undo = f.capture(f.input.updateBytes, "owner-undo");
    expect(f.storage.commitLiveUpdateJournal(undo).result).toMatchObject({kind: "accepted", replayed: false});
  } finally {f.close();}
});
it("refuses a press borrowed from another automation or presser", () => {
  const f = fixture();
  try {
    for (const changed of [
      {...declaration, attribution: {...declaration.attribution, onBehalfOf: "other-reader"}}]) {
      expect(f.storage.commitLiveUpdateJournal({...f.input, trustedAutomation: changed}).result)
        .toEqual({kind: "refused", reason: "authority-refused"});
    }
    expect(f.journalRows().journal).toHaveLength(0);
  } finally {f.close();}
});
it.each([false, true])("refuses a target outside the original share even with another View grant (revoked: %s)", revoked => {
  const f = fixture();
  try {
    f.write(db => db.exec(`UPDATE sync_relay_shares SET selector_json='{"paths":["source"],"versionId":null}' WHERE share_id='share';
      UPDATE sync_relay_automation_presses SET collection_path='source' WHERE host_press_id='press';
      INSERT INTO sync_relay_shares (share_id,workspace_id,granter_user_id,selector_json,created_at_ms)
        VALUES ('target-share','workspace','owner','{"paths":["docs"],"versionId":null}',0);
      INSERT INTO sync_relay_share_grants
        (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
        VALUES ('target-grant','target-share','user','reader',NULL,'view',1,'active',0,NULL,NULL);`));
    if (revoked) f.write(db => db.exec("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2 WHERE grant_id='target-grant'"));
    expect(f.storage.commitLiveUpdateJournal(f.input).result).toEqual({kind: "refused", reason: "authority-refused"});
  } finally {f.close();}
});

it.each(["done", "ended", "failed"])("admits delayed writes after an accepted press settles as %s", outcome => {
  const f = fixture();
  try {
    f.write(db => db.prepare("UPDATE sync_relay_automation_presses SET state='settled',accepted_by=NULL,outcome=? WHERE host_press_id='press'").run(outcome));
    expect(f.storage.commitLiveUpdateJournal(f.input).result).toMatchObject({kind: "accepted"});
  } finally {f.close();}
});
it.each([false, true])("refuses a settled press that was never accepted or whose presser was revoked (revoked: %s)", revoked => {
  const f = fixture();
  try {
    f.write(db => db.exec("UPDATE sync_relay_automation_presses SET state='settled',accepted_by=NULL,outcome='failed' WHERE host_press_id='press'"));
    f.write(db => db.exec(revoked ? "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2 WHERE grant_id='grant'"
      : "UPDATE sync_relay_automation_presses SET accepted_generation=NULL WHERE host_press_id='press'"));
    expect(f.storage.commitLiveUpdateJournal(f.input).result).toEqual({kind: "refused", reason: "authority-refused"});
  } finally {f.close();}
});
it.each([false, true])("rechecks a chained recipient write's original grant (revoked: %s)", revoked => {
  const f = fixture();
  try {
    const {trustedAutomationPress: _press, ...input} = f.input;
    const chained = {...input, trustedAutomation: {...declaration, automationId: "collection:Tasks#chained"}, trustedAutomationGrant: {grantId: "grant", grantGeneration: 4}};
    if (revoked) f.write(db => db.exec("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2 WHERE grant_id='grant'"));
    expect(f.storage.commitLiveUpdateJournal(chained).result).toMatchObject(revoked ? {kind: "refused", reason: "authority-refused"} : {kind: "accepted"});
  } finally {f.close();}
});
it("refuses an unbound recipient automation at the journal even if delivery bypasses its claim check", () => {
  const f = fixture();
  try {
    const {trustedAutomationPress: _press, ...input} = f.input;
    expect(f.storage.commitLiveUpdateJournal(input).result).toEqual({kind: "refused", reason: "authority-refused"});
  } finally {f.close();}
});

it("uses the original share for ordinary record updates and new record paths too", () => {
  const f = fixture();
  try {
    for (const authority of [{hostPressId: "press", automationId: declaration.automationId}, {grantId: "grant", grantGeneration: 4}]) {
      const target = {workspaceId: "workspace", ownerUserId: "owner", declaration, authority};
      expect(f.storage.automationRecordWriteAllowed({...target, currentPath: "docs/new.md"})).toBe(true);
      expect(f.storage.automationRecordWriteAllowed({...target, currentPath: "private/new.md"})).toBe(false);
      f.write(db => db.exec("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2 WHERE grant_id='grant'"));
      expect(f.storage.automationRecordWriteAllowed({...target, currentPath: "docs/new.md"})).toBe(false);
      f.write(db => db.exec("UPDATE sync_relay_share_grants SET status='active',revoked_at_ms=NULL WHERE grant_id='grant'"));
    }
  } finally {f.close();}
});

it.each([false, true])("checks a Button ancestor for a different automation's chained write (revoked: %s)", revoked => {
  const f = fixture();
  try {
    if (revoked) f.write(db => db.exec("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=2 WHERE grant_id='grant'"));
    const input = {...f.input, trustedAutomation: {...declaration, automationId: "collection:Tasks#date"}};
    expect(f.storage.commitLiveUpdateJournal(input).result).toMatchObject(revoked ? {kind: "refused", reason: "authority-refused"} : {kind: "accepted"});
  } finally {f.close();}
});
it("refuses a Button binding to the wrong originating automation", () => {
  const f = fixture();
  try {
    expect(f.storage.commitLiveUpdateJournal({...f.input, trustedAutomationPress: {hostPressId: "press", automationId: "wrong"}}).result)
      .toEqual({kind: "refused", reason: "authority-refused"});
  } finally {f.close();}
});
