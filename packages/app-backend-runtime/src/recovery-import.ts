import { createHash } from "node:crypto";
import { open, lstat, realpath, mkdtemp, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseDatasetRevision, parseDatasetBinding, type DatasetRevision } from "@dohc/security-contract/dataset";
import { verifyDatasetArtifacts } from "@dohc/security-contract/dataset-artifacts";
import { openPersistentAppBackend, type PersistentAppBackend, type PersistentRuntimeOptions } from "./persistent.js";
import type { DatasetCursor, JournalExportRecord } from "./journal.js";
import type { StagedDatasetRecovery } from "./recovery.js";
import { parseRecoveryJournalRecord, equalRecoveryCursor, recoveryObject, recoveryText, recoveryInteger, recoveryDigest, invalidRecovery as fail } from "./recovery-record.js";

export interface RecoveryBlob { path: string; offset: number; byteLength: number }
const validatedBlobs = new WeakMap<RecoveryBlob, { sha256: string; authorize(): void }>();
/** Only accepts blob references returned by successful validation; rechecks bytes while streaming. */
export async function* readValidatedBlob(blob: RecoveryBlob): AsyncGenerator<Uint8Array> {
  const capability = validatedBlobs.get(blob);
  if (!capability) fail("blob was not validated.");
  capability.authorize();
  const info = await lstat(blob.path);
  if (!info.isFile() || info.isSymbolicLink()) fail("validated blob path changed.");
  const handle = await open(blob.path, "r"), digest = createHash("sha256");
  try {
    for (let offset = 0; offset < blob.byteLength;) {
      capability.authorize(); const chunk = new Uint8Array(Math.min(CHUNK, blob.byteLength - offset));
      let written = 0;
      while (written < chunk.length) {
        const read = await handle.read(chunk, written, chunk.length - written, blob.offset + offset + written);
        if (!read.bytesRead) fail("validated blob was truncated."); written += read.bytesRead;
      }
      offset += chunk.length; digest.update(chunk); yield chunk;
    }
    capability.authorize(); if (digest.digest("hex") !== capability.sha256) fail("validated blob changed.");
  } finally { await handle.close(); }
}
export interface ValidatedRecoveryJournal { record: JournalExportRecord; blob: RecoveryBlob }
export interface RecoveryCatalog { revisionJson: string; artifactsJson: string }
export type RecoveryMetadata =
  | ({ kind: "catalog-revision" } & RecoveryCatalog)
  | { kind: "binding"; appId: string; bindingJson: string; token: string }
  | { kind: "grant"; principalKey: string; grantJson: string; token: string }
  | { kind: "attachment"; file: { fileId: string; name: string; contentType: string; byteLength: number; sha256: string; revision: number } };
export interface ValidatedDatasetRecovery {
  manifest: StagedDatasetRecovery["manifest"];
  catalog: RecoveryCatalog;
  checkpoint: ValidatedRecoveryJournal;
  records(): Iterable<ValidatedRecoveryJournal>;
  metadata(): Iterable<RecoveryMetadata>;
  /** Removes the private validation index and the original transport stage. */
  dispose(): Promise<void>;
}
export interface RecoveryValidationOptions {
  staged: StagedDatasetRecovery;
  authorize(): void;
  signal?: AbortSignal;
  runtime?: PersistentRuntimeOptions;
  compileOperations?(source: string, path: string): string | Promise<string>;
  maxEventBytes?: number;
  maxRecords?: number;
}
const MAX_META = 1024 * 1024, CHUNK = 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

async function readRange(blob: RecoveryBlob, maximum: number): Promise<Uint8Array> {
  if (blob.byteLength > maximum) return fail("record exceeds bounded read size.");
  const file = await open(blob.path, "r"), result = new Uint8Array(blob.byteLength);
  try { let offset = 0; while (offset < result.length) { const read = await file.read(result, offset, result.length - offset, blob.offset + offset); if (!read.bytesRead) return fail("truncated staged bytes."); offset += read.bytesRead; } }
  finally { await file.close(); }
  return result;
}
async function blobHash(blob: RecoveryBlob, authorize: () => void, output?: string): Promise<string> {
  const input = await open(blob.path, "r"), destination = output ? await open(output, "wx", 0o600) : undefined;
  const digest = createHash("sha256"), buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, blob.byteLength)));
  try {
    for (let offset = 0; offset < blob.byteLength;) {
      authorize(); const read = await input.read(buffer, 0, Math.min(buffer.length, blob.byteLength - offset), blob.offset + offset);
      if (!read.bytesRead) return fail("truncated staged blob.");
      const bytes = buffer.subarray(0, read.bytesRead); digest.update(bytes);
      if (destination) await destination.writeFile(bytes);
      offset += read.bytesRead;
    }
  } finally { await input.close(); await destination?.close(); }
  return digest.digest("hex");
}

