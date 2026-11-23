import { randomUUID } from "node:crypto";
import {
  FOLDER_MARKER_FILE,
  formatAccessRule,
  folderMarkerText,
  parseFormattedAccessRule,
  type AccessRule,
} from "@dohc/security-contract/access-rules";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { stableJsonStringify } from "../canonicalJson";
import { pathCollisionKey } from "../pathCollisionKey";
import { proposalBase, proposalMomentPayload } from "../recipientMoments";
import { FOLDER_ACCESS_ORIGIN } from "../relayLogInputs";
import { forgetReplicaCurrentViewCaches } from "../replicaCurrentViewReads";
import {
  accessRuleStatements,
  folderHasFiles,
  folderMarkerRule,
  markersIn,
  refreshFolderAccess,
  type AccessRuleStatements,
} from "./accessRules";
import type { StorageContext } from "./context";
import { appendLogBatchInTransaction, maxOriginSeq } from "./log";
import { workspaceRoleOf } from "./workspaceMembers";

// The folder rule operation (ADR 0017). The owner or an active admin changes
// a rule here; the role is read inside the write. Each change writes the
// rule's marker into its folders from the relay's own origin, in the same
// transaction, so the change has its own position in the owner's log and the
// marker reaches the owner's disk to move with the folder.

export type FolderRuleResult =
  | { ok: true; ruleId: string; revision: number }
  | { ok: false; reason: "not-found" | "forbidden" | "conflict" };

export type FolderRuleChange =
  | { kind: "create"; folder: string; rule: AccessRule }
  | { kind: "change"; ruleId: string; revision: number; rule: AccessRule }
  | { kind: "clear"; ruleId: string; revision: number };

// A stored NULL means cleared, so a rule with no text must never reach it.
function ruleText(rule: AccessRule): string {
  const text = formatAccessRule(rule);
  if (text === null) throw new Error("folder rule has no canonical text");
  return text;
}

const markerPath = (folder: string) =>
  folder === "" ? FOLDER_MARKER_FILE : `${folder}/${FOLDER_MARKER_FILE}`;

// The owner's disk may spell a marker another way. Writing the usual spelling
// beside it would make a twin, which hides the folder.
function heldMarkerPath(statements: AccessRuleStatements, workspaceId: string, folder: string) {
  const [held] = markersIn(statements, workspaceId, folder);
  return held === undefined ? markerPath(folder) : String(held.path);
}

// A disk that ignores case holds "team" and "Team" as one folder, so a rule
// typed in another case belongs to the folder the owner has.
function heldFolderPath(statements: AccessRuleStatements, workspaceId: string, folder: string) {
  if (folderHasFiles(statements, workspaceId, folder)) return folder;
  const key = pathCollisionKey(folder);
  const held = statements.keyUnder.get(workspaceId, `${key}/`, `${key}0`);
  if (held === undefined) return folder;
  // A name can fold to more than one segment, so check the folder matches.
  const path = String(held.path).split("/").slice(0, folder.split("/").length).join("/");
  return pathCollisionKey(path) === key ? path : folder;
}

