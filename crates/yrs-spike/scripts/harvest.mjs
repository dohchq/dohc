// Harvest real Y.Doc fixtures from a COPY of a dogfood engine.db.
//
// SAFETY: this script must only ever be pointed at a COPY (engine.db +
// -wal/-shm copied together); it refuses paths that look like a live
// workspace root (.dohc/engine/engine.db) and opens read-only regardless.
// Harvested fixtures can contain personal content: they land in
// crates/yrs-spike/fixtures/harvested/, which is gitignored — they stay
// LOCAL and are never committed.
//
// Usage: node harvest.mjs <path-to-copied-engine.db>

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: node harvest.mjs <path-to-COPIED-engine.db>");
  process.exit(1);
}
const normalized = resolve(dbPath).replaceAll("\\", "/");
if (/\/\.dohc\/engine\/engine\.db$/i.test(normalized)) {
  console.error(
    "refusing: this looks like a LIVE workspace engine.db; harvest only from a copy.",
  );
  process.exit(1);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "harvested");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const db = new DatabaseSync(resolve(dbPath), { readOnly: true });
const integrity = db.prepare("PRAGMA integrity_check").get();
if (integrity.integrity_check !== "ok") {
  console.error("integrity_check failed:", integrity);
  process.exit(1);
}

const blob = db.prepare("SELECT content FROM binary_blobs WHERE sha256 = ?");
function readBlob(sha) {
  const row = blob.get(sha);
  if (!row) throw new Error(`missing blob ${sha}`);
  return row.content;
}

const docs = db
  .prepare("SELECT workspace_id, version_id, object_id, content_kind FROM ydoc_docs ORDER BY object_id")
  .all();

const manifest = [];
let n = 0;
for (const doc of docs) {
  n += 1;
  const name = `doc-${String(n).padStart(2, "0")}`;
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const key = [doc.workspace_id, doc.version_id, doc.object_id];

  const snapshot = db
    .prepare(
      `SELECT up_to_seq, snapshot_blob_sha256 FROM ydoc_snapshots
        WHERE workspace_id = ? AND version_id = ? AND object_id = ?
        ORDER BY up_to_seq DESC LIMIT 1`,
    )
    .get(...key);
  let fromSeq = 0;
  const files = [];
  if (snapshot) {
    writeFileSync(join(dir, "snapshot.bin"), readBlob(snapshot.snapshot_blob_sha256));
    files.push("snapshot.bin");
    fromSeq = Number(snapshot.up_to_seq);
  }
  const updates = db
    .prepare(
      `SELECT seq, update_blob_sha256 FROM ydoc_updates
        WHERE workspace_id = ? AND version_id = ? AND object_id = ? AND seq > ?
        ORDER BY seq ASC`,
    )
    .all(...key, fromSeq);
  for (const u of updates) {
    const file = `update-${String(u.seq).padStart(4, "0")}.bin`;
    writeFileSync(join(dir, file), readBlob(u.update_blob_sha256));
    files.push(file);
  }
  manifest.push({
    name,
    contentKind: doc.content_kind === "plaintext" ? "plaintext" : "richdoc",
    files,
  });
  console.log(`${name}: kind=${doc.content_kind} snapshot=${!!snapshot} updates=${updates.length}`);
}

writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
db.close();
console.log(`harvested ${manifest.length} docs into ${outDir} (LOCAL ONLY — gitignored)`);
