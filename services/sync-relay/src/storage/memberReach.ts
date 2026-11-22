import { createHash, createHmac } from "node:crypto";
import {
  accessRuleFolder,
  accessRuleSet,
  fileLevel,
  folderLevel,
  ruleLevel,
  type AccessRule,
  type AccessRuleSet,
  type ReachViewer,
} from "@dohc/security-contract/access-rules";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { pathCollisionKey } from "../pathCollisionKey";
import { accountEmail } from "./accountEmails";
import { accessRuleSetBefore, currentAccessRuleSet } from "./accessRules";
import type { SqliteDb } from "./types";

export interface EvaluatedMemberReach {
  role: "admin" | "member";
  level: ShareAccess;
  rules: [string, ShareAccess | null][];
}

export interface MemberReach {
  evaluated: EvaluatedMemberReach;
  /** Whether the member holds `level` on some folder. */
  hasLevel(level: ShareAccess): boolean;
  /** The member's level in a Group. Every Group takes the member level for now. */
  groupLevel(channelWireId: string): ShareAccess;
  /** Whether the member holds `level` in some Group. */
  hasGroupLevel(level: ShareAccess): boolean;
  /**
   * Equal exactly when two evaluated reaches are. It names hidden folders, so
   * it stays in the relay: a member could test guesses against it.
   */
  signature(): string;
  /**
   * The signature a member is served on their pages: `signature`, keyed with
   * a relay secret and bound to this member, so a guess can't be tested.
   */
  keyedSignature(key: string | Uint8Array): string;
  levelAt(path: string): ShareAccess | null;
  folderLevel(folder: string): ShareAccess | null;
  /** Whether a current Main file is at or below this path. */
  pathExists(path: string): boolean;
  pathVisibleBeforeMoment(objectId: string, momentId: string, path: string): boolean;
  objectVisible(objectId: string): boolean;
  objectPath(objectId: string): string | null;
  nearestRule(path: string): string;
}

/**
 * The nearest folder over `path` that a rule or its case twin governs, or ""
 * for the root. It depends only on where rules are, so it's the same for every
 * member. It keeps the exact spelling: a twin hides, but only the exact
 * folder's own rule sets its level.
 */
export function nearestRuleFolder(rules: AccessRuleSet, path: string): string {
  let folder = accessRuleFolder(path);
  while (folder && !rules.folded.has(pathCollisionKey(folder))) folder = accessRuleFolder(folder);
  return folder;
}

/**
 * Build once inside the caller's read or committing transaction. `current`
 * passes rules already read in that transaction, so many members share a parse.
 */
export function memberReach(
  db: SqliteDb,
  workspaceId: string,
  userId: string,
  role: "admin" | "member",
  level: ShareAccess,
  current?: AccessRuleSet,
): MemberReach {
  const email = accountEmail(db, userId);
  const viewer: ReachViewer =
    role === "admin"
      ? { role }
      : {
          role,
          level,
          verifiedEmail: email?.verifiedEmail ?? null,
        };
  const knownRules = (rules: AccessRuleSet) =>
    email || role === "admin"
      ? rules
      : accessRuleSet(
          [...rules.exact].map(
            ([folder, rule]) => [folder, rule && rule.people.size === 0 ? rule : null] as const,
          ),
        );
  const rules = knownRules(current ?? currentAccessRuleSet(db, workspaceId));
  const levelAt = (path: string) => fileLevel(rules, viewer, path);
  const atFolder = (folder: string) => folderLevel(rules, viewer, folder);
  const parsedRules = new Map<string, AccessRule | null>();
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
        fileLevel(
          knownRules(accessRuleSetBefore(db, workspaceId, seq, parsedRules)),
          viewer,
          path!,
        ) !== null;
    }
    const result = { visible, path };
    objects.set(id, result);
    return result;
  };
  const signature = () =>
    createHash("sha256")
      .update(
        JSON.stringify([
          role,
          atFolder(""),
          [...rules.exact.keys()]
            .sort()
            .flatMap((folder) =>
              folder !== "" && atFolder(folder) === atFolder(accessRuleFolder(folder))
                ? []
                : [[folder, atFolder(folder)]],
            ),
        ]),
      )
      .digest("hex");
  return {
    evaluated: {
      role,
      level,
      rules: [...rules.exact].map(([folder, rule]) => [
        folder,
        viewer.role === "member" ? ruleLevel(rule, viewer) : "edit",
      ]),
    },
    hasLevel: (level) =>
      atFolder("") === level ||
      [...rules.exact.keys()].some((folder) => atFolder(folder) === level),
    groupLevel: () => level,
    hasGroupLevel: (wanted) => wanted === level,
    signature,
    keyedSignature: (key) =>
      createHmac("sha256", key)
        .update(JSON.stringify(["dohc/member-reach/v1", workspaceId, userId, signature()]))
        .digest("hex"),
    levelAt,
    folderLevel: atFolder,
    pathExists: (path) =>
      db
        .prepare(`SELECT 1 FROM sync_relay_current_files
        WHERE workspace_id = ? AND version_id = 'main' AND path = ?
        UNION ALL SELECT 1 FROM sync_relay_current_files
        WHERE workspace_id = ? AND version_id = 'main' AND path >= ? AND path < ? LIMIT 1`)
        .get(workspaceId, path, workspaceId, `${path}/`, `${path}0`) !== undefined,
    pathVisibleBeforeMoment: (objectId, momentId, path) => {
      const moment = db
        .prepare(`SELECT relay_seq FROM sync_relay_object_moments
        WHERE workspace_id = ? AND version_id = 'main' AND object_id = ? AND moment_id = ?
        ORDER BY relay_seq LIMIT 1`)
        .get(workspaceId, objectId, momentId);
      return (
        !!moment &&
        fileLevel(
          knownRules(accessRuleSetBefore(db, workspaceId, Number(moment.relay_seq), parsedRules)),
          viewer,
          path,
        ) !== null
      );
    },
    nearestRule: (path) => nearestRuleFolder(rules, path),
    objectVisible: (id) => object(id).visible,
    objectPath: (id) => object(id).path,
  };
}
