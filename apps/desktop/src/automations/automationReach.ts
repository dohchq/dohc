import { isSharedWithMePath, stripWindowsAliasSuffix, validateUserMaterializePath } from "@dohc/workspace-core";
import type { ShareAccess } from "@dohc/security-contract/share-selector";

// The reach check (ADR 0012). An automation belongs to its Collection, and
// anyone who can edit its definition can change it. So a step may reach only
// what every one of those editors can reach, and nobody gains access by
// writing one. This module is the rule, as set arithmetic over the share
// roster: the executor checks a run's steps before its first write, and the
// share dialog asks which steps a new share would stop.
//
// Every doubt stops a step. Paths compare two ways for that reason. Deciding
// who is an editor ignores case and Windows name endings, so a grant spelled
// differently still makes its holder an editor. Deciding what an editor
// reaches compares exact paths, so a spelling never grants reach.

/** One grant on the roster, as the reach check reads it. */
export interface RosterGrant {
  // A claimed grant names an account. A pending invite names only an email.
  recipientUserId: string | null;
  recipientEmail: string | null;
  // The files the grant covers. A path covers itself and everything beneath
  // it. A grant with no paths covers a whole saved version, and no files
  // anyone can change. Null for a grant on a chat alone.
  files: { paths: readonly string[]; versionId: string | null; access: ShareAccess } | null;
  // The chat a Group or chat grant covers.
  channel: { wireId: string; canPost: boolean } | null;
}

/** Why the owner's computer does not know who can edit the workspace. */
export type RosterProblem =
  // No listing: the relay did not answer, or dohc could not ask it.
  | { kind: "unchecked"; next: string }
  // The relay listed a grant dohc cannot read.
  | { kind: "damaged-share"; recipientEmail: string | null }
  | { kind: "damaged-link" }
  // The relay answered, but not with a listing dohc can use.
  | { kind: "unusable-listing" };

/** What this computer knows about who can edit and reach what in a workspace. */
export type ReachRoster =
  // The owner's computer. A workspace that does not sync has no grants, and
  // its owner is this computer's person, whose account may be unknown.
  | { kind: "owner"; ownerUserId: string | null; grants: readonly RosterGrant[] }
  | { kind: "unknown"; problem: RosterProblem }
  // A collaborator's computer. The relay tells a recipient only about their
  // own grant, so the other editors are unknown. The recipient's grant bounds
  // every write here, so steps inside the Collection can run.
  | { kind: "shared-view" };

/** A Collection a step names: its workspace path and the name the UI shows. */
export interface ReachCollection {
  path: string;
  name: string;
}

/** A person a step names: a verified user id, and a name to show when the roster has no email for them. */
export interface ReachPerson {
  userId: string;
  name: string;
}

/**
 * One step as the reach check sees it. The file contract (PR #1240) defines
 * the steps; the executor maps each one here with names and people resolved
 * and paths as the engine lists them. Steps inside an If count like any
 * other step.
 */
export type ReachStep =
  // Set fields, add records, or change found records in `collection`.
  | { kind: "change-records"; collection: ReachCollection }
  | { kind: "find-records"; collection: ReachCollection }
  // `channelWireId` is null for a Group that has not synced yet.
  | { kind: "post"; group: { channelWireId: string | null; name: string } }
  | { kind: "notify"; person: ReachPerson }
  // A personal step, such as waking this person's agent.
  | { kind: "personal"; person: ReachPerson };

export interface ReachAutomation {
  id: string;
  collection: ReachCollection;
  // Workspace paths of the code files its run-file steps read. Whoever can
  // edit one of them can change what the automation does.
  codeFiles: readonly string[];
  steps: readonly ReachStep[];
}

export type StepReach = { allowed: true } | { allowed: false; reason: string };

/** A share the owner is about to create. */
export interface ReachShare {
  paths: readonly string[];
  versionId: string | null;
  access: ShareAccess;
  recipientEmail: string;
}

export interface StoppedStep {
  automationId: string;
  step: number;
  reason: string;
}

