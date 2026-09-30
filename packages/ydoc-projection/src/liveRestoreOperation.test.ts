import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import * as Y from "yjs";
import { registered, host, DatabaseSync, cleanupLiveDeliveryFixtures } from "./liveCommittedDeliveryTestSupport.js";
import { openRelayDeployment } from "../../../services/sync-relay/src/relayDeployment.js";
import type { StorageContext } from "../../../services/sync-relay/src/storage/context.js";
import { beginStopRestore, advanceStopRestoreFence, readStopRestore, type StopRestoreIntent } from "../../../services/sync-relay/src/storage/liveRestoreOperation.js";
import { attachLiveJournalHistory, createLiveJournalHistoryAuthority } from "../../../services/sync-relay/src/storage/liveJournalHistory.js";
import { initializeLiveRestoreOperationSchema } from "../../../services/sync-relay/src/storage/liveRestoreOperationSchema.js";
import { buildRelayFixture } from "../../../services/sync-relay/scripts/build.mjs";

afterEach(cleanupLiveDeliveryFixtures);
const named = { kind: "named", userId: "reader", grantId: "grant" } as const;
function fixture(deployment = false, workspaceQuotaBytes?: number) {
  const f = registered({ deployment, workspaceQuotaBytes });
  const context = f.storage as StorageContext;
  if (!deployment) attachLiveJournalHistory(context,createLiveJournalHistoryAuthority({namespace: "restore-history",reconciled: true}));
  const intent: StopRestoreIntent = { deliveryKind: "bootstrap", operationId: "restore", ownerUserId: "owner", document: f.input.evidence.document,
    shareId: "share", grantId: "grant", expectedGrantGeneration: 4, expectedDependentGrantIds: [], expectedFence: 1,
    restorePointCursor: 0, restorePointReceiptDigest: f.input.evidence.checkpoint.updateDigest };
  const lookup = { operationId: intent.operationId, workspaceId: "workspace", ownerUserId: "owner" };
  const rows = () => ({ ...f.journalRows(), ...f.rows(),
    operations: f.raw.prepare("SELECT * FROM sync_relay_live_restore_operations").all(),
    grants: f.raw.prepare("SELECT * FROM sync_relay_share_grants ORDER BY grant_id").all(),
    credentials: f.raw.prepare("SELECT * FROM sync_relay_link_credentials").all() });
  return { ...f, context, intent, lookup, rows };
}

it.each(["view", "comment"])("refuses a non-edit target grant (%s) without stopping editors", access => {
  const f = fixture();
  try {
    f.write(db => { db.prepare("UPDATE sync_relay_share_grants SET access=? WHERE grant_id='grant'").run(access); });
    const before = f.rows();
    expect(() => beginStopRestore(f.context, f.intent, 40)).toThrow();
    expect(f.rows()).toEqual(before);
  } finally { f.close(); }
});

it.each(["begin", "fence"])("requires reconciled journal history before %s", phase => {
  const f = registered();
  try {
    const context = f.storage as StorageContext;
    const intent: StopRestoreIntent = {deliveryKind: "bootstrap",operationId: "restore",ownerUserId: "owner",document: f.input.evidence.document,
      shareId: "share",grantId: "grant",expectedGrantGeneration: 4,expectedDependentGrantIds: [],expectedFence: 1,restorePointCursor: 0,restorePointReceiptDigest: f.input.evidence.checkpoint.updateDigest};
    const lookup = {operationId: "restore",workspaceId: "workspace",ownerUserId: "owner"};
    const history = createLiveJournalHistoryAuthority({ namespace: "restore-history", reconciled: true });
    attachLiveJournalHistory(context, history);
    if (phase === "fence") beginStopRestore(context, intent, 40);
    history.markUnreconciled();
    const before = f.rows();
    expect(() => phase === "begin" ? beginStopRestore(context, intent, 40) : advanceStopRestoreFence(context, lookup, 50)).toThrow(/reconciliation/);
    expect(f.rows()).toEqual(before);
  } finally { f.close(); }
});

it("does not disclose whether another workspace has an operation ID", () => {
  const f = fixture();
  try {
    f.write(db => { db.prepare("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES('other','other-owner',0)").run(); });
    beginStopRestore(f.context, f.intent, 40);
    const lookup = { operationId: "restore", workspaceId: "other", ownerUserId: "other-owner" };
    expect(readStopRestore(f.context, lookup)).toBeNull();
    expect(readStopRestore(f.context, { ...lookup, operationId: "unused" })).toBeNull();
  } finally { f.close(); }
});

