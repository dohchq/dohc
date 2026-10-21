import {readFileSync} from "node:fs";
import * as Y from "yjs";
import {afterEach, expect, it} from "vitest";
import {fixture, bootstrapAck} from "./liveRestoreFixture.integration-helper.js";
import {policy, hash, cleanupLiveDeliveryFixtures} from "./liveCommittedDeliveryTestSupport.js";
import {beginStopRestore, advanceStopRestoreFence} from "../../../services/sync-relay/src/storage/liveRestoreOperation.js";
import {resolveLiveRestorePoint} from "./liveRestorePoint.js";
const vector = JSON.parse(readFileSync(new URL("../../../crates/dohc-engine-collab/tests/reader-resolver.json", import.meta.url), "utf8"));
const source = new TextEncoder().encode(vector.source);
afterEach(cleanupLiveDeliveryFixtures);
function readerFixture() {
  const doc=new Y.Doc({gc:false}); Y.applyUpdate(doc,Buffer.from(vector.checkpoint,"base64"));
  doc.getMap("meta").delete("dohcLineageEpoch");
  const checkpoint=Y.encodeStateAsUpdate(doc); doc.destroy();
  const f = fixture("bootstrap","device",checkpoint, digest => digest === hash(source) ? source : undefined);
  f.storage.putBlob({workspaceId:"workspace",sha256:hash(source),content:source,createdAtMs:1});
  return f;
}
it("finishes a saved fenced reader stop-restore on retry", () => {
  const f=readerFixture();
  try {
    const saved=f.fence(); expect(saved.phase).toBe("fenced");
    expect(beginStopRestore(f.context,f.intent,60)).toEqual(saved);
    expect(advanceStopRestoreFence(f.context,f.lookup,70)).toEqual(saved);
    const drain=f.open(), first=f.store.nextStopRestoreCut(drain);
    if(first.kind!=="bootstrap") throw Error(first.kind);
    f.store.acknowledgeStopRestoreBootstrap(drain,bootstrapAck(first.baseline));
    f.store.completeStopRestoreCut(drain); f.store.closeStopRestoreCut(drain);
    const operation=f.store.pendingStopRestoreFence(f.lookup).operation;
    f.store.acknowledgeStopRestoreFence(f.lookup,{operation,localHeadSequence:0,recordedAtMs:100});
    const capture=f.store.captureStopRestorePoint({...f.lookup,maxBytes:1_000_000,maxEvents:10});
    expect(resolveLiveRestorePoint(capture,policy).markdownDigest).toBe(hash(source));
    // The getter rechecks stored artifact authority even after an earlier successful proof.
    f.write(db => {db.prepare("UPDATE sync_relay_object_moments SET object_id='foreign'").run();});
    expect(() => resolveLiveRestorePoint(capture,policy)).toThrow();
  } finally {f.close();}
});

it("a restore source cannot borrow an artifact written for another object", () => {
  const f=readerFixture();
  const foreign=new TextEncoder().encode("foreign history artifact\n"),digest=hash(foreign);
  try {
    f.storage.putBlob({workspaceId:"workspace",sha256:digest,content:foreign,createdAtMs:2});
    f.write(db => db.prepare(`INSERT INTO sync_relay_object_moments
      (workspace_id,object_id,relay_seq,moment_id,version_id,path,blob_sha256,content_kind,byte_length,recorded_at_ms)
      VALUES ('workspace','foreign',0,'foreign',?,?,?,'text',?,2)`).run(f.input.evidence.document.mainVersionId,f.input.evidence.currentPath,digest,foreign.length));
    f.fence();
    const drain=f.open(),first=f.store.nextStopRestoreCut(drain);
    if(first.kind!=="bootstrap") throw Error(first.kind);
    f.store.acknowledgeStopRestoreBootstrap(drain,bootstrapAck(first.baseline));
    f.store.completeStopRestoreCut(drain);f.store.closeStopRestoreCut(drain);
    const operation=f.store.pendingStopRestoreFence(f.lookup).operation;
    f.store.acknowledgeStopRestoreFence(f.lookup,{operation,localHeadSequence:0,recordedAtMs:100});
    const capture=f.store.captureStopRestorePoint({...f.lookup,maxBytes:1_000_000,maxEvents:10});
    expect(capture.artifact(digest)).toBeUndefined();
    expect(capture.artifact(hash(source))).toEqual(source);
  } finally {f.close();}
});