export function changeFolderRule(
  storage: StorageContext,
  input: { workspaceId: string; actorUserId: string; change: FolderRuleChange; nowMs: number },
): FolderRuleResult {
  return storage.tx((): FolderRuleResult => {
    const { workspaceId, change } = input;
    const actor = workspaceRoleOf(storage, workspaceId, input.actorUserId);
    if (!actor) return { ok: false, reason: "not-found" };
    if (actor.role === "member") return { ok: false, reason: "forbidden" };
    const statements = accessRuleStatements(storage.db);
    const nowMs = Math.trunc(input.nowMs);
    let ruleId: string;
    let revision: number;
    let folders: string[];
    if (change.kind === "create") {
      const folder = heldFolderPath(statements, workspaceId, change.folder);
      // A folder or its twin on some disk takes one rule.
      const key = pathCollisionKey(folder);
      const taken = storage.db
        .prepare(
          `SELECT b.folder FROM sync_relay_folder_rule_bindings b
           JOIN sync_relay_folder_rules r ON r.workspace_id = b.workspace_id AND r.rule_id = b.rule_id
           WHERE b.workspace_id = ? AND r.rule_text IS NOT NULL`,
        )
        .all(workspaceId)
        .some((row) => pathCollisionKey(String(row.folder)) === key);
      if (taken) return { ok: false, reason: "conflict" };
      ruleId = `fr_${randomUUID().replaceAll("-", "")}`;
      revision = 1;
      storage.db
        .prepare(
          `INSERT INTO sync_relay_folder_rules
             (workspace_id, rule_id, revision, rule_text, changed_by_user_id, changed_at_ms)
           VALUES (?, ?, 1, ?, ?, ?)`,
        )
        .run(workspaceId, ruleId, ruleText(change.rule), input.actorUserId, nowMs);
      statements.bind.run(workspaceId, ruleId, folder);
      folders = [folder];
    } else {
      ruleId = change.ruleId;
      const held = storage.db
        .prepare(
          "SELECT revision, rule_text FROM sync_relay_folder_rules WHERE workspace_id = ? AND rule_id = ?",
        )
        .get(workspaceId, ruleId);
      if (!held || held.rule_text === null) return { ok: false, reason: "not-found" };
      // A change made from an older read would drop what another admin set since.
      if (Number(held.revision) !== change.revision) return { ok: false, reason: "conflict" };
      revision = change.revision + 1;
      storage.db
        .prepare(
          `UPDATE sync_relay_folder_rules SET revision = ?, rule_text = ?, changed_by_user_id = ?,
             changed_at_ms = ? WHERE workspace_id = ? AND rule_id = ?`,
        )
        .run(
          revision,
          change.kind === "clear" ? null : ruleText(change.rule),
          input.actorUserId,
          nowMs,
          workspaceId,
          ruleId,
        );
      folders = statements.ruleFolders.all(workspaceId, ruleId).map((row) => String(row.folder));
      if (change.kind === "clear")
        for (const folder of folders) statements.unbind.run(workspaceId, ruleId, folder);
    }
    // A folder with no files gets no marker, so a deleted folder isn't made again.
    const written = folders.filter((folder) =>
      change.kind === "clear"
        ? folderMarkerRule(statements, workspaceId, folder) === ruleId
        : change.kind === "create" || folderHasFiles(statements, workspaceId, folder),
    );
    writeMarkers(storage, statements, {
      workspaceId,
      markers: written.map((folder) => ({
        path: heldMarkerPath(statements, workspaceId, folder),
        text: change.kind === "clear" ? null : folderMarkerText(ruleId, revision),
      })),
      folders,
      nowMs,
    });
    return { ok: true, ruleId, revision };
  });
}

/**
 * Removes every marker in a folder, every spelling of its name, so a marker
 * that names no rule stops hiding the folder. A rule that covers the folder
 * still does.
 */
export function removeFolderMarkers(
  storage: StorageContext,
  input: { workspaceId: string; actorUserId: string; folder: string; nowMs: number },
): { ok: true } | { ok: false; reason: "not-found" | "forbidden" } {
  return storage.tx(() => {
    const actor = workspaceRoleOf(storage, input.workspaceId, input.actorUserId);
    if (!actor) return { ok: false, reason: "not-found" } as const;
    if (actor.role === "member") return { ok: false, reason: "forbidden" } as const;
    const statements = accessRuleStatements(storage.db);
    const markers = markersIn(statements, input.workspaceId, input.folder);
    if (markers.length === 0) return { ok: false, reason: "not-found" } as const;
    const ruleId = folderMarkerRule(statements, input.workspaceId, input.folder);
    if (ruleId !== null && statements.rule.get(input.workspaceId, ruleId))
      return { ok: false, reason: "not-found" } as const;
    writeMarkers(storage, statements, {
      workspaceId: input.workspaceId,
      markers: markers.map((row) => ({ path: String(row.path), text: null })),
      folders: [input.folder],
      nowMs: Math.trunc(input.nowMs),
    });
    return { ok: true } as const;
  });
}

