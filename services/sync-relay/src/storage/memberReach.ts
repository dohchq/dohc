import { createHash } from "node:crypto";
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
  revision: string;
  role: "admin" | "member";
  level: ShareAccess;
  rules: [string, ShareAccess | null][];
}

export interface MemberReach {
  evaluated: EvaluatedMemberReach;
  hasLevel(level: ShareAccess): boolean;
  refresh(): MemberReach;
  revision: string;
  signature(): string;
  levelAt(path: string): ShareAccess | null;
  folderLevel(folder: string): ShareAccess | null;
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
  // Settle compares this to decide whether reach changed. It names hidden
  // folders, so it stays a function: it never serializes into a selector or
  // reaches a member.
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
  // Only `settleMemberRevisions` writes revisions, at the end of each write
  // transaction, so a read takes the stored one as it is.
  const stored = db
    .prepare(
      "SELECT revision FROM sync_relay_member_revisions WHERE workspace_id = ? AND user_id = ?",
    )
    .get(workspaceId, userId);
  const revision = stored ? String(stored.revision) : "unsettled";
  return {
    evaluated: {
      revision,
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
    revision,
    signature,
    levelAt,
    folderLevel: atFolder,
    nearestRule: (path) => nearestRuleFolder(rules, path),
    refresh: () => memberReach(db, workspaceId, userId, role, level),
    objectVisible: (id) => object(id).visible,
    objectPath: (id) => object(id).path,
  };
}
