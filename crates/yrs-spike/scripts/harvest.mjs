// Harvest real Y.Doc fixtures from a COPY of a dogfood engine.db.
//
// SAFETY: this script must only ever be pointed at a COPY (engine.db +
// -wal/-shm copied together); it refuses paths that RESOLVE (symlinks,
// junctions, 8.3 short names) to a live workspace layout
// (.dohc/engine/engine.db) and opens read-only regardless. Harvested
// fixtures can contain personal content: they land in
// crates/yrs-spike/fixtures/harvested/, which is gitignored — they stay
// LOCAL and are never committed.
//
// Usage: node harvest.mjs <path-to-copied-engine.db>
// Requires Node >= 22.13 for node:sqlite. The repo's engines range is now
// >=24.14.0, which subsumes that floor; it used to allow Node 20, which cannot
// run this script at all.

import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  console.error(`node:sqlite unavailable — this script requires Node >= 22.13 (running ${process.version}).`);
  process.exit(1);
}

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("usage: node harvest.mjs <path-to-COPIED-engine.db>  (Node >= 22.13)");
  process.exit(1);
}
// realpathSync.NATIVE first: the live-DB refusal must see through symlinks,
// junctions, AND Windows 8.3 short-name aliases (DOHC~1). The JS
// implementation (fs.realpathSync) resolves links but does NOT expand 8.3
// aliases; only the native GetFinalPathNameByHandle path does.
let realPath;
try {
  realPath = realpathSync.native(resolve(dbPath));
} catch (error) {
  console.error(`cannot resolve ${dbPath}: ${error.message}`);
  process.exit(1);
}
if (/[\\/]\.dohc[\\/]engine[\\/]engine\.db$/i.test(realPath)) {
  console.error(
    "refusing: this resolves to a LIVE workspace engine.db; harvest only from a copy.",
  );
  process.exit(1);
}

// Validate the source BEFORE touching the existing fixture corpus: a typo or
// corrupt copy must not destroy the previous harvested fixtures. Stage into a
// temp sibling dir and swap in only after a fully successful harvest.
const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const outDir = join(fixturesRoot, "harvested");
mkdirSync(fixturesRoot, { recursive: true });
const stageDir = mkdtempSync(join(fixturesRoot, "harvest-stage-"));

const db = new DatabaseSync(realPath, { readOnly: true });
try {
  const integrity = db.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") {
    throw new Error(`integrity_check failed: ${JSON.stringify(integrity)}`);
  }

  const blob = db.prepare("SELECT content FROM binary_blobs WHERE sha256 = ?");
  function readBlob(sha) {
    const row = blob.get(sha);
    if (!row) throw new Error(`missing blob ${sha}`);
    return row.content;
  }

  const docs = db
    .prepare(
      "SELECT workspace_id, version_id, object_id, content_kind FROM ydoc_docs ORDER BY object_id",
    )
    .all();

  const manifest = [];
  let n = 0;
  for (const doc of docs) {
    n += 1;
    const name = `doc-${String(n).padStart(2, "0")}`;
    const dir = join(stageDir, name);
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

  writeFileSync(join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Success: swap the staged corpus in over the previous one.
  rmSync(outDir, { recursive: true, force: true });
  renameSync(stageDir, outDir);
  console.log(`harvested ${manifest.length} docs into ${outDir} (LOCAL ONLY — gitignored)`);
} catch (error) {
  rmSync(stageDir, { recursive: true, force: true });
  console.error(`harvest failed (existing fixtures untouched): ${error.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