// Writes or deletes markers as moments in main, then brings every touched
// folder's span to the log's head, so a folder whose marker isn't written
// still changes at this change's position.
function writeMarkers(
  storage: StorageContext,
  statements: AccessRuleStatements,
  input: {
    workspaceId: string;
    markers: Array<{ path: string; text: string | null }>;
    /** Every folder whose span may change, written or not. */
    folders: readonly string[];
    nowMs: number;
  },
): void {
  const { workspaceId, nowMs } = input;
  const firstOriginSeq = maxOriginSeq(storage, workspaceId, FOLDER_ACCESS_ORIGIN) + 1;
  const ops = input.markers.flatMap(({ path, text }) => {
    const objectId =
      storage.objectIdAtPathInVersion({ workspaceId, versionId: "main", path }) ?? null;
    const bytes = text === null ? null : new TextEncoder().encode(text);
    const sha256 = bytes === null ? null : sha256Hex(bytes);
    if (bytes !== null)
      storage.db
        .prepare(
          `INSERT INTO sync_relay_blobs (workspace_id, sha256, byte_length, content, created_at_ms)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace_id, sha256) DO NOTHING`,
        )
        .run(workspaceId, sha256, bytes.byteLength, Buffer.from(bytes), nowMs);
    const op = {
      opIndex: 0,
      basedOnPath: objectId === null ? null : path,
      basedOnObjectId: objectId,
      basedOnBlobSha256: null,
      operation: text === null ? ("delete" as const) : ("write" as const),
      afterPath: path,
      afterBlobSha256: sha256,
      afterContentKind: "text" as const,
      afterByteLength: bytes?.byteLength ?? null,
      recordedAtMs: nowMs,
    };
    const { head } = proposalBase(storage, workspaceId, "main", op);
    if (text === null && head === null) return [];
    const built = proposalMomentPayload(op, {
      versionId: "main",
      objectId: objectId ?? randomUUID(),
      objectCreatedAtMs: nowMs,
      base: head,
      currentPath: head?.path ?? null,
      momentId: randomUUID(),
      summary: null,
      author: null,
    });
    if (!built.ok) throw new Error(`folder marker moment: ${built.reason}`);
    return [
      {
        originSeq: 0,
        opKind: "moment.append",
        payloadJson: stableJsonStringify(built.payload),
        recordedAtMs: nowMs,
      },
    ];
  });
  if (ops.length > 0)
    appendLogBatchInTransaction(storage, {
      workspaceId,
      originId: FOLDER_ACCESS_ORIGIN,
      ops: ops.map((op, index) => ({ ...op, originSeq: firstOriginSeq + index })),
    });
  const head = Number(
    storage.db
      .prepare(
        "SELECT COALESCE(MAX(relay_seq), 0) AS head FROM sync_relay_log WHERE workspace_id = ?",
      )
      .get(workspaceId)?.head ?? 0,
  );
  for (const folder of input.folders) refreshFolderAccess(statements, workspaceId, folder, head);
  forgetReplicaCurrentViewCaches(storage, workspaceId);
}

export type FolderState = "covered" | "marker-missing" | "folder-missing";

/** Every active folder rule, with each folder it covers and that folder's state, for the owner's and admins' members read. */
export function readFolderRules(
  storage: StorageContext,
  workspaceId: string,
): Array<{
  ruleId: string;
  revision: number;
  rule: AccessRule;
  folders: Array<{ path: string; state: FolderState }>;
}> {
  const statements = accessRuleStatements(storage.db);
  return storage.db
    .prepare(
      `SELECT rule_id, revision, rule_text FROM sync_relay_folder_rules
       WHERE workspace_id = ? AND rule_text IS NOT NULL ORDER BY rule_id`,
    )
    .all(workspaceId)
    .flatMap((row) => {
      const ruleId = String(row.rule_id);
      const rule = parseFormattedAccessRule(String(row.rule_text));
      if (!rule) return [];
      const folders = statements.ruleFolders
        .all(workspaceId, ruleId)
        .map((binding) => {
          const path = String(binding.folder);
          const state: FolderState =
            folderMarkerRule(statements, workspaceId, path) === ruleId
              ? "covered"
              : folderHasFiles(statements, workspaceId, path)
                ? "marker-missing"
                : "folder-missing";
          return { path, state };
        })
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return [{ ruleId, revision: Number(row.revision), rule, folders }];
    });
}
