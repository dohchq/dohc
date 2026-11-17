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

/**
 * A member's reach as their pages list it. A path takes the level of the
 * nearest listed folder at or above it, or the root's. The folders are each
 * ruled folder the member reaches at a level other than its parent's; the
 * root is never one. The desktop reads it as `ListedReach`, the engine as
 * `ShareReach`.
 */
export interface ListedMemberReach {
  /** Changes whenever the member's levels do. */
  signature: string;
  /** Changes only when what the member reaches does. */
  visibilitySignature: string;
  rootLevel: ShareAccess | null;
  folders: Array<{ path: string; level: ShareAccess }>;
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
   * Equal exactly when two reaches reach the same things, whatever their
   * levels. It names hidden folders too, so it stays in the relay.
   */
  visibilitySignature(): string;
  /**
   * The signature a member is served on their pages: `signature`, keyed with
   * a relay secret and bound to this member, so a guess can't be tested.
   */
  keyedSignature(key: string | Uint8Array): string;
  /** The reach a member's pages list, both signatures keyed as `keyedSignature` is. */
  listed(key: string | Uint8Array): ListedMemberReach;
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
  const digest = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const ruled = () => [...rules.exact.keys()].sort();
  const signature = () =>
    digest([
      role,
      atFolder(""),
      ruled().flatMap((folder) =>
        folder !== "" && atFolder(folder) === atFolder(accessRuleFolder(folder))
          ? []
          : [[folder, atFolder(folder)]],
      ),
    ]);
  // A hidden folder hides all under it, so reach can only stop at a ruled
  // folder. Reach is the same for every spelling of a folded name, so each
  // edge is named once by its folded name: a rule on a twin moves no edge.
  const reaches = (folder: string) => atFolder(folder) !== null;
  const visibilitySignature = () =>
    digest([
      role,
      reaches(""),
      [
        ...new Set(
          ruled()
            .filter(
              (folder) => folder !== "" && reaches(folder) !== reaches(accessRuleFolder(folder)),
            )
            .map(pathCollisionKey),
        ),
      ].sort(),
    ]);
  const keyed = (key: string | Uint8Array, tag: string, value: string) =>
    createHmac("sha256", key)
      .update(JSON.stringify([tag, workspaceId, userId, value]))
      .digest("hex");
  const keyedSignature = (key: string | Uint8Array) =>
    keyed(key, "dohc/member-reach/v1", signature());
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
    visibilitySignature,
    keyedSignature,
    listed: (key) => {
      const rootLevel = atFolder("");
      return {
        signature: keyedSignature(key),
        visibilitySignature: keyed(key, "dohc/member-visibility/v1", visibilitySignature()),
        rootLevel,
        // The folders `signature` names, less hidden ones.
        folders: ruled().flatMap((path) => {
          const level = path === "" ? null : atFolder(path);
          return level === null || level === atFolder(accessRuleFolder(path))
            ? []
            : [{ path, level }];
        }),
      };
    },
    levelAt,
    folderLevel: atFolder,
    nearestRule: (path) => nearestRuleFolder(rules, path),
    objectVisible: (id) => object(id).visible,
    objectPath: (id) => object(id).path,
  };
}
