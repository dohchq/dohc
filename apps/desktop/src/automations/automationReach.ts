import { isSharedWithMePath } from "@dohc/workspace-core";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import type { RosterGrant } from "./shareRoster";

// The reach check (ADR 0012). An automation belongs to its Collection, and
// anyone who can edit the Collection can change the automation. So a step may
// reach only what every one of those editors can reach, and nobody gains
// access by writing one. This module is the rule, as set arithmetic over the
// share roster: the executor checks a run's steps before its first write, and
// the share dialog asks which steps a new share would stop.

/** What this computer knows about who can edit and reach what in a workspace. */
export type ReachRoster =
  // The owner's computer. A workspace that does not sync has no grants.
  | { kind: "owner"; ownerUserId: string | null; grants: readonly RosterGrant[] }
  // The owner's computer before dohc has listed the grants, or after the
  // relay listed a grant dohc cannot read.
  | { kind: "unknown"; cause: "not-listed" | "unreadable" }
  // A collaborator's computer. The relay tells a recipient only about their
  // own grant, so the other editors are unknown.
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
 * the steps; the executor maps each one here with names and people resolved.
 * Steps inside an If count like any other step.
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

function stop(reason: string): StepReach {
  return { allowed: false, reason };
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function covers(files: NonNullable<RosterGrant["files"]>, path: string): boolean {
  return files.paths.length === 0 || files.paths.some((granted) => within(path, granted));
}

// A grant pinned to a saved version counts toward who can edit, because the
// owner can switch this computer to that version. It gives no reach, because
// the check does not know which version the files are on. Both fail closed.
function canEdit(person: Person, path: string): boolean {
  return person.grants.some((grant) => grant.files?.access === "edit" && covers(grant.files, path));
}

function reaches(person: Person, path: string, access: "edit" | "view"): boolean {
  return person.grants.some(
    (grant) =>
      grant.files !== null &&
      grant.files.versionId === null &&
      (access === "view" || grant.files.access === "edit") &&
      covers(grant.files, path),
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

function checkStep(
  roster: ReachRoster,
  collection: ReachCollection,
  step: ReachStep,
  people: readonly Person[],
  editors: readonly Person[],
): StepReach {
  if (isSharedWithMePath(collection.path)) {
    return stop(`${collection.name} came to you through a share, so its automations cannot run.`);
  }
  const target = step.kind === "change-records" || step.kind === "find-records" ? step.collection : null;
  if (target && isSharedWithMePath(target.path)) {
    return stop(`${target.name} came to you through a share, so automations cannot use it.`);
  }
  if (target && within(target.path, collection.path)) return ALLOWED;
  if (roster.kind === "shared-view") {
    return stop(`In a shared view, automations can use only ${collection.name}.`);
  }
  if (roster.kind === "unknown") {
    return stop(
      roster.cause === "unreadable"
        ? "dohc could not read a share in this workspace. End it in Settings → Cloud, then try again."
        : `dohc has not checked who else can edit ${collection.name}. Connect to your server, then try again.`,
    );
  }
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
      if (step.person.userId !== roster.ownerUserId) {
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
  const people = roster.kind === "owner" ? peopleOf(roster) : [];
  const editors = people.filter((person) => canEdit(person, automation.collection.path));
  return automation.steps.map((step) => checkStep(roster, automation.collection, step, people, editors));
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
        grantId: "",
        recipientUserId: known?.recipientUserId ?? null,
        recipientEmail: known?.recipientEmail ?? share.recipientEmail,
        files: { paths: [...share.paths], versionId: share.versionId, access: share.access },
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