it.each([false, true])("refuses a foreign operation ID before grant mutation, trap=%s", trap => {
  const f = fixture(), foreign = fixture();
  try {
    beginStopRestore(foreign.context, foreign.intent, 40);
    f.write(db => {
      db.prepare("INSERT INTO sync_relay_workspaces(workspace_id,owner_user_id,created_at_ms) VALUES('other','other-owner',0)").run();
      const document = { ...foreign.rows().documents[0]!, workspace_id: "other" };
      const operation = { ...foreign.rows().operations[0]!, workspace_id: "other", intent_json: JSON.stringify({
        ...foreign.intent, ownerUserId: "other-owner", document: { ...foreign.intent.document, workspaceId: "other" },
      }) };
      for (const [table, row] of [["sync_relay_live_documents", document], ["sync_relay_live_restore_operations", operation]] as const) {
        db.prepare(`INSERT INTO ${table}(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
          .run(...Object.values(row));
      }
      if (trap) db.exec("CREATE TRIGGER trap_restore_revocation BEFORE UPDATE ON sync_relay_share_grants BEGIN SELECT RAISE(ABORT, 'Unexpected grant mutation'); END");
    });
    const before = f.rows();
    expect(() => beginStopRestore(f.context, f.intent, 50)).toThrow("Live restore operation conflicts with current authority.");
    expect(f.rows()).toEqual(before);
    expect(f.storage.getShareGrant("grant")).toMatchObject({ status: "active", generation: 4 });
  } finally { f.close(); foreign.close(); }
});

it("rolls back the document fence when its operation update is ignored", () => {
  const f = fixture();
  try {
    beginStopRestore(f.context, f.intent, 40);
    f.write(db => { db.exec("CREATE TRIGGER ignore_restore BEFORE UPDATE ON sync_relay_live_restore_operations BEGIN SELECT RAISE(IGNORE); END"); });
    const before = f.rows();
    expect(() => advanceStopRestoreFence(f.context, f.lookup, 50)).toThrow();
    expect(f.rows()).toEqual(before);
    f.write(db => { db.exec("DROP TRIGGER ignore_restore"); });
    expect(advanceStopRestoreFence(f.context, f.lookup, 50).phase).toBe("fenced");
  } finally { f.close(); }
});

it.each(["index", "parent"])("refuses damaged restore schema %s on initialization", damage => {
  const f = fixture();
  try {
    beginStopRestore(f.context, f.intent, 40);
    if (damage === "index") f.raw.exec("CREATE INDEX unexpected_restore ON sync_relay_live_restore_operations(phase)");
    else {
      f.raw.exec("PRAGMA foreign_keys=OFF");
      f.raw.exec("UPDATE sync_relay_live_restore_operations SET workspace_id='missing'");
      f.raw.exec("PRAGMA foreign_keys=ON");
    }
    expect(() => initializeLiveRestoreOperationSchema(f.context.db)).toThrow(/damaged/);
  } finally { f.close(); }
});

it.each([false, true])("revokes before fencing and resumes each phase exactly once, deployment=%s", deployment => {
  const f = fixture(deployment);
  const ownerDoc = new Y.Doc();
  Y.applyUpdate(ownerDoc, f.input.baselineBytes);
  try {
    const buffered = f.capture(f.update(), "buffered", named);
    const before = f.rows();
    const invalidated = beginStopRestore(f.context, f.intent, 40);
    expect(invalidated).toMatchObject({ phase: "authority-invalidated", revokedGeneration: 5, oldFence: 1, newFence: null });
    expect(f.storage.getShareGrant("grant")).toMatchObject({ status: "revoked", generation: 5 });
    const invalidatedRows = f.rows();
    expect(invalidatedRows.journal).toEqual(before.journal);
    expect(invalidatedRows.documents[0]).toMatchObject({ admission_state: "open", restore_fence_generation: 1 });
    expect(beginStopRestore(f.context, f.intent, 41)).toEqual(invalidated);
    expect(f.rows()).toEqual(invalidatedRows);
    expect(f.storage.commitLiveUpdateJournal(buffered).result.kind).toBe("refused");
    expect(f.storage.resolveCurrentLiveDocumentBinding({ document: f.intent.document, actor: named }).kind).toBe("refused");
    const ownerBefore = Y.encodeStateVector(ownerDoc);
    ownerDoc.getMap("frontmatter").set("owner", "before fence");
    const ownerUpdate = f.capture(Y.encodeStateAsUpdate(ownerDoc, ownerBefore), "owner-before");
    const accepted = f.storage.commitLiveUpdateJournal(ownerUpdate);
    expect(accepted.result.kind).toBe("accepted");
    const ownerAfter = Y.encodeStateVector(ownerDoc);
    ownerDoc.getMap("frontmatter").set("later", "after fence");
    const late = f.capture(Y.encodeStateAsUpdate(ownerDoc, ownerAfter), "owner-after");
    const beforeFence = f.rows();
    const fenced = advanceStopRestoreFence(f.context, f.lookup, 50);
    expect(fenced).toMatchObject({ phase: "fenced", oldFence: 1, newFence: 2, cutoverCursor: 1 });
    expect(f.rows().documents[0]).toMatchObject({ admission_state: "closed", restore_fence_generation: 2 });
    const finalRows = f.rows();
    expect(finalRows.usage).toBe(beforeFence.usage);
    expect(f.storage.commitLiveUpdateJournal(late).result.kind).toBe("refused");
    expect(advanceStopRestoreFence(f.context, f.lookup, 51)).toEqual(fenced);
    expect(beginStopRestore(f.context, f.intent, 52)).toEqual(fenced);
    expect(readStopRestore(f.context, f.lookup)).toEqual(fenced);
    expect(f.rows()).toEqual(finalRows);
  } finally { ownerDoc.destroy(); f.close(); }
});

it("retains an exact nonbaseline restore receipt and rejects another digest or cursor", () => {
  const f = fixture();
  try {
    const input = f.capture(f.update(), "restore-point");
    const result = f.storage.commitLiveUpdateJournal(input).result;
    if (result.kind !== "accepted") throw new Error("Expected restore point.");
    const intent = { ...f.intent, restorePointCursor: result.receipt.journalCursor, restorePointReceiptDigest: input.metadata.updateDigest };
    const before = f.rows();
    for (const patch of [{ restorePointReceiptDigest: "0".repeat(64) }, { restorePointCursor: intent.restorePointCursor + 1 }]) {
      expect(() => beginStopRestore(f.context, { ...intent, ...patch }, 40)).toThrow();
      expect(f.rows()).toEqual(before);
    }
    expect(beginStopRestore(f.context, intent, 40).intent).toEqual(intent);
  } finally { f.close(); }
});

it.each([
  ["owner", { ownerUserId: "other" }], ["grant generation", { expectedGrantGeneration: 3 }],
  ["fence", { expectedFence: 2 }], ["restore digest", { restorePointReceiptDigest: "0".repeat(64) }],
  ["grant generation exhaustion", { expectedGrantGeneration: Number.MAX_SAFE_INTEGER }],
  ["fence exhaustion", { expectedFence: Number.MAX_SAFE_INTEGER }],
  ["negative cursor", { restorePointCursor: -1 }], ["unexpected dependents", { expectedDependentGrantIds: ["other"] }],
] as const)("refuses mismatched %s before mutation", (_name, patch) => {
  const f = fixture();
  try {
    const before = f.rows();
    expect(() => beginStopRestore(f.context, { ...f.intent, ...patch }, 40)).toThrow();
    expect(f.rows()).toEqual(before);
  } finally { f.close(); }
});

it.each(["foreign-workspace", "foreign-object", "stale-lineage", "closed", "moved-object", "foreign-selector", "version-selector", "fixed-main-selector", "alias-selector", "malformed-selector"])("refuses %s before revocation", change => {
  const f = fixture();
  try {
    const intent = structuredClone(f.intent);
    if (change === "foreign-workspace") intent.document = { ...intent.document, workspaceId: "other" };
    if (change === "foreign-object") intent.document = { ...intent.document, objectId: "other" };
    if (change === "stale-lineage") intent.document = { ...intent.document, lineageClaimId: "0".repeat(64) };
    if (change === "closed") f.write(db => { db.exec("UPDATE sync_relay_live_documents SET admission_state='closed'"); });
    if (change === "moved-object") f.moment(f.input, 2, { path: "elsewhere/a.md" });
    if (change.endsWith("selector")) f.write(db => {
      db.prepare("UPDATE sync_relay_shares SET selector_json=?").run(change === "malformed-selector" ? "{}" : JSON.stringify({
        paths: [change === "foreign-selector" ? "elsewhere" : change === "alias-selector" ? "docs/../docs" : "docs"],
        versionId: change === "version-selector" ? "other" : change === "fixed-main-selector" ? "main" : null }));
    });
    const before = f.rows();
    expect(() => beginStopRestore(f.context, intent, 40)).toThrow();
    expect(f.rows()).toEqual(before);
  } finally { f.close(); }
});

it("refuses conflicting operation identities and keeps independent revocation effective", () => {
  const f = fixture();
  try {
    beginStopRestore(f.context, f.intent, 40);
    const before = f.rows();
    for (const patch of [{ operationId: "another" }, { restorePointCursor: 1 }, { grantId: "other" }]) {
      expect(() => beginStopRestore(f.context, { ...f.intent, ...patch }, 40)).toThrow();
      expect(f.rows()).toEqual(before);
    }
    expect(() => readStopRestore(f.context, { ...f.lookup, ownerUserId: "other" })).toThrow();
    expect(() => advanceStopRestoreFence(f.context, { ...f.lookup, ownerUserId: "other" }, 50)).toThrow();
  } finally { f.close(); }
  const independent = fixture();
  try {
    const buffered = independent.capture(independent.update(), "buffered", named);
    expect(independent.storage.revokeShareGrant({ shareId: "share", grantId: "grant", revokedAtMs: 40 }).ok).toBe(true);
    expect(() => beginStopRestore(independent.context, independent.intent, 41)).toThrow();
    expect(independent.storage.commitLiveUpdateJournal(buffered).result.kind).toBe("refused");
    expect(independent.rows().operations).toHaveLength(0);
    expect(independent.rows().documents[0]).toMatchObject({ admission_state: "open", restore_fence_generation: 1 });
  } finally { independent.close(); }
});

it.each(["before-insert", "after-insert", "after-fence"])("rolls back every effect on %s failure", boundary => {
  const f = fixture(true);
  try {
    if (boundary === "after-fence") beginStopRestore(f.context, f.intent, 40);
    f.write(db => { db.exec(boundary === "after-fence"
      ? "CREATE TRIGGER reject_restore BEFORE UPDATE ON sync_relay_live_restore_operations BEGIN SELECT RAISE(ABORT,'injected restore failure'); END"
      : `CREATE TRIGGER reject_restore ${boundary === "before-insert" ? "BEFORE" : "AFTER"} INSERT ON sync_relay_live_restore_operations BEGIN SELECT RAISE(ABORT,'injected restore failure'); END`); });
    const before = f.rows();
    expect(() => boundary === "after-fence" ? advanceStopRestoreFence(f.context, f.lookup, 50) : beginStopRestore(f.context, f.intent, 40)).toThrow("injected restore failure");
    expect(f.rows()).toEqual(before);
    f.write(db => { db.exec("DROP TRIGGER reject_restore"); });
    if (boundary === "after-fence") expect(advanceStopRestoreFence(f.context, f.lookup, 50).newFence).toBe(2);
    else expect(beginStopRestore(f.context, f.intent, 40).revokedGeneration).toBe(5);
  } finally { f.close(); }
});

it("funds final metadata before revocation and never charges replay or fence advancement", () => {
  const f = fixture();
  try {
    f.context.options.workspaceQuotaBytes=100_000;
    f.write(db => { db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=99999").run(); });
    const before = f.rows();
    expect(() => beginStopRestore(f.context, f.intent, 40)).toThrow(/quota/);
    expect(f.rows()).toEqual(before);
    f.write(db => { db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=1000").run(); });
    beginStopRestore(f.context, f.intent, 40);
    const charge = Number(f.rows().operations[0]!.accounted_bytes);
    expect(f.rows().usage).toBe(1000 + charge);
    f.write(db => { db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=100000").run(); });
    expect(advanceStopRestoreFence(f.context, f.lookup, Number.MAX_SAFE_INTEGER).newFence).toBe(2);
    expect(f.rows().usage).toBe(100_000);
    expect(Buffer.byteLength(JSON.stringify(Object.values(f.rows().operations[0]!)))).toBeLessThanOrEqual(charge);
    expect(readStopRestore(f.context, f.lookup)).toEqual(beginStopRestore(f.context, f.intent, 50));
  } finally { f.close(); }
});

it("revokes a link, credential, and exact dependent set atomically with the operation", () => {
  const f = fixture(true);
  try {
    f.write(db => {
      db.exec("UPDATE sync_relay_share_grants SET principal_kind='link',principal_user_id=NULL WHERE grant_id='grant'");
      db.exec("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id) VALUES('dependent','share','user','reader',NULL,'edit',2,'active',0,NULL,'grant')");
      db.exec("INSERT INTO sync_relay_link_credentials VALUES('credential','grant','secret-hash',4,0,NULL)");
    });
    const intent = { ...f.intent, expectedDependentGrantIds: ["dependent"] };
    const before = f.rows();
    expect(() => beginStopRestore(f.context, f.intent, 40)).toThrow();
    expect(f.rows()).toEqual(before);
    f.write(db => { db.exec("CREATE TRIGGER reject_restore AFTER INSERT ON sync_relay_live_restore_operations BEGIN SELECT RAISE(ABORT,'rollback all revocations'); END"); });
    expect(() => beginStopRestore(f.context, intent, 40)).toThrow("rollback all revocations");
    expect(f.rows()).toEqual(before);
    f.write(db => { db.exec("DROP TRIGGER reject_restore"); });
    expect(beginStopRestore(f.context, intent, 40).revokedGeneration).toBe(5);
    expect(f.storage.getShareGrant("dependent")).toMatchObject({ generation: 3, status: "revoked", revokedAtMs: 40 });
    expect(f.rows().credentials).toMatchObject([{ retired_at_ms: 40 }]);
    const invalidated = f.rows();
    beginStopRestore(f.context, intent, 41);
    expect(f.rows()).toEqual(invalidated);
  } finally { f.close(); }
});

it("refuses a dependent generation overflow before invalidating the link", () => {
  const f = fixture();
  try {
    f.write(db => {
      db.exec("UPDATE sync_relay_share_grants SET principal_kind='link',principal_user_id=NULL WHERE grant_id='grant'");
      db.prepare("INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,access,generation,status,created_at_ms,parent_grant_id) VALUES('dependent','share','user','reader','edit',?,'active',0,'grant')").run(Number.MAX_SAFE_INTEGER);
    });
    const before = f.rows();
    expect(() => beginStopRestore(f.context, { ...f.intent, expectedDependentGrantIds: ["dependent"] }, 40)).toThrow();
    expect(f.rows()).toEqual(before);
  } finally { f.close(); }
});

it("keeps revocation and fence progress independent of an offline configured device", () => {
  const f = fixture(true);
  try {
    expect(f.storage.disconnectLiveHost({ ...host, updatedAtMs: 30, guard: f.storage.captureStanding() }).ok).toBe(true);
    const control = f.storage.getLiveHostControl();
    expect(beginStopRestore(f.context, f.intent, 40).phase).toBe("authority-invalidated");
    expect(readStopRestore(f.context, f.lookup)?.newFence).toBeNull();
    expect(f.storage.getShareGrant("grant")?.status).toBe("revoked");
    expect(advanceStopRestoreFence(f.context, f.lookup, 50).phase).toBe("fenced");
    expect(f.storage.getLiveHostControl()).toEqual(control);
  } finally { f.close(); }
});

it("refuses initial global cursor exhaustion before revocation", () => {
  const f = fixture();
  try {
    f.write(db => { db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('sync_relay_live_update_journal',?)").run(Number.MAX_SAFE_INTEGER); });
    const before = f.rows();
    expect(() => beginStopRestore(f.context, f.intent, 40)).toThrow();
    expect(f.rows()).toEqual(before);
  } finally { f.close(); }
});

it.each([false, true])("handles the final available global cursor without a partial fence, consumed=%s", consumed => {
  const f = fixture();
  try {
    f.write(db => { db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('sync_relay_live_update_journal',?)").run(Number.MAX_SAFE_INTEGER - 1); });
    expect(beginStopRestore(f.context, f.intent, 40).phase).toBe("authority-invalidated");
    if (consumed) {
      const accepted = f.storage.commitLiveUpdateJournal(f.capture(f.update(), "last-safe-cursor")).result;
      expect(accepted).toMatchObject({ kind: "accepted", receipt: { journalCursor: Number.MAX_SAFE_INTEGER } });
      const before = f.rows();
      expect(() => advanceStopRestoreFence(f.context, f.lookup, 50)).toThrow();
      expect(f.rows()).toEqual(before);
      expect(readStopRestore(f.context, f.lookup)?.phase).toBe("authority-invalidated");
    } else expect(advanceStopRestoreFence(f.context, f.lookup, 50)).toMatchObject({ phase: "fenced", cutoverCursor: 0 });
  } finally { f.close(); }
});

const crashFixture = fileURLToPath(new URL("../../../services/sync-relay/src/liveRestoreOperationCrash.fixture.ts", import.meta.url));
const tsx = pathToFileURL(createRequire(crashFixture).resolve("tsx")).href;
let buildDirectory: string;
let compiledCrashFixture: string;
beforeAll(async () => {
  const output = fileURLToPath(new URL("../../../services/sync-relay/.output", import.meta.url));
  mkdirSync(output, { recursive: true });
  buildDirectory = mkdtempSync(join(output, "restore-crash-"));
  compiledCrashFixture = join(buildDirectory, "restore-crash.js");
  await buildRelayFixture(crashFixture, compiledCrashFixture);
}, 30_000);
afterAll(() => {
  if (buildDirectory) rmSync(buildDirectory, { recursive: true, force: true });
});

function assertCrashRecovery(boundary: string, sourceEntry = false) {
  const f = fixture(true);
  const intentPath = join(dirname(f.configPath), "intent.json");
  writeFileSync(intentPath, JSON.stringify(f.intent));
  f.close();
  const entryArguments = sourceEntry ? ["--import", tsx, crashFixture] : [compiledCrashFixture];
  const child = spawnSync(process.execPath, [...entryArguments, f.configPath, intentPath, boundary],
    { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(boundary === "before-operation" ? 80 : boundary.endsWith("before-commit") ? 81 : 82);
  const raw = new DatabaseSync(f.path, { readOnly: true });
  try {
    const invalidated = boundary === "invalidation-after-commit" || boundary.startsWith("fence-") || boundary.startsWith("complete-") || boundary.startsWith("native-");
    const fenced = boundary === "fence-after-commit" || boundary.startsWith("complete-") || boundary.startsWith("native-");
    expect(raw.prepare("SELECT status,generation FROM sync_relay_share_grants WHERE grant_id='grant'").get()).toEqual({ status: invalidated ? "revoked" : "active", generation: invalidated ? 5 : 4 });
    expect(raw.prepare("SELECT admission_state,restore_fence_generation FROM sync_relay_live_documents").get()).toEqual({ admission_state: fenced ? "closed" : "open", restore_fence_generation: fenced ? 2 : 1 });
    expect(raw.prepare("SELECT phase FROM sync_relay_live_restore_operations").all()).toEqual(invalidated ? [{ phase: boundary === "native-after-commit" ? "native-fenced" : boundary.startsWith("native-") || boundary === "complete-after-commit" ? "old-cut-applied" : fenced ? "fenced" : "authority-invalidated" }] : []);
  } finally { raw.close(); }
  if (boundary.endsWith("before-commit")) expect(() => openRelayDeployment(f.configPath)).toThrow(/continuity/);
  else {
    const reopened = openRelayDeployment(f.configPath).storage as StorageContext;
    try {
      const initial = beginStopRestore(reopened, f.intent, 40);
      const final = advanceStopRestoreFence(reopened, f.lookup, 50);
      expect(final.newFence).toBe(2);
      expect(final.cutoverCursor).toBe(0);
      expect(advanceStopRestoreFence(reopened, f.lookup, 51)).toEqual(final);
      if (boundary === "fence-after-commit") expect(initial).toEqual(final);
    } finally { reopened.close(); }
  }
}

it.each(["before-operation", "invalidation-before-commit", "invalidation-after-commit", "fence-before-commit", "fence-after-commit", "complete-before-commit", "complete-after-commit", "native-before-commit", "native-after-commit"])("retains configured deployment state after process termination at %s", boundary => {
  assertCrashRecovery(boundary);
}, 30_000);

it("opens the configured deployment from the source crash fixture", () => {
  assertCrashRecovery("before-operation", true);
}, 30_000);
