import { pathCollisionKey } from "@dohc/workspace-contracts/path-floor";
import { accessRuleFolder, isAccessRuleRelatedPath } from "./accessRuleFiles";
import { SHARE_ACCESS_VALUES, shareAccessRank, type ShareAccess } from "./shareSelector";

export {
  ACCESS_RULE_FILE,
  accessRuleFolder,
  isAccessRulePath,
  isAccessRuleRelatedPath,
} from "./accessRuleFiles";

/**
 * A folder's access rule, read from the `access.yaml` inside it
 * (ADR 0017, docs/engineering/adr/0017-access-rules-live-in-the-folder.md).
 * `members` is the level for anyone with the Member role whom no person
 * entry names; null leaves them out, which hides the folder from them.
 * `people` is keyed by normalized email.
 */
export interface AccessRule {
  readonly members: ShareAccess | null;
  readonly people: ReadonlyMap<string, ShareAccess>;
}

export const ACCESS_RULE_MAX_BYTES = 64 * 1024;
export const ACCESS_RULE_MAX_PEOPLE = 1_000;
const MAX_EMAIL_CHARS = 320;

/** The one form rule keys and account emails are compared in (`normalizeEmail` in workspace-auth). */
export function normalizeRuleEmail(email: string): string {
  return email.trim().toLowerCase();
}

function looksLikeEmail(value: string): boolean {
  const at = value.indexOf("@");
  return (
    value.length <= MAX_EMAIL_CHARS &&
    at > 0 &&
    at === value.lastIndexOf("@") &&
    at < value.length - 1 &&
    !/\s/.test(value)
  );
}

interface Line {
  indent: number;
  key: string;
  value: string | null;
}

