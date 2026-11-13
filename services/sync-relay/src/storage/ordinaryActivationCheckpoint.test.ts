import {createHash} from "node:crypto";
import {afterAll, expect, it} from "vitest";
import {closeTestStorage, closeTestStorages, reopenTestStorage, storagePath, testStorage} from "../testing";
import type {StorageContext} from "./context";
import {checkpointPolicySha256, readOrdinaryCheckpoint, replaceOrdinaryCheckpoint, type OrdinaryCheckpoint, type OrdinaryCheckpointScope} from "./ordinaryActivationCheckpoint";

afterAll(closeTestStorages);
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const document = {workspaceId: "workspace", mainVersionId: "main" as const, objectId: "object", lineageClaimId: sha256("base")};
const scope: OrdinaryCheckpointScope = {namespace: "relay", document, replicationEpoch: "epoch", streamIdentity: "stream",
  base: {relaySeq: 1, originId: "typist", originSeq: 0}, policySha256: checkpointPolicySha256({maxStructVisits: 10, maxIndexOperations: 20})};
const checkpoint = (throughRelaySeq: number, text: string): OrdinaryCheckpoint => {
  const state = new TextEncoder().encode(text);
  return {throughRelaySeq, foldedEntries: throughRelaySeq, state, stateSha256: sha256(state), currentPath: "notes/a.md",
    projection: {projectedMarkdownSha256: sha256(`${text}.md`), projectedMarkdownByteLength: text.length},
    tail: [{relaySeq: throughRelaySeq, originId: "typist", originSeq: throughRelaySeq - 1, ordinary: true, projection: null}],
    moments: [{relaySeq: 2, operation: "write", projectedMarkdownSha256: sha256(""), projectedMarkdownByteLength: 0,
      write: {blobSha256: sha256("saved"), byteLength: 5, objectMoment: true}}], momentsFromSeq: throughRelaySeq, latestRename: null, latestWrite: null};
};

/** A workspace whose relay log holds `rows` rows, so the committed cursor is `rows`. */
async function relay(rows: number) {
  const storage = await testStorage(), context = storage as unknown as StorageContext;
  expect(storage.claimWorkspace({workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1})).toBe("created");
  const log = context.db.prepare("INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms) VALUES ('workspace','typist',?,'ydoc.update','{}',0)");
  for (let seq = 0; seq < rows; seq++) log.run(seq);
  const usage = () => Number(context.db.prepare("SELECT usage_bytes FROM sync_relay_workspace_usage WHERE workspace_id='workspace'").get()!.usage_bytes);
  const save = (expected: number | null, next: OrdinaryCheckpoint, at = scope) =>
    context.tx(() => replaceOrdinaryCheckpoint(context, {scope: at, expected, checkpoint: next, nowMs: 5}));
  const read = (at = scope) => readOrdinaryCheckpoint(context, at);
  /** Closes the relay database and reads the checkpoint through a new handle on the same file, as after a restart. */
  const reopened = () => {
    const path = storagePath(storage);
    closeTestStorage(storage);
    return readOrdinaryCheckpoint(reopenTestStorage(path) as unknown as StorageContext, scope);
  };
  return {context, usage, save, read, reopened};
}

it("a lineage keeps one checkpoint, advanced only from the position it was folded from", async () => {
  const r = await relay(10), before = r.usage();
  expect(r.read()).toBeNull();
  expect(r.save(null, checkpoint(4, "four"))).toBe(true);
  expect(r.read()).toEqual(checkpoint(4, "four"));
  const charged = r.usage() - before;
  expect(charged).toBeGreaterThan("four".length);
  // A fold that started before the saved one, or from the base, lost the race and saves nothing.
  expect(r.save(null, checkpoint(6, "six"))).toBe(false);
  expect(r.save(3, checkpoint(6, "six"))).toBe(false);
  // A fold must move forward.
  expect(r.save(4, checkpoint(4, "four again"))).toBe(false);
  expect(r.save(4, checkpoint(9, "nine longer"))).toBe(true);
  expect(r.read()).toEqual(checkpoint(9, "nine longer"));
  // The charge follows the one row the lineage keeps.
  expect(r.usage() - before).toBe(charged + "nine longer".length - "four".length);
  expect(r.context.db.prepare("SELECT COUNT(*) AS rows FROM sync_relay_ordinary_checkpoints").get()!.rows).toBe(1);
});