/** Validates retained history and replays committed bytes in an isolated worker; authored operations are never rerun. */
export async function validateDatasetRecovery(options: RecoveryValidationOptions): Promise<ValidatedDatasetRecovery> {
  try { return await validateRecovery(options); }
  catch (error) { await options.staged.dispose(); throw error; }
}
async function validateRecovery(options: RecoveryValidationOptions): Promise<ValidatedDatasetRecovery> {
  const authorize = () => { options.signal?.throwIfAborted(); const result: unknown = options.authorize(); if (result && typeof result === "object" && "then" in result) fail("authorization must be synchronous."); options.signal?.throwIfAborted(); };
  authorize();
  const staged = options.staged, root = await realpath(staged.directory);
  if ((await lstat(staged.directory)).isSymbolicLink()) return fail("staging directory is not private.");
  for (const file of staged.files) {
    if (dirname(await realpath(file.path)) !== root || (await lstat(file.path)).isSymbolicLink()) return fail("staged file escaped its directory.");
    const info = await lstat(file.path);
    if (!info.isFile() || info.size !== file.entry.byteLength || await blobHash({ path: file.path, offset: 0, byteLength: info.size }, authorize) !== file.entry.sha256) return fail("staged entry changed.");
  }
  const work = await mkdtemp(join(root, "validation-")), index = new DatabaseSync(join(work, "index.sqlite"));
  index.exec(`PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE;
    CREATE TABLE records(revision INTEGER PRIMARY KEY,metadata TEXT NOT NULL,path TEXT NOT NULL,offset INTEGER NOT NULL,length INTEGER NOT NULL);
    CREATE TABLE metadata(seq INTEGER PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE catalogs(hash TEXT PRIMARY KEY,revision INTEGER UNIQUE,body TEXT NOT NULL,compiled TEXT NOT NULL);
    CREATE TABLE used_catalogs(hash TEXT PRIMARY KEY);
    CREATE TABLE receipts(caller TEXT,key TEXT,PRIMARY KEY(caller,key));
    CREATE TABLE references_(id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
    CREATE TABLE permissions(kind TEXT,id TEXT,PRIMARY KEY(kind,id));`);
  let closed = false, worker: PersistentAppBackend | undefined, workerDirectory: string | undefined;
  const abort = () => { void worker?.abort("Recovery validation cancelled.").catch(() => {}); };
  options.signal?.addEventListener("abort", abort);
  const dispose = async () => { if (closed) return; closed = true; options.signal?.removeEventListener("abort", abort); await worker?.close(); index.close(); await rm(work, { recursive: true, force: true }); await staged.dispose(); };
  const maxRecords = recoveryInteger(options.maxRecords ?? 1_000_000, 1), maxEvent = recoveryInteger(options.maxEventBytes ?? 16 * CHUNK, 1, 128 * CHUNK);
  let count = 0, frameCount = 0, catalog: RecoveryCatalog | undefined, currentCheckpoint: JournalExportRecord | undefined, previous: DatasetCursor | null = null;
  const rawMetadata = (body: RecoveryMetadata) => index.prepare("INSERT INTO metadata(body) VALUES(?)").run(JSON.stringify(body));
  const getCatalog = (hash: string) => {
    const row = index.prepare("SELECT body,compiled FROM catalogs WHERE hash=?").get(hash);
    if (!row) return fail("approved artifact history is incomplete.");
    const original = JSON.parse(String(row.body)) as RecoveryCatalog;
    return { ...original, revision: parseDatasetRevision(JSON.parse(original.revisionJson)), compiled: String(row.compiled), artifacts: JSON.parse(original.artifactsJson) as {schemaSql:string;operationSource:string} };
  };
  async function addCatalog(value: unknown, current: boolean) {
    const r = recoveryObject(value, ["kind", "revisionJson", "artifactsJson"]);
    const revisionJson = recoveryText(r.revisionJson, 256 * 1024), artifactsJson = recoveryText(r.artifactsJson, 768 * 1024);
    const artifacts = recoveryObject(JSON.parse(artifactsJson), ["schemaSql", "operationSource"]);
    const revision = verifyDatasetArtifacts({ revision: parseDatasetRevision(JSON.parse(revisionJson)), schemaSql: recoveryText(artifacts.schemaSql, 256 * 1024), operationSource: recoveryText(artifacts.operationSource, 256 * 1024) });
    if (revision.datasetId !== staged.manifest.cursor.datasetId || current && revision.revisionSha256 !== staged.manifest.cursor.approvedRevisionHash) fail("catalog scope differs.");
    if (revision.definition.operationsPath.endsWith(".ts") && !options.compileOperations) fail("TypeScript recovery requires the host compiler.");
    const source = String(artifacts.operationSource), compiled = recoveryText(options.compileOperations ? await options.compileOperations(source, revision.definition.operationsPath) : source, 256 * 1024);
    const original = { revisionJson, artifactsJson };
    index.prepare("INSERT INTO catalogs VALUES(?,?,?,?)").run(revision.revisionSha256, revision.revision, JSON.stringify(original), compiled);
    if (current) catalog = original; else rawMetadata({ kind: "catalog-revision", ...original });
  }
  async function addJournal(raw: unknown, blob: RecoveryBlob) {
    authorize(); const record = parseRecoveryJournalRecord(raw, maxEvent), c = record.cursor;
    if (++count > maxRecords || c.workspaceId !== staged.manifest.cursor.workspaceId || c.datasetId !== staged.manifest.cursor.datasetId ||
        c.revision !== (previous ? previous.revision + 1 : 0)) fail("journal scope, count, or revision differs.");
    const approval = getCatalog(c.approvedRevisionHash);
    if (record.byteLength !== blob.byteLength || await blobHash(blob, authorize) !== (record.kind === "checkpoint" ? record.sha256 : record.changesetSha256)) fail("journal blob hash differs.");
    if (record.kind === "checkpoint") {
      index.prepare("INSERT OR IGNORE INTO used_catalogs VALUES(?)").run(c.approvedRevisionHash);
      if (record.previous ? !previous || !equalRecoveryCursor(record.previous, previous) : previous !== null) fail("checkpoint previous cursor differs.");
      if (record.source !== approval.compiled || record.schemaSql !== approval.artifacts.schemaSql ||
          JSON.stringify(parseDatasetRevision(JSON.parse(record.definitionJson))) !== JSON.stringify(approval.revision)) fail("checkpoint artifacts differ from original approval.");
    } else {
      if (!previous || record.previousDigest !== previous.digest || c.hostEpoch !== previous.hostEpoch || c.approvedRevisionHash !== previous.approvedRevisionHash) fail("event chain identity differs.");
      index.prepare("INSERT INTO receipts VALUES(?,?)").run(record.callerKey, record.idempotencyKey);
      for (const id of record.attachedFileIds) index.prepare("INSERT OR IGNORE INTO references_ VALUES(?,?)").run(id, c.revision);
    }
    index.prepare("INSERT INTO records VALUES(?,?,?,?,?)").run(c.revision, JSON.stringify(record), blob.path, blob.offset, blob.byteLength); previous = c;
  }
  async function parseFile(path: string, history: boolean) {
    const handle = await open(path, "r"), size = (await handle.stat()).size; let offset = history ? 8 : 0, journals = false;
    try {
      if (history && Buffer.from(await readRange({ path, offset: 0, byteLength: 8 }, 8)).toString() !== "DOHCDH01") fail("history magic differs.");
      while (offset < size) {
        if (++frameCount > maxRecords) fail("recovery record count exceeds its limit.");
        authorize(); const prefix = await readRange({ path, offset, byteLength: 4 }, 4), length = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0); offset += 4;
        recoveryInteger(length, 1, MAX_META);
        const raw = json(await readRange({ path, offset, byteLength: length }, MAX_META)) as Record<string, unknown>; offset += length;
        if (raw?.kind === "event" || raw?.kind === "checkpoint") {
          if (!history && raw.kind !== "event") fail("tail includes a checkpoint.");
          journals = true; const record = parseRecoveryJournalRecord(raw, maxEvent);
          await addJournal(raw, { path, offset, byteLength: record.byteLength }); offset += record.byteLength; continue;
        }
        if (!history || journals) fail("metadata appears after journal records.");
        if (raw?.kind === "catalog") { if (catalog) fail("duplicate catalog."); await addCatalog(raw, true); continue; }
        if (!catalog) fail("catalog must appear first.");
        if (raw.kind === "current-checkpoint") {
          recoveryObject(raw, ["kind", "checkpoint"]); if (currentCheckpoint) fail("duplicate current checkpoint.");
          currentCheckpoint = parseRecoveryJournalRecord(raw.checkpoint, maxEvent);
          if (currentCheckpoint.kind !== "checkpoint" || !equalRecoveryCursor(currentCheckpoint.cursor, staged.manifest.checkpoint)) fail("current checkpoint differs.");
        } else if (raw.kind === "catalog-revision") await addCatalog(raw, false);
        else if (raw.kind === "binding" || raw.kind === "grant") {
          const binding = raw.kind === "binding", key = binding ? "appId" : "principalKey", body = binding ? "bindingJson" : "grantJson";
          recoveryObject(raw, ["kind", key, body, "token"]); const id = recoveryText(raw[key], binding ? 256 : 1024), token = recoveryText(raw.token, 256), encoded = recoveryText(raw[body], 256 * 1024);
          const value = JSON.parse(encoded), approvalHash = recoveryDigest(value.revisionSha256);
          // Bindings may intentionally retain an older approved revision. Validate after all catalogs load.
          recoveryInteger(value.revision, 1); recoveryDigest(approvalHash);
          index.prepare("INSERT INTO permissions VALUES(?,?)").run(raw.kind, id);
          rawMetadata(binding ? { kind: "binding", appId: id, bindingJson: encoded, token } : { kind: "grant", principalKey: id, grantJson: encoded, token });
        } else if (raw.kind === "attachment") {
          recoveryObject(raw, ["kind", "file"]); const file = recoveryObject(raw.file, ["fileId", "name", "contentType", "byteLength", "sha256", "revision"]);
          const id = recoveryText(file.fileId, 128); if (!/^[A-Za-z0-9_-]{16,128}$/.test(id)) fail("invalid file identity.");
          const metadata = { fileId: id, name: recoveryText(file.name, 1024), contentType: recoveryText(file.contentType, 256), byteLength: recoveryInteger(file.byteLength), sha256: recoveryDigest(file.sha256), revision: recoveryInteger(file.revision, 1, staged.manifest.cursor.revision) };
          const entry = staged.files.find(f => f.entry.kind === "attachment" && f.entry.id === `attachment:${id}`)?.entry;
          if (!entry || entry.byteLength !== metadata.byteLength || entry.sha256 !== metadata.sha256) fail("attachment metadata and bytes differ.");
          index.prepare("INSERT INTO attachments VALUES(?,?)").run(id, metadata.revision); rawMetadata({ kind: "attachment", file: metadata });
        } else fail("unexpected recovery metadata.");
      }
      if (offset !== size) fail("framed history length differs.");
    } finally { await handle.close(); }
  }
  try {
    const history = staged.files.find(f => f.entry.kind === "history"), checkpoint = staged.files.find(f => f.entry.kind === "checkpoint");
    if (!history || !checkpoint) fail("required recovery entries are missing.");
    await parseFile(history.path, true);
    if (!catalog || !currentCheckpoint) fail("current catalog or checkpoint missing.");
    await addJournal(currentCheckpoint, { path: checkpoint.path, offset: 0, byteLength: checkpoint.entry.byteLength });
    for (const file of staged.files.filter(f => f.entry.kind === "events")) await parseFile(file.path, false);
    if (!previous || !equalRecoveryCursor(previous, staged.manifest.cursor)) fail("history does not reach the pinned head.");
    if (index.prepare("SELECT hash FROM catalogs EXCEPT SELECT hash FROM used_catalogs").get()) fail("unreferenced approved artifact revision.");
    const original = getCatalog(staged.manifest.cursor.approvedRevisionHash);
    for (const [role, expected] of [["source", original.artifacts.operationSource], ["schema", original.artifacts.schemaSql], ["definition", original.revisionJson]]) {
      const file = staged.files.find(f => f.entry.kind === "artifact" && f.entry.role === role);
      if (!file || Buffer.from(await readRange({ path: file.path, offset: 0, byteLength: file.entry.byteLength }, MAX_META)).toString() !== expected) fail("current source artifact differs.");
    }
    if (index.prepare("SELECT id FROM references_ EXCEPT SELECT id FROM attachments").get() ||
        index.prepare("SELECT id FROM attachments EXCEPT SELECT id FROM references_").get() ||
        index.prepare("SELECT a.id FROM attachments a JOIN references_ r ON a.id=r.id WHERE a.revision!=r.revision").get() ||
        Number(index.prepare("SELECT count(*) n FROM attachments").get()!.n) !== staged.files.filter(f => f.entry.kind === "attachment").length) fail("attachment association history differs.");
    for (const row of index.prepare("SELECT body FROM metadata").iterate()) {
      authorize(); const m = JSON.parse(String(row.body)) as RecoveryMetadata;
      if (m.kind === "binding") { const b = JSON.parse(m.bindingJson); parseDatasetBinding(b, getCatalog(b.revisionSha256).revision); }
      if (m.kind === "grant") {
        const grant = recoveryObject(JSON.parse(m.grantJson), ["operationIds", "discover", "revision", "revisionSha256"]), approved = getCatalog(String(grant.revisionSha256)).revision;
        if (grant.revision !== approved.revision || typeof grant.discover !== "boolean" || !Array.isArray(grant.operationIds) || new Set(grant.operationIds).size !== grant.operationIds.length ||
            grant.operationIds.some(id => !approved.definition.operations.some(op => op.operationId === id))) fail("invalid retained data grant.");
      }
    }
    const records = function* (): Iterable<ValidatedRecoveryJournal> {
      for (const row of index.prepare("SELECT * FROM records ORDER BY revision").iterate()) {
        authorize(); const record = parseRecoveryJournalRecord(JSON.parse(String(row.metadata)), maxEvent);
        const blob = Object.freeze({ path: String(row.path), offset: Number(row.offset), byteLength: Number(row.length) });
        validatedBlobs.set(blob, { sha256: record.kind === "checkpoint" ? record.sha256 : record.changesetSha256,
          authorize() { if (closed) fail("validation was disposed."); authorize(); } });
        yield { record, blob };
      }
    };
    for (const item of records()) {
      authorize(); const r = item.record;
      if (r.kind === "checkpoint") {
        await worker?.close(); worker = undefined;
        if (workerDirectory) await rm(workerDirectory, { recursive: true, force: true });
        const sandbox = await mkdtemp(join(work, "checkpoint-")), path = join(sandbox, "checkpoint.sqlite");
        workerDirectory = sandbox;
        await blobHash(item.blob, authorize, path);
        worker = await openPersistentAppBackend({ directory: sandbox, checkpointPath: path, schemaSql: r.schemaSql,
          tables: getCatalog(r.cursor.approvedRevisionHash).revision.definition.tables.map(t => t.sqlName), scope: r.cursor, cursor: r.cursor, databaseBytes: r.capacityBytes }, options.runtime);
        if (options.signal?.aborted) await worker.abort("Recovery validation cancelled.");
        authorize();
      } else {
        if (!worker) fail("event precedes checkpoint.");
        await worker.apply({ revision: r.cursor.revision, digest: r.cursor.digest, previousDigest: r.previousDigest, changesetSha256: r.changesetSha256,
          changeset: await readRange(item.blob, maxEvent) });
      }
    }
    await worker?.close(); worker = undefined; authorize();
    if (workerDirectory) { await rm(workerDirectory, { recursive: true, force: true }); workerDirectory = undefined; }
    const checkpointBlob = Object.freeze({ path: checkpoint.path, offset: 0, byteLength: checkpoint.entry.byteLength });
    validatedBlobs.set(checkpointBlob, { sha256: checkpoint.entry.sha256, authorize() { if (closed) fail("validation was disposed."); authorize(); } });
    return { manifest: staged.manifest, catalog, checkpoint: { record: currentCheckpoint, blob: checkpointBlob }, records,
      metadata: function* () { for (const row of index.prepare("SELECT body FROM metadata ORDER BY seq").iterate()) { authorize(); yield JSON.parse(String(row.body)) as RecoveryMetadata; } }, dispose };
  } catch (error) { await dispose(); throw error; }
}
