import { createHash } from "node:crypto";
import { parseAppPublicationCandidate, type AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { parseApprovalAgent, type ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import type { JournalDb } from "@dohc/app-backend-runtime/journal";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";
import type { ClosedAppBuild } from "./closedAppCompiler";

export type LocalAppKind = "dataset" | "collection";
export type LocalAppPrepared = { candidate: AppPublicationCandidate; files: ClosedAppBuild["files"] };
export interface LocalAppStorage {
  kind: LocalAppKind;
  publicationTable: string;
  artifactTable: string;
  resourceColumn: string;
  ensureSchema(): void;
  /** Throws while a publication still has admitted work that replacing it would orphan. */
  assertRetirable?(publicationId: string): void;
}
export interface LocalAppRow {
  kind: LocalAppKind; publicationId: string; appRoot: string; resourceId: string;
  authorityRevision: number; candidate: AppPublicationCandidate; storageBytes: number; active: boolean;
}
type StoredRow = { publication_id: string; app_root: string; resource_id: string; authority_revision: number; candidate: string; storage_bytes: number; active: number };
type Root = { revision: number; active_kind: string | null; active_publication_id: string | null };
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Stores app authority and bundles in the workspace's existing authority transaction. */
export function createLocalAppStore(options: {
  db: JournalDb; sources: readonly LocalAppStorage[]; assertCurrent(): void;
  transaction<T>(work: () => T): T;
  charge(kind: LocalAppKind, resourceId: string, bytes: number): void;
}) {
  const { db } = options;
  const source = (kind: LocalAppKind) => {
    const value = options.sources.find(value => value.kind === kind);
    if (!value) throw new Error("Invalid app approval.");
    return value;
  };
  const decode = (storage: LocalAppStorage, value: StoredRow): LocalAppRow => ({
    kind: storage.kind, publicationId: value.publication_id, appRoot: value.app_root, resourceId: value.resource_id,
    authorityRevision: value.authority_revision, candidate: parseAppPublicationCandidate(JSON.parse(value.candidate), APP_PUBLICATION_LIMITS),
    storageBytes: value.storage_bytes, active: !!value.active,
  });
  const rows = (storage: LocalAppStorage, where: string, values: string[]) =>
    (db.prepare('SELECT *, ' + storage.resourceColumn + ' AS resource_id FROM ' + storage.publicationTable + ' ' + where).all(...values) as StoredRow[]).map(value => decode(storage, value));
  const root = (appRoot: string) => db.prepare("SELECT revision,active_kind,active_publication_id FROM local_app_roots WHERE app_root=?").get(appRoot) as Root | undefined;
  function nextRevision(appRoot: string) {
    const next = (root(appRoot)?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(next) || next < 1) throw new Error("This app approval version is invalid. Refresh the publication list.");
    return next;
  }
  function writeRoot(row: Pick<LocalAppRow, "appRoot" | "kind" | "publicationId">, revision: number, active: boolean) {
    db.prepare("INSERT INTO local_app_roots VALUES(?,?,?,?) ON CONFLICT(app_root) DO UPDATE SET revision=excluded.revision,active_kind=excluded.active_kind,active_publication_id=excluded.active_publication_id")
      .run(row.appRoot, revision, active ? row.kind : null, active ? row.publicationId : null);
  }
  function assertCanAdvance(revisions: string, values: string[] = []) {
    if (db.prepare('SELECT 1 FROM (' + revisions + ') WHERE revision<0 OR revision>=? LIMIT 1').get(...values, Number.MAX_SAFE_INTEGER))
      throw new Error("This app approval version is invalid. Refresh the publication list.");
  }
  options.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS local_app_roots(app_root TEXT PRIMARY KEY,revision INTEGER NOT NULL,active_kind TEXT,active_publication_id TEXT,CHECK((active_kind IS NULL)=(active_publication_id IS NULL))) STRICT");
    db.exec("CREATE TABLE IF NOT EXISTS local_app_approval_provenance(publication_id TEXT PRIMARY KEY,provenance TEXT NOT NULL) STRICT");
    for (const storage of options.sources) storage.ensureSchema();
    for (const storage of options.sources) {
      const table = storage.publicationTable;
      db.prepare('INSERT INTO local_app_roots SELECT app_root,authority_revision,CASE WHEN active=1 THEN ? END,CASE WHEN active=1 THEN publication_id END FROM ' + table + ' WHERE 1 ON CONFLICT(app_root) DO NOTHING').run(storage.kind);
      // Older builds can delete, withdraw, or replace rows without updating roots.
      const stale = 'active_kind=? AND NOT EXISTS(SELECT 1 FROM ' + table + ' p WHERE p.app_root=local_app_roots.app_root AND p.publication_id=local_app_roots.active_publication_id AND p.active=1 AND p.authority_revision=local_app_roots.revision)';
      assertCanAdvance('SELECT revision FROM local_app_roots WHERE ' + stale, [storage.kind]);
      db.prepare('UPDATE local_app_roots SET revision=revision+1,active_kind=NULL,active_publication_id=NULL WHERE ' + stale).run(storage.kind);
      // Only explicit replacement moves a root another kind holds.
      const free = 'NOT EXISTS(SELECT 1 FROM local_app_roots o WHERE o.app_root=p.app_root AND o.active_kind<>?)';
      const untracked = 'active=1 AND ' + free + ' AND NOT EXISTS(SELECT 1 FROM local_app_roots r WHERE r.app_root=p.app_root AND r.active_kind=? AND r.active_publication_id=p.publication_id AND r.revision=p.authority_revision)';
      const revision = 'MAX(authority_revision,(SELECT revision FROM local_app_roots r WHERE r.app_root=p.app_root))';
      assertCanAdvance('SELECT ' + revision + ' AS revision FROM ' + table + ' p WHERE ' + untracked, [storage.kind, storage.kind]);
      db.prepare('DELETE FROM local_app_approval_provenance WHERE publication_id IN (SELECT publication_id FROM ' + table + ' p WHERE ' + untracked + ')').run(storage.kind, storage.kind);
      db.prepare('UPDATE ' + table + ' AS p SET authority_revision=' + revision + '+1 WHERE ' + untracked).run(storage.kind, storage.kind);
      db.prepare('INSERT INTO local_app_roots SELECT app_root,authority_revision,?,publication_id FROM ' + table + ' p WHERE active=1 AND ' + free + ' ON CONFLICT(app_root) DO UPDATE SET revision=excluded.revision,active_kind=excluded.active_kind,active_publication_id=excluded.active_publication_id').run(storage.kind, storage.kind);
      db.exec('UPDATE local_app_roots AS r SET revision=MAX(revision,COALESCE((SELECT MAX(authority_revision) FROM ' + table + ' p WHERE p.app_root=r.app_root),0)) WHERE active_publication_id IS NULL');
    }
    db.exec('DELETE FROM local_app_approval_provenance WHERE ' + options.sources.map(storage => 'NOT EXISTS(SELECT 1 FROM ' + storage.publicationTable + ' p WHERE p.publication_id=local_app_approval_provenance.publication_id)').join(' AND '));
  });
  function lookup(publicationId: string) {
    options.assertCurrent();
    const matches = options.sources.flatMap(storage => rows(storage, "WHERE publication_id=?", [publicationId]));
    if (matches.length > 1) throw new Error("Ambiguous app approval.");
    return matches[0];
  }
  function row(publicationId: string, expected?: number) {
    const value = lookup(publicationId), authority = value && root(value.appRoot);
    if (!value || !value.active || !authority || authority.active_kind !== value.kind || authority.active_publication_id !== publicationId ||
      authority.revision !== value.authorityRevision || (expected !== undefined && expected !== authority.revision))
      throw new Error("This app approval changed. Prepare the app again.");
    return value;
  }
  function list(appRoot: string) {
    options.assertCurrent();
    return options.sources.flatMap(storage => rows(storage, "WHERE app_root=?", [appRoot]));
  }
  /** Whether this device's authority for the app root names this row. */
  function held(value: LocalAppRow) {
    const authority = root(value.appRoot);
    return value.active && authority?.active_kind === value.kind && authority.active_publication_id === value.publicationId && authority.revision === value.authorityRevision;
  }
  return {
    row,
    held,
    has(publicationId: string) { return !!lookup(publicationId); },
    list,
    /** `displaced` is another kind's publication that holds the root; the commit deactivates it. */
    activate(input: { kind: LocalAppKind; resourceId: string; publicationId: string; prepared: LocalAppPrepared; agent?: ApprovalAgent | null }, signal: AbortSignal,
      bind: (previous: LocalAppRow | undefined, displaced: LocalAppRow | undefined, commit: () => void) => void) {
      options.assertCurrent(); signal.throwIfAborted();
      const storage = source(input.kind), candidate = parseAppPublicationCandidate(input.prepared.candidate, APP_PUBLICATION_LIMITS);
      const atRoot = list(candidate.appRoot), previous = atRoot.find(value => value.kind === input.kind);
      const displaced = atRoot.find(value => value.kind !== input.kind && held(value));
      if (input.prepared.files.length !== candidate.files.length) throw new Error("App bundle files changed. Prepare the app again.");
      const files = candidate.files.map(metadata => {
        const matches = input.prepared.files.filter(file => file.path === metadata.path), file = matches[0];
        if (matches.length !== 1 || !file || file.bytes.byteLength !== metadata.byteLength || hash(file.bytes) !== metadata.sha256)
          throw new Error("App bundle files changed. Prepare the app again.");
        return { path: file.path, bytes: Uint8Array.from(file.bytes) };
      });
      if (previous?.publicationId === input.publicationId && held(previous))
        return { publicationId: input.publicationId, authorityRevision: row(input.publicationId, previous.authorityRevision).authorityRevision };
      const json = JSON.stringify(candidate), provenance = JSON.stringify({ agent: parseApprovalAgent(input.agent),
        committedCandidateDigest: createHash("sha256").update(json).digest("hex"), sourceRevision: candidate.sourceRevision, capabilities: candidate.capabilities });
      const storageBytes = Buffer.byteLength(json) + Buffer.byteLength(provenance) + files.reduce((sum, file) => sum + file.bytes.byteLength, 0) + 512;
      let authorityRevision = 0;
      bind(previous, displaced, () => options.transaction(() => {
        signal.throwIfAborted(); options.assertCurrent();
        const currentRoot = root(candidate.appRoot);
        const count = Number(db.prepare("SELECT count(*) AS count FROM local_app_roots WHERE active_publication_id IS NOT NULL").get()!.count);
        if (!currentRoot?.active_publication_id && count >= 64) throw new Error("Remove an app before approving another one.");
        authorityRevision = nextRevision(candidate.appRoot);
        for (const retired of [previous, displaced]) if (retired) source(retired.kind).assertRetirable?.(retired.publicationId);
        if (displaced) db.prepare('UPDATE ' + source(displaced.kind).publicationTable + ' SET active=0,authority_revision=? WHERE publication_id=?').run(authorityRevision, displaced.publicationId);
        if (previous) {
          db.prepare('DELETE FROM local_app_approval_provenance WHERE publication_id=?').run(previous.publicationId);
          db.prepare('DELETE FROM ' + storage.artifactTable + ' WHERE publication_id=?').run(previous.publicationId);
          db.prepare('DELETE FROM ' + storage.publicationTable + ' WHERE publication_id=?').run(previous.publicationId);
          options.charge(previous.kind, previous.resourceId, -previous.storageBytes);
        }
        options.charge(input.kind, input.resourceId, storageBytes);
        db.prepare('INSERT INTO ' + storage.publicationTable + '(publication_id,app_root,' + storage.resourceColumn + ',authority_revision,candidate,storage_bytes,active) VALUES(?,?,?,?,?,?,1)')
          .run(input.publicationId, candidate.appRoot, input.resourceId, authorityRevision, json, storageBytes);
        db.prepare('INSERT INTO local_app_approval_provenance VALUES(?,?)').run(input.publicationId, provenance);
        for (const file of files) db.prepare('INSERT INTO ' + storage.artifactTable + ' VALUES(?,?,?)').run(input.publicationId, file.path, file.bytes);
        writeRoot({ appRoot: candidate.appRoot, kind: input.kind, publicationId: input.publicationId }, authorityRevision, true);
      }));
      row(input.publicationId, authorityRevision);
      return { publicationId: input.publicationId, authorityRevision };
    },
    /**
     * Ends the publication's authority at the next revision. Repeating at the revision a withdrawal or replacement
     * already ended it changes nothing, so its caller can confirm admitted work settled.
     */
    withdraw(publicationId: string, expected: number, bind: (row: LocalAppRow, commit: () => void) => void) {
      const value = lookup(publicationId);
      if (value && !held(value) && value.authorityRevision === expected) return { kind: value.kind, publicationId, authorityRevision: expected };
      const checked = row(publicationId, expected), storage = source(checked.kind);
      let authorityRevision = 0;
      bind(checked, () => options.transaction(() => {
        row(publicationId, expected);
        authorityRevision = nextRevision(checked.appRoot);
        db.prepare('UPDATE ' + storage.publicationTable + ' SET active=0,authority_revision=? WHERE publication_id=?').run(authorityRevision, publicationId);
        writeRoot(checked, authorityRevision, false);
      }));
      return { kind: checked.kind, publicationId, authorityRevision };
    },
    browserPublication(publicationId: string) {
      const checked = row(publicationId), storage = source(checked.kind);
      const files = checked.candidate.files.map(metadata => {
        const stored = db.prepare('SELECT content FROM ' + storage.artifactTable + ' WHERE publication_id=? AND path=?').get(publicationId, metadata.path);
        if (!stored || !(stored.content instanceof Uint8Array) || stored.content.byteLength !== metadata.byteLength || hash(stored.content) !== metadata.sha256)
          throw new Error("App bundle integrity check failed.");
        return { ...metadata, bytes: Uint8Array.from(stored.content) };
      });
      return { publicationId, authorityRevision: checked.authorityRevision, appRoot: checked.appRoot, files };
    },
    deleteResources(kind: LocalAppKind, resourceId: string) {
      options.assertCurrent();
      const storage = source(kind);
      const publications = 'SELECT publication_id FROM ' + storage.publicationTable + ' WHERE ' + storage.resourceColumn + '=?';
      const active = 'active_kind=? AND active_publication_id IN (' + publications + ')';
      assertCanAdvance('SELECT revision FROM local_app_roots WHERE ' + active, [kind, resourceId]);
      db.prepare('UPDATE local_app_roots SET revision=revision+1,active_kind=NULL,active_publication_id=NULL WHERE ' + active).run(kind, resourceId);
      db.prepare('DELETE FROM local_app_approval_provenance WHERE publication_id IN (' + publications + ')').run(resourceId);
      db.prepare('DELETE FROM ' + storage.artifactTable + ' WHERE publication_id IN (' + publications + ')').run(resourceId);
      db.prepare('DELETE FROM ' + storage.publicationTable + ' WHERE ' + storage.resourceColumn + '=?').run(resourceId);
    },
  };
}
export type LocalAppStore = ReturnType<typeof createLocalAppStore>;