it("a checkpoint past the relay's committed cursor is not saved", async () => {
  const r = await relay(3);
  expect(r.save(null, checkpoint(4, "four"))).toBe(false);
  expect(r.read()).toBeNull();
});

it.each([
  ["another relay database", {namespace: "copied-relay"}],
  ["another replication epoch", {replicationEpoch: "epoch-2"}],
  ["another stream", {streamIdentity: "stream-2"}],
  ["another base", {base: {relaySeq: 2, originId: "typist", originSeq: 1}}],
  ["another validation policy", {policySha256: checkpointPolicySha256({maxStructVisits: 11, maxIndexOperations: 20})}],
] as const)("a checkpoint is not used under %s, and a fold from the base replaces it", async (_, change) => {
  const r = await relay(10), other = {...scope, ...change};
  expect(r.save(null, checkpoint(4, "four"))).toBe(true);
  expect(r.read(other)).toBeNull();
  expect(r.save(4, checkpoint(6, "six"), other)).toBe(false);
  expect(r.save(null, checkpoint(6, "six"), other)).toBe(true);
  expect(r.read(other)).toEqual(checkpoint(6, "six"));
  expect(r.read()).toBeNull();
});

it("another lineage of the same note never reads this one's checkpoint", async () => {
  const r = await relay(10);
  expect(r.save(null, checkpoint(4, "four"))).toBe(true);
  expect(r.read({...scope, document: {...document, lineageClaimId: sha256("other base")}})).toBeNull();
});

it("a checkpoint whose state no longer matches its digest is not used", async () => {
  const r = await relay(10);
  expect(r.save(null, checkpoint(4, "four"))).toBe(true);
  r.context.db.prepare("UPDATE sync_relay_ordinary_checkpoints SET state_bytes=?").run(new TextEncoder().encode("fore"));
  expect(r.read()).toBeNull();
});

it("a checkpoint keeps its latest rename and object write, or none since its base, across a restart, and is charged for them", async () => {
  const latest = {...checkpoint(9, "nine"), latestRename: 3, latestWrite: {relaySeq: 2, blobSha256: sha256("saved"), byteLength: 5}};
  const none = await relay(10), kept = await relay(10), charged = (r: typeof none, next: OrdinaryCheckpoint) => {
    const before = r.usage();
    expect(r.save(null, next)).toBe(true);
    return r.usage() - before;
  };
  // The kept write's digest is the only stored text the two differ by.
  expect(charged(kept, latest) - charged(none, checkpoint(9, "nine"))).toBe(JSON.stringify(sha256("saved")).length - JSON.stringify(null).length);
  expect(none.reopened()).toEqual(checkpoint(9, "nine"));
  expect(kept.reopened()).toEqual(latest);
});

it.each([
  ["a rename at the base", {latestRename: 1}],
  ["a rename past the checkpoint", {latestRename: 10}],
  ["a write past the checkpoint", {latestWrite: {relaySeq: 10, blobSha256: sha256("saved"), byteLength: 5}}],
  ["a write without its digest", {latestWrite: {relaySeq: 2, blobSha256: null, byteLength: 5}}],
] as const)("a checkpoint naming %s is not saved", async (_, change) => {
  const r = await relay(10);
  expect(() => r.save(null, {...checkpoint(9, "nine"), ...change} as unknown as OrdinaryCheckpoint)).toThrow("CHECK constraint failed");
  expect(r.read()).toBeNull();
});
