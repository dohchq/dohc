import { stripWindowsAliasSuffix } from "@dohc/workspace-contracts/workspace-paths";
import { SHARE_ACCESS_VALUES, shareAccessRank, type ShareAccess } from "./shareSelector";

/**
 * A folder's access rule, read from the `access.yaml` inside it
 * (docs/engineering/adr/0015-access-rules-live-in-the-folder.md).
 * `members` is the level for anyone with the Member role whom no person
 * entry names; null leaves them out, which hides the folder from them.
 * `people` is keyed by normalized email.
 */
export interface AccessRule {
  readonly members: ShareAccess | null;
  readonly people: ReadonlyMap<string, ShareAccess>;
}

export const ACCESS_RULE_FILE = "access.yaml";
export const ACCESS_RULE_MAX_BYTES = 64 * 1024;
export const ACCESS_RULE_MAX_PEOPLE = 1_000;
const MAX_EMAIL_CHARS = 320;

/**
 * One spelling for every way a filesystem may name the same path: Unicode
 * composed form, no Windows name endings, and case folded until it stops
 * changing, so "ſ" is "s" and "ẞ", "ß", and "ss" are one spelling.
 */
export function pathFoldKey(path: string): string {
  return path
    .normalize("NFC")
    .split("/")
    .map((segment) =>
      stripWindowsAliasSuffix(segment).toLowerCase().toUpperCase().toLowerCase().normalize("NFC"),
    )
    .join("/");
}

function lastSegmentKey(path: string): string {
  return pathFoldKey(path.slice(path.lastIndexOf("/") + 1));
}

/** Whether this file is a folder's rule, however the filesystem spells it. */
export function isAccessRulePath(path: string): boolean {
  return lastSegmentKey(path) === ACCESS_RULE_FILE;
}

/**
 * Whether this file is a rule or a copy of one: an editor's backup, swap or
 * temp file keeps the rule's emails, so members never see or write these either.
 */
export function isAccessRuleRelatedPath(path: string): boolean {
  return lastSegmentKey(path).includes(ACCESS_RULE_FILE);
}

/** The folder a rule file belongs to: "" for the workspace root. */
export function accessRuleFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

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
    if (char === "#" && (end === 0 || /\s/.test(text[end - 1]!))) break;
    end += 1;
  }
  const value = text.slice(0, end).trim();
  if (!value || /^[&*!|>%@`{[\]},?-]/.test(value)) return null;
  return { value, rest: text.slice(end) };
}

function isCommentOrBlank(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function readLine(raw: string): Line | null | "skip" {
  if (isCommentOrBlank(raw)) return "skip";
  const indent = raw.length - raw.trimStart().length;
  if (raw.slice(0, indent).includes("\t")) return null;
  const key = readScalar(raw.slice(indent), true);
  if (!key || !key.rest.startsWith(":")) return null;
  const afterColon = key.rest.slice(1);
  if (afterColon !== "" && !/^\s/.test(afterColon)) return null;
  if (isCommentOrBlank(afterColon)) return { indent, key: key.value, value: null };
  const value = readScalar(afterColon.trimStart(), false);
  if (!value || !isCommentOrBlank(value.rest)) return null;
  return { indent, key: key.value, value: value.value };
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
  if (new TextEncoder().encode(text).length > ACCESS_RULE_MAX_BYTES || text.includes("\0"))
    return null;
  let members: ShareAccess | null = null;
  let sawMembers = false;
  let sawPeople = false;
  let inPeople = false;
  let peopleIndent: number | null = null;
  const people = new Map<string, ShareAccess>();
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
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

/** The canonical text of a rule, which `parseAccessRule` reads back to the same rule. */
export function formatAccessRule(rule: AccessRule): string {
  const lines: string[] = [];
  if (rule.members) lines.push(`members: ${rule.members}`);
  if (rule.people.size > 0) {
    lines.push("people:");
    for (const email of [...rule.people.keys()].sort())
      lines.push(`  ${email}: ${rule.people.get(email)}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function lower(a: ShareAccess | null, b: ShareAccess | null): ShareAccess | null {
  if (a === null || b === null) return null;
  return shareAccessRank(a) <= shareAccessRank(b) ? a : b;
}

function levelForEmail(rule: AccessRule, email: string): ShareAccess | null {
  return rule.people.get(email) ?? rule.members;
}

/**
 * The rule that gives everyone the lower of what `a` and `b` give them. Used
 * when an admin's change meets an owner's unsent one, so neither widens.
 */
export function lowerRule(a: AccessRule, b: AccessRule): AccessRule {
  const members = lower(a.members, b.members);
  const people = new Map<string, ShareAccess>();
  for (const email of new Set([...a.people.keys(), ...b.people.keys()])) {
    const level = lower(levelForEmail(a, email), levelForEmail(b, email));
    // A person whose lower level is null is left out: `members` is then null too.
    if (level !== null && level !== members) people.set(email, level);
  }
  return { members, people };
}

/** Whether `next` gives nobody more than `previous` does. */
export function ruleOnlyNarrows(previous: AccessRule, next: AccessRule): boolean {
  if (lower(previous.members, next.members) !== next.members) return false;
  for (const email of new Set([...previous.people.keys(), ...next.people.keys()])) {
    const before = levelForEmail(previous, email);
    const after = levelForEmail(next, email);
    if (lower(before, after) !== after) return false;
  }
  return true;
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

/** Rules by `pathFoldKey` of their folder ("" for the root); null is a rule that couldn't be read. */
export type AccessRuleSet = ReadonlyMap<string, AccessRule | null>;

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
    const key = pathFoldKey(ancestor);
    if (!rules.has(key)) continue;
    level = ruleLevel(rules.get(key)!, viewer);
    if (level === null) return null;
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
