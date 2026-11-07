import { createHash } from "node:crypto";
import { parseAppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import type { JournalDb } from "@dohc/app-backend-runtime/journal";
import type { LocalAppPrepared, LocalAppRow, LocalAppStorage, LocalAppStore } from "./localAppStore";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";

export function localUnconnectedAppStorage(db: JournalDb): LocalAppStorage {
  return { kind: "unconnected", publicationTable: "local_unconnected_apps", artifactTable: "local_unconnected_app_artifacts", resourceColumn: null,
    ensureSchema() {
      db.exec(`CREATE TABLE IF NOT EXISTS local_unconnected_apps(
        publication_id TEXT PRIMARY KEY, app_root TEXT NOT NULL UNIQUE,
        authority_revision INTEGER NOT NULL, candidate TEXT NOT NULL, storage_bytes INTEGER NOT NULL, active INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS local_unconnected_app_artifacts(
        publication_id TEXT NOT NULL REFERENCES local_unconnected_apps(publication_id) ON DELETE CASCADE,
        path TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(publication_id,path)) STRICT;`);
    },
  };
}

/** Approved apps that reach no workspace data. They get no capability, so createLocalApps refuses every data request from them. */
export function createLocalUnconnectedApps(options: { store: LocalAppStore; workspaceId: string; assertCurrent(): void }) {
  function current(publicationId: string, expected?: number): LocalAppRow {
    const row = options.store.row(publicationId, expected);
    if (row.kind !== "unconnected" || row.candidate.capabilities.length) throw new Error("Invalid app approval.");
    return row;
  }
  return {
    current,
    activate(prepared: LocalAppPrepared, signal: AbortSignal, agent: ApprovalAgent | null | undefined, displace: (displaced: LocalAppRow | undefined, commit: () => void) => void) {
      options.assertCurrent(); signal.throwIfAborted();
      const candidate = parseAppPublicationCandidate(prepared.candidate, APP_PUBLICATION_LIMITS);
      if (candidate.capabilities.length) throw new Error("Invalid app approval.");
      const publicationId = createHash("sha256").update(JSON.stringify(["dohc-local-unconnected-app-v1", options.workspaceId, candidate])).digest("hex");
      return options.store.activate({ kind: "unconnected", resourceId: "", publicationId, prepared, agent }, signal, (_previous, displaced, commit) => displace(displaced, commit));
    },
    describe(value: LocalAppRow) {
      if (value.candidate.capabilities.length) throw new Error("Invalid app approval.");
      const approved = options.store.held(value);
      return { publicationId: value.publicationId, authorityRevision: value.authorityRevision, appRoot: value.appRoot,
        sourceRevision: value.candidate.sourceRevision, approved, active: approved };
    },
  };
}
