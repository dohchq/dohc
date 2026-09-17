import { afterEach, expect, it } from "vitest";
import { closeTestStorages, testStorage } from "../testing";
import type { StorageContext } from "./context";
import { blobLogPayloadChunks, currentBlobLogSequence, removeBlobLogReferences } from "./blobLogRoots";

afterEach(closeTestStorages);

const hash = "0123456789abcdef".repeat(4);
const hashes = [hash, "f".repeat(64), "a".repeat(64), `a${hash.slice(0, 63)}`, `${hash.slice(1)}b`];

it("matches SQLite LIKE directly across generated raw text and canonical candidate sets", async () => {
  const db = (await testStorage() as StorageContext).db;
  const oracle = db.prepare("SELECT ? LIKE '%' || ? || '%' AS matched");
  const payloads: (string | null)[] = [null, "", hash, hash.toUpperCase(), `a${hash}b`, "a".repeat(512),
    JSON.stringify({[hash]: "opaque key"}), `before${hash}after`, `{}\0${hash}`, `${hash}\0later`,
    JSON.stringify({value: hash.slice(0, 32) + "\\u0038" + hash.slice(33)}),
    "🧬".repeat(32_750) + hash, "z".repeat(32_740) + hash, "z".repeat(250_000) + hash,
    hash.replaceAll("a", "Ａ"), hash.slice(0, 63)];
  let seed = 178_423;
  const next = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed; };
  const tokens = ["", "\0", "é", "🧬", "\\u0000", "0123456789ABCDEF", "xyz", ...hashes, ...hashes.map(value => value.toUpperCase())];
  for (let index = 0; index < 256; index++) {
    let payload = "";
    for (let part = 0; part < 16; part++) payload += tokens[next() % tokens.length];
    payloads.push(payload);
  }
  for (const payload of payloads) {
    const expected = hashes.filter(sha => oracle.get(payload, sha)?.matched !== 1);
    const remaining = new Set(hashes);
    const removed = removeBlobLogReferences(remaining, payload);
    expect([...remaining], `raw payload ${JSON.stringify(payload)?.slice(0, 100)}`).toEqual(expected);
    expect(removed).toBe(hashes.length - expected.length);
  }
});

it("matches the raw SQL oracle through bounded payload pieces and every stored sequence", async () => {
  const storage = await testStorage();
  storage.claimWorkspace({workspaceId: "w", ownerUserId: "owner", createdAtMs: 1});
  const db = (storage as StorageContext).db;
  const insert = db.prepare(`INSERT INTO sync_relay_log
    (workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms, relay_seq)
    VALUES ('w', 'origin', ?, 'opaque.kind', ?, 1, ?)`);
  const rows = [
    JSON.stringify({value: "z".repeat(32_740) + hash.toUpperCase()}),
    JSON.stringify({value: "🧬".repeat(32_750) + "a".repeat(64)}),
    `{}\0${"f".repeat(64)}`,
    JSON.stringify({value: `a${hash}b`}),
  ];
  rows.forEach((payload, index) => insert.run(index, payload, index - 2));
  const remaining = new Set(hashes);
  let largest = 0;
  for (const payload of blobLogPayloadChunks(db, "w", currentBlobLogSequence(db, "w"))) {
    largest = Math.max(largest, payload.length);
    removeBlobLogReferences(remaining, payload);
  }
  const oracle = db.prepare("SELECT 1 FROM sync_relay_log WHERE workspace_id='w' AND payload_json LIKE '%' || ? || '%' LIMIT 1");
  expect([...remaining]).toEqual(hashes.filter(sha => oracle.get(sha) === undefined));
  expect(largest).toBeLessThanOrEqual(2 * 32_768 + 63);
});

it("rejects invalid payload values before they can grant deletion authority", () => {
  for (const payload of [undefined, 0, {}, Buffer.from(hash)]) {
    const remaining = new Set([hash]);
    expect(() => removeBlobLogReferences(remaining, payload as unknown as string)).toThrow(/must be text/);
    expect([...remaining]).toEqual([hash]);
  }
});
