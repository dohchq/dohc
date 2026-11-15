import { createHash } from "node:crypto";
import {
  accessRuleFolder,
  accessRuleSet,
  fileLevel,
  folderLevel,
  type AccessRuleSet,
  type ReachViewer,
} from "@dohc/security-contract/access-rules";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { accountEmail } from "./accountEmails";
import { accessRuleHistoryFloor, accessRuleSetBefore, currentAccessRuleSet } from "./accessRules";
import type { SqliteDb } from "./types";

export interface MemberReach {
  refresh(): MemberReach;
  revision: string;
  signature: string;
  levelAt(path: string): ShareAccess | null;
  folderLevel(folder: string): ShareAccess | null;
  objectVisible(objectId: string): boolean;
  objectPath(objectId: string): string | null;
  nearestRule(path: string): string;
}

/** Build once inside the caller's read or committing transaction. */
export function memberReach(
  db: SqliteDb,
  workspaceId: string,
  userId: string,
  role: "admin" | "member",
  level: ShareAccess,
): MemberReach {
  const email = accountEmail(db, userId);
  const viewer: ReachViewer =
    role === "admin"
      ? { role }
      : {
          role,
          level,
          verifiedEmail: email?.verified ? email.email : null,
          unverifiedEmail: email && !email.verified ? email.email : null,
        };
  const knownRules = (rules: AccessRuleSet) =>
    email || role === "admin"
      ? rules
      : accessRuleSet(
          [...rules.exact].map(
            ([folder, rule]) => [folder, rule && rule.people.size === 0 ? rule : null] as const,
          ),
        );
  const rules = knownRules(currentAccessRuleSet(db, workspaceId, "main"));
  const levelAt = (path: string) => fileLevel(rules, viewer, path);
  const atFolder = (folder: string) => folderLevel(rules, viewer, folder);
  const floor = accessRuleHistoryFloor(db, workspaceId);
  const objects = new Map<string, { visible: boolean; path: string | null }>();
  const object = (id: string) => {
    const cached = objects.get(id);
    if (cached) return cached;
    const latest = db
      .prepare(`SELECT path, relay_seq FROM sync_relay_object_moments
      WHERE workspace_id = ? AND version_id = 'main' AND object_id = ? ORDER BY relay_seq DESC LIMIT 1`)
      .get(workspaceId, id);
    const last =
      latest?.path ??
      db
        .prepare(`SELECT path FROM sync_relay_object_moments
      WHERE workspace_id = ? AND version_id = 'main' AND object_id = ? AND path IS NOT NULL ORDER BY relay_seq DESC LIMIT 1`)
        .get(workspaceId, id)?.path;
    const path = typeof last === "string" ? last : null;
    let visible = !!latest && path !== null && levelAt(path) !== null;
    if (visible && latest!.path === null && role !== "admin") {
      const seq = Number(latest!.relay_seq);
      visible =
        seq > floor &&
        fileLevel(knownRules(accessRuleSetBefore(db, workspaceId, "main", seq)), viewer, path!) !==
          null;
    }
    const result = { visible, path };
    objects.set(id, result);
    return result;
  };
  const nearestRule = (path: string) => {
    let folder = accessRuleFolder(path);
    for (;;) {
      if (rules.exact.has(folder)) return folder;
      if (!folder) return "";
      folder = accessRuleFolder(folder);
    }
  };
  // Describe evaluated boundaries, rather than rule text or ordinary content.
  const boundaries = [...rules.exact.keys()]
    .sort()
    .flatMap((folder) =>
      folder !== "" && atFolder(folder) === atFolder(accessRuleFolder(folder))
        ? []
        : [[folder, atFolder(folder)]],
    );
  const moves = db
    .prepare(`SELECT relay_seq, payload_json FROM sync_relay_log
    WHERE workspace_id = ? AND op_kind = 'moment.append' AND json_valid(payload_json)
      AND json_extract(payload_json, '$.operation') = 'rename'`)
    .all(workspaceId)
    .flatMap((row) => {
      const p = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      return typeof p.payloadBeforePath === "string" &&
        typeof p.payloadAfterPath === "string" &&
        nearestRule(p.payloadBeforePath) !== nearestRule(p.payloadAfterPath) &&
        levelAt(p.payloadBeforePath) !== levelAt(p.payloadAfterPath)
        ? [Number(row.relay_seq)]
        : [];
    });
  const signature = createHash("sha256")
    .update(JSON.stringify([userId, role, atFolder(""), boundaries, moves]))
    .digest("hex");
  const stored = db
    .prepare(
      "SELECT signature, revision FROM sync_relay_member_revisions WHERE workspace_id = ? AND user_id = ?",
    )
    .get(workspaceId, userId);
  const revision = stored?.signature === signature ? String(stored.revision) : signature;
  return {
    revision,
    signature,
    levelAt,
    folderLevel: atFolder,
    nearestRule,
    refresh: () => memberReach(db, workspaceId, userId, role, level),
    objectVisible: (id) => object(id).visible,
    objectPath: (id) => object(id).path,
  };
}