interface Person {
  userId: string | null;
  email: string | null;
  grants: RosterGrant[];
}

const ALLOWED: StepReach = { allowed: true };
const SETTINGS = "Settings → Sync and sharing";

function stop(reason: string): StepReach {
  return { allowed: false, reason };
}

// A path exactly as the engine lists it: relative, no "." or "..", forward
// slashes, and no name that Windows reads as another name. That last rule
// applies on every platform, because the workspace can sync to Windows.
function isCanonical(path: string): boolean {
  const checked = validateUserMaterializePath(path, { platform: "win32" });
  return checked.ok && checked.normalized === path &&
    path.split("/").every((segment) => stripWindowsAliasSuffix(segment) === segment);
}

// Why dohc cannot use a path a step names, or null.
function pathProblem(path: string, name: string, role: "source" | "target"): string | null {
  if (isSharedWithMePath(path)) {
    return role === "source"
      ? `${name} came to you through a share, so its automations cannot run.`
      : `${name} came to you through a share, so automations cannot use it.`;
  }
  return isCanonical(path) ? null : `"${path}" is not a path in this workspace.`;
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function looseKey(path: string): string {
  return path.split("/").map((segment) => stripWindowsAliasSuffix(segment).toLowerCase()).join("/");
}

function canEdit(person: Person, path: string): boolean {
  const key = looseKey(path);
  return person.grants.some(
    (grant) => grant.files?.access === "edit" && grant.files.paths.some((granted) => within(key, looseKey(granted))),
  );
}

function reaches(person: Person, path: string, access: "edit" | "view"): boolean {
  return person.grants.some(
    (grant) =>
      grant.files !== null &&
      grant.files.versionId === null &&
      (access === "view" || grant.files.access === "edit") &&
      grant.files.paths.some((granted) => within(path, granted)),
  );
}

function canPost(person: Person, channelWireId: string | null): boolean {
  return person.grants.some(
    (grant) => grant.channel !== null && grant.channel.wireId === channelWireId && grant.channel.canPost,
  );
}

// Everyone on the roster except the owner, one entry per person. A claimed
// grant names an account; a pending invite names only an email.
function peopleOf(roster: Extract<ReachRoster, { kind: "owner" }>): Person[] {
  const people = new Map<string, Person>();
  for (const grant of roster.grants) {
    if (grant.recipientUserId !== null && grant.recipientUserId === roster.ownerUserId) continue;
    const key = grant.recipientUserId === null
      ? `email:${grant.recipientEmail?.toLowerCase()}`
      : `user:${grant.recipientUserId}`;
    const person = people.get(key);
    if (person) {
      person.email ??= grant.recipientEmail;
      person.grants.push(grant);
    } else {
      people.set(key, { userId: grant.recipientUserId, email: grant.recipientEmail, grants: [grant] });
    }
  }
  return [...people.values()];
}

function nameOf(person: Person): string {
  return person.email ?? "Someone you shared with";
}

function problemReason(problem: RosterProblem, collection: ReachCollection): string {
  switch (problem.kind) {
    case "unchecked":
      return `dohc could not check who can edit ${collection.name}. ${problem.next}`;
    case "damaged-share":
      return problem.recipientEmail
        ? `dohc can't read what your share with ${problem.recipientEmail} grants. End it in ${SETTINGS}, then try again.`
        : `dohc can't read what one of your shares grants. End it in ${SETTINGS}, then try again.`;
    case "damaged-link":
      return "dohc can't read what one of your share links grants. End it from Share… on any file, then try again.";
    case "unusable-listing":
      return "dohc could not read this workspace's shares from your server. Try again later.";
  }
}

function checkOwnerStep(
  roster: Extract<ReachRoster, { kind: "owner" }>,
  collection: ReachCollection,
  step: ReachStep,
  people: readonly Person[],
  editors: readonly Person[],
): StepReach {
  switch (step.kind) {
    case "change-records": {
      const blocked = editors.find((person) => !reaches(person, step.collection.path, "edit"));
      return blocked ? stop(`${nameOf(blocked)} cannot edit ${step.collection.name}.`) : ALLOWED;
    }
    case "find-records": {
      const blocked = editors.find((person) => !reaches(person, step.collection.path, "view"));
      return blocked ? stop(`${nameOf(blocked)} cannot view ${step.collection.name}.`) : ALLOWED;
    }
    case "post": {
      const blocked = editors.find((person) => !canPost(person, step.group.channelWireId));
      return blocked ? stop(`${nameOf(blocked)} cannot post in ${step.group.name}.`) : ALLOWED;
    }
    case "notify": {
      if (step.person.userId === roster.ownerUserId) return ALLOWED;
      const person = people.find((candidate) => candidate.userId === step.person.userId);
      return person && reaches(person, collection.path, "view")
        ? ALLOWED
        : stop(`${person?.email ?? step.person.name} cannot view ${collection.name}.`);
    }
    case "personal": {
      // With no account known, the owner is this computer's person, and the
      // executor acts as that person.
      if (roster.ownerUserId !== null && step.person.userId !== roster.ownerUserId) {
        const person = people.find((candidate) => candidate.userId === step.person.userId);
        return stop(`This step acts as ${person?.email ?? step.person.name}, and you can also edit ${collection.name}.`);
      }
      const other = editors[0];
      return other ? stop(`This step acts as you, and ${nameOf(other)} can also edit ${collection.name}.`) : ALLOWED;
    }
  }
}

/** A verdict for each of the automation's steps, in order. */
export function checkAutomationReach(roster: ReachRoster, automation: ReachAutomation): StepReach[] {
  const { collection } = automation;
  const sources = [`${collection.path}/automations.yaml`, ...automation.codeFiles];
  const sourceProblem =
    pathProblem(collection.path, collection.name, "source") ??
    automation.codeFiles.map((path) => pathProblem(path, path, "target")).find((problem) => problem !== null) ??
    null;
  if (sourceProblem) return automation.steps.map(() => stop(sourceProblem));
  // On the owner's computer every step needs the roster, even a step inside
  // the Collection: someone with Edit on the definition alone is an editor
  // who cannot edit the Collection's records.
  if (roster.kind === "unknown") return automation.steps.map(() => stop(problemReason(roster.problem, collection)));
  const people = roster.kind === "owner" ? peopleOf(roster) : [];
  const editors = people.filter((person) => sources.some((path) => canEdit(person, path)));
  return automation.steps.map((step) => {
    const target = step.kind === "change-records" || step.kind === "find-records" ? step.collection : null;
    const targetProblem = target && pathProblem(target.path, target.name, "target");
    if (targetProblem) return stop(targetProblem);
    if (roster.kind === "owner") return checkOwnerStep(roster, collection, step, people, editors);
    return target && within(target.path, collection.path)
      ? ALLOWED
      : stop(`In a shared view, automations can use only ${collection.name}.`);
  });
}

/**
 * The steps that reach now and would stop if `share` were created. Only the
 * owner's computer creates shares, so any other roster changes nothing.
 */
export function shareImpactOf(
  roster: ReachRoster,
  share: ReachShare,
  automations: readonly ReachAutomation[],
): StoppedStep[] {
  if (roster.kind !== "owner") return [];
  const email = share.recipientEmail.toLowerCase();
  const known = roster.grants.find((grant) => grant.recipientEmail?.toLowerCase() === email);
  const after: ReachRoster = {
    ...roster,
    grants: [
      ...roster.grants,
      {
        recipientUserId: known?.recipientUserId ?? null,
        recipientEmail: known?.recipientEmail ?? share.recipientEmail,
        files: { paths: share.paths, versionId: share.versionId, access: share.access },
        channel: null,
      },
    ],
  };
  const stopped: StoppedStep[] = [];
  for (const automation of automations) {
    const before = checkAutomationReach(roster, automation);
    checkAutomationReach(after, automation).forEach((verdict, step) => {
      if (before[step]?.allowed && !verdict.allowed) {
        stopped.push({ automationId: automation.id, step, reason: verdict.reason });
      }
    });
  }
  return stopped;
}
