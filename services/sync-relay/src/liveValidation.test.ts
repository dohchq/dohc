import { createRequire } from "node:module";
import { afterEach, expect, it } from "vitest";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { createLiveValidationExecutor } from "./liveValidation.js";

import {registered, cleanupLiveDeliveryFixtures} from '../../../packages/ydoc-projection/src/liveCommittedDeliveryTestSupport.js';
const {encodeStateAsUpdate} = createRequire(new URL("../../../packages/ydoc-projection/package.json", import.meta.url))("yjs") as {
  encodeStateAsUpdate(doc: ReturnType<typeof markdownToYDoc>): Uint8Array;
};
const policy = {maxStructVisits: 1_000_000, maxValueNodeVisits: 5_000_000, maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000, maxDeleteClientGroupVisits: 1_000_000, maxDeleteIntervalVisits: 1_000_000, maxIndexOperations: 10_000_000};
const pools: ReturnType<typeof createLiveValidationExecutor>[] = [];
afterEach(async () => {await Promise.all(pools.splice(0).map(pool => pool.close())); cleanupLiveDeliveryFixtures();});
function fixture() {
  const pool = createLiveValidationExecutor(); pools.push(pool);
  const doc = markdownToYDoc("A **shared** document");
  const checkpoint = encodeStateAsUpdate(doc); doc.destroy();
  const input = {document: {workspaceId: "workspace", mainVersionId: "main", objectId: "object", lineageClaimId: "lineage"},
    currentPath: "note.md", checkpoint, suffix: [], candidate: Uint8Array.of(0, 0)};
  return {pool, input, validate: pool.validator(policy)};
}
it("runs the same validator without detaching input", async () => {
  const {input, validate} = fixture(), expected = createLiveMarkdownJournalValidator(policy)(input);
  expect(expected.kind).toBe("accepted");
  const original = input.checkpoint.slice();
  const pending = validate(input);
  if (expected.kind !== "accepted") throw Error("Expected accepted validation");
  const {stateUpdate: _stateUpdate, ...evidence} = expected.evidence;
  expect(await pending).toEqual({kind: "accepted", evidence}); expect(input.checkpoint).toEqual(original);
  expect(await validate({...input, candidate: Uint8Array.of(255)})).toEqual(createLiveMarkdownJournalValidator(policy)({...input, candidate: Uint8Array.of(255)}));
});
it.each([4093, 4094])("returns state bytes only when %s retained updates reach the checkpoint count", async suffixCount => {
  const {input, validate} = fixture();
  const call = {...input, suffix: Array.from({length: suffixCount}, () => Uint8Array.of(0, 0))};
  const expected = createLiveMarkdownJournalValidator(policy)(call);
  const result = await validate(call);
  expect(expected.kind).toBe("accepted");
  if (expected.kind !== "accepted") throw Error("Expected accepted validation");
  if (suffixCount === 4094) expect(result).toEqual(expected);
  else {
    const {stateUpdate: _stateUpdate, ...evidence} = expected.evidence;
    expect(result).toEqual({kind: "accepted", evidence});
  }
}, 30_000);