// A scalar: plain, or quoted with no escapes. Returns the scalar and the rest
// of the line, or null when it can't be read.
function readScalar(text: string, stopAtColon: boolean): { value: string; rest: string } | null {
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    if (end < 0) return null;
    const value = text.slice(1, end);
    if (quote === '"' && value.includes("\\")) return null;
    return { value, rest: text.slice(end + 1) };
  }
  let end = 0;
  while (end < text.length) {
    const char = text[end]!;
    if (stopAtColon && char === ":") break;
    if (char === "#" && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) break;
    end += 1;
  }
  const value = text.slice(0, end).replace(/[ \t]+$/, "");
  if (!value || /^[&*!|>%@`{[\]},?-]/.test(value)) return null;
  return { value, rest: text.slice(value.length) };
}

// YAML separates tokens with spaces and tabs only; any other space belongs to
// the scalar it sits in, so a no-break space can't pass for one.
const LINE_SKIPPED = /^[ \t]*(?:#|$)/;
// What may follow a value: nothing, or a comment after at least one space.
const LINE_END = /^(?:[ \t]*|[ \t]+#[\s\S]*)$/;

function readLine(raw: string): Line | null | "skip" {
  if (LINE_SKIPPED.test(raw)) return "skip";
  const indent = /^[ \t]*/.exec(raw)![0];
  if (indent.includes("\t")) return null;
  const key = readScalar(raw.slice(indent.length), true);
  if (!key || !key.rest.startsWith(":")) return null;
  const afterColon = key.rest.slice(1);
  if (afterColon !== "" && !/^[ \t]/.test(afterColon)) return null;
  if (LINE_END.test(afterColon)) return { indent: indent.length, key: key.value, value: null };
  const value = readScalar(afterColon.replace(/^[ \t]+/, ""), false);
  if (!value || !LINE_END.test(value.rest)) return null;
  return { indent: indent.length, key: key.value, value: value.value };
}

function readLevel(value: string | null): ShareAccess | null {
  return value !== null && (SHARE_ACCESS_VALUES as readonly string[]).includes(value)
    ? (value as ShareAccess)
    : null;
}

/**
 * Reads a rule, or null when it can't be read. An unreadable rule hides its
 * folder from members (fails closed), so anything outside this small format is
 * unreadable rather than guessed at: only `members` and `people`, exact level
 * words, no YAML anchors, tags, flow collections or multi-documents.
 */
export function parseAccessRule(text: string): AccessRule | null {
  if (new TextEncoder().encode(text).length > ACCESS_RULE_MAX_BYTES) return null;
  return parseFormattedAccessRule(text);
}

/**
 * Reads text `formatAccessRule` wrote. Its two-space indent and final newline
 * can take a rule under the size cap past it, so this reads without the cap.
 */
export function parseFormattedAccessRule(text: string): AccessRule | null {
  if (text.includes("\0")) return null;
  let members: ShareAccess | null = null;
  let sawMembers = false;
  let sawPeople = false;
  let inPeople = false;
  let peopleIndent: number | null = null;
  const people = new Map<string, ShareAccess>();
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    // YAML ends a line at a lone CR too. Reading on would let a comment hide
    // the line after it, so a rule with one is unreadable.
    if (raw.includes("\r")) return null;
    const line = readLine(raw);
    if (line === "skip") continue;
    if (!line) return null;
    if (line.indent === 0) {
      inPeople = false;
      if (line.key === "members" && !sawMembers) {
        members = readLevel(line.value);
        if (!members) return null;
        sawMembers = true;
      } else if (line.key === "people" && !sawPeople && line.value === null) {
        sawPeople = true;
        inPeople = true;
      } else {
        return null;
      }
      continue;
    }
    if (!inPeople) return null;
    peopleIndent ??= line.indent;
    if (line.indent !== peopleIndent) return null;
    const level = readLevel(line.value);
    if (!level || !looksLikeEmail(line.key)) return null;
    const email = normalizeRuleEmail(line.key);
    if (people.has(email) || people.size >= ACCESS_RULE_MAX_PEOPLE) return null;
    people.set(email, level);
  }
  return { members, people };
}

// An email as a key that reads back as itself: plain when it can be, else quoted.
function formatKey(email: string): string | null {
  for (const spelling of [email, `'${email}'`, `"${email}"`]) {
    const line = readLine(`  ${spelling}: view`);
    if (line && line !== "skip" && line.key === email) return spelling;
  }
  return null;
}

function sameRule(a: AccessRule, b: AccessRule): boolean {
  return (
    a.members === b.members &&
    a.people.size === b.people.size &&
    [...a.people].every(([email, level]) => b.people.get(email) === level)
  );
}

/**
 * The canonical text of a rule, or null when no text reads back as this rule.
 * Callers treat null as unreadable, which hides the folder.
 */
export function formatAccessRule(rule: AccessRule): string | null {
  const lines: string[] = [];
  if (rule.members) lines.push(`members: ${rule.members}`);
  if (rule.people.size > 0) {
    lines.push("people:");
    for (const email of [...rule.people.keys()].sort()) {
      const key = formatKey(email);
      if (key === null) return null;
      lines.push(`  ${key}: ${rule.people.get(email)}`);
    }
  }
  const text = lines.length ? `${lines.join("\n")}\n` : "";
  const reread = parseFormattedAccessRule(text);
  return reread && sameRule(reread, rule) ? text : null;
}

function lower(a: ShareAccess | null, b: ShareAccess | null): ShareAccess | null {
  if (a === null || b === null) return null;
  return shareAccessRank(a) <= shareAccessRank(b) ? a : b;
}

/**
 * Who is asking. Owners and admins always have Edit. A member carries their
 * member level and, when their account has one, its verified email; an
 * unverified email can only narrow what a rule gives them.
 */
export type ReachViewer =
  | { readonly role: "owner" | "admin" }
  | {
      readonly role: "member";
      readonly level: ShareAccess;
      readonly verifiedEmail: string | null;
      readonly unverifiedEmail: string | null;
    };

/**
 * The rules in one workspace Version. Each folder takes its level only from a
 * rule in exactly that folder. A rule in a folder spelled differently but one
 * place on some disk (case, Unicode form, trailing dots) can only hide it,
 * never widen it, so no spelling reaches a folder its twin hides.
 */
export interface AccessRuleSet {
  readonly exact: ReadonlyMap<string, AccessRule | null>;
  readonly folded: ReadonlyMap<string, readonly (AccessRule | null)[]>;
}

/** Builds a rule set from each ruled folder ("" for the root) and its rule; null is a rule that couldn't be read. */
export function accessRuleSet(
  entries: Iterable<readonly [string, AccessRule | null]>,
): AccessRuleSet {
  const exact = new Map<string, AccessRule | null>();
  const folded = new Map<string, (AccessRule | null)[]>();
  for (const [folder, rule] of entries) {
    exact.set(folder, rule);
    const key = pathCollisionKey(folder);
    folded.set(key, [...(folded.get(key) ?? []), rule]);
  }
  return { exact, folded };
}

/** The level one rule gives a member, or null when it leaves them out. */
export function ruleLevel(
  rule: AccessRule | null,
  viewer: Extract<ReachViewer, { role: "member" }>,
): ShareAccess | null {
  if (rule === null) return null;
  if (viewer.verifiedEmail !== null) {
    return rule.people.get(normalizeRuleEmail(viewer.verifiedEmail)) ?? rule.members;
  }
  const unverified =
    viewer.unverifiedEmail === null
      ? undefined
      : rule.people.get(normalizeRuleEmail(viewer.unverifiedEmail));
  return unverified === undefined ? rule.members : lower(unverified, rule.members);
}

function folderChain(folder: string): string[] {
  const chain = [""];
  if (folder === "") return chain;
  const segments = folder.split("/");
  for (let index = 1; index <= segments.length; index += 1)
    chain.push(segments.slice(0, index).join("/"));
  return chain;
}

/**
 * The level a viewer has in a folder, or null when it is hidden from them.
 * Rules apply from the root down, the folder's own included; each replaces
 * the level above it, and one that leaves the viewer out hides everything
 * below it.
 */
export function folderLevel(
  rules: AccessRuleSet,
  viewer: ReachViewer,
  folder: string,
): ShareAccess | null {
  if (viewer.role !== "member") return "edit";
  let level: ShareAccess | null = viewer.level;
  for (const ancestor of folderChain(folder)) {
    const twins = rules.folded.get(pathCollisionKey(ancestor));
    if (!twins) continue;
    if (twins.some((rule) => ruleLevel(rule, viewer) === null)) return null;
    const own = rules.exact.get(ancestor);
    if (own !== undefined) level = ruleLevel(own, viewer);
  }
  return level;
}

/** The level a viewer has on a file: its folder's, except that members never reach a rule file. */
export function fileLevel(
  rules: AccessRuleSet,
  viewer: ReachViewer,
  path: string,
): ShareAccess | null {
  if (viewer.role !== "member") return "edit";
  if (isAccessRuleRelatedPath(path)) return null;
  return folderLevel(rules, viewer, accessRuleFolder(path));
}