it.each([18, 19])("returns checkpoint state only when %s large suffix updates and the candidate reach the byte limit", async suffixCount => {
  const {pool, input} = fixture();
  const doc = markdownToYDoc("Byte checkpoint");
  try {
    doc.getMap("frontmatter").set("payload", "x".repeat(1_048_576));
    const bytes = encodeStateAsUpdate(doc);
    const call = {...input, checkpoint: bytes, suffix: Array.from({length: suffixCount}, () => bytes), candidate: bytes};
    expect(bytes.byteLength * 19).toBeLessThan(20_971_520);
    expect(bytes.byteLength * 20).toBeGreaterThanOrEqual(20_971_520);
    const bytePolicy = {...policy, maxDecodedPayloadByteVisits: 1_000_000_000};
    const expected = createLiveMarkdownJournalValidator(bytePolicy)(call);
    expect(expected.kind).toBe("accepted");
    const result = await pool.validator(bytePolicy)(call);
    if (expected.kind !== "accepted") throw Error("Expected accepted validation");
    if (suffixCount === 19) expect(result).toEqual(expected);
    else {
      const {stateUpdate: _stateUpdate, ...evidence} = expected.evidence;
      expect(result).toEqual({kind: "accepted", evidence});
    }
  } finally {doc.destroy();}
}, 30_000);
it("bounds concurrent work, cancels active jobs, and closes without dangling requests", async () => {
  const {pool, input, validate} = fixture(), abort = new AbortController();
  const first = Promise.resolve(validate(input, abort.signal));
  const rejected = expect(first).rejects.toThrow("cancelled");
  const second = Promise.resolve(validate(input));
  const busy = await validate(input);
  expect(busy).toMatchObject({kind: "retry", reason: "admission-unavailable"});
  if (busy.kind !== "retry") throw Error("Expected busy pool");
  let ready = false;
  const available = busy.waitForCapacity().then(() => {ready = true;});
  const cancelled = new AbortController();
  const cancelWait = expect(busy.waitForCapacity(cancelled.signal)).rejects.toThrow("stop waiting");
  cancelled.abort(new Error("stop waiting")); await cancelWait;
  expect(ready).toBe(false);
  abort.abort(new Error("cancelled")); await rejected;
  await available;
  expect((await second).kind).toBe("accepted");
  const active = Promise.resolve(validate(input)); const closing = expect(active).rejects.toThrow("exited");
  await pool.close(); await closing;
  await expect(validate(input)).rejects.toThrow("closed");
});

it.each([false, true])('commits and recovers worker evidence with checkpoint due=%s', async checkpointDue => {
  const f = registered({deployment: true}), pool = createLiveValidationExecutor();
  try {
    const template = f.capture(f.update('payload', checkpointDue ? 'x'.repeat(1_048_576) : 'small'));
    const validate = pool.validator({...policy, maxDecodedPayloadByteVisits: 1_000_000_000});
    for (let index = 0; index < (checkpointDue ? 20 : 1); index++) {
      const read = f.storage.readLiveUpdateJournalCut({document: template.cutToken.document});
      if (read.kind !== 'cut') throw Error('Expected journal cut');
      const input = {...template, metadata: {...template.metadata, deliveryId: 'worker-' + index}, cutToken: read.cut};
      const validation = await validate({document: read.cut.document, currentPath: read.cut.currentPath,
        checkpoint: read.cut.checkpoint.bytes, suffix: read.cut.suffix.map(row => row.bytes), candidate: input.updateBytes});
      if (validation.kind !== 'accepted') throw Error('Expected accepted worker evidence');
      const due = checkpointDue && index === 19;
      expect(Object.hasOwn(validation.evidence, 'stateUpdate')).toBe(due);
      const accepted = f.storage.commitLiveUpdateJournal({...input, validation});
      expect(accepted.result).toMatchObject({kind: 'accepted', replayed: false});
      if (index !== (checkpointDue ? 19 : 0)) continue;
      const before = f.raw.prepare('SELECT update_digest,validation_checkpoint_sha256,validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?').get(index + 1)!;
      expect(before.validation_checkpoint_bytes).toEqual(due ? validation.evidence.stateUpdate : null);
      expect(before.validation_checkpoint_sha256).toBe(due ? validation.evidence.stateUpdateSha256 : null);
      expect(f.storage.commitLiveUpdateJournal({...input, validation}).result).toMatchObject({kind: 'accepted', replayed: true});
      expect(f.raw.prepare('SELECT update_digest,validation_checkpoint_sha256,validation_checkpoint_bytes FROM sync_relay_live_update_journal WHERE journal_cursor=?').get(index + 1)).toEqual(before);
      expect(f.storage.readCommittedLiveUpdate({host: input.host, document: input.cutToken.document, journalCursor: index + 1}))
        .toEqual({kind: 'committed', admitted: accepted.admitted});
    }
  } finally {await pool.close(); f.close();}
}, 30_000);
