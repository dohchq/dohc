import { isSharedWithMePath, stripWindowsAliasSuffix, validateUserMaterializePath } from "@dohc/workspace-core";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import type { ShareAccess } from "@dohc/security-contract/share-selector";

// The reach check (ADR 0012). An automation belongs to its Collection, and
// anyone who can edit its definition can change it. So a step may reach only
// what every one of those editors can reach, and nobody gains access by
// writing one. This module is the rule, as set arithmetic over the share
// roster: the executor checks a run's steps before its first write, and the
// share dialog asks which steps a new share would stop.
//
// Every doubt stops a step. Paths compare two ways for that reason. Deciding
// who is an editor ignores Unicode form, case, and Windows name endings, so a
// grant spelled differently still makes its holder an editor. Deciding what an
// editor reaches compares exact paths, so a spelling never grants reach.

/** One grant on the roster, as the reach check reads it. */
export interface RosterGrant {
  // The share grant's id. A named person's data grants on a shared dataset
  // are keyed by it with their account.
  grantId: string;
  // A claimed grant names an account. A pending invite names only an email.
  // A share link names neither: whoever holds it is one editor, the link.
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
  | { kind: "unusable-listing" }
  // The relay is older than this dohc and leaves out what the check needs.
  | { kind: "outdated-server" };

/**
 * A grant that wrote a Collection's automations directly (ADR 0013) and can
 * no longer edit them: revoked, or narrowed below Edit. `holder` says
 * whether a named person or a share link held it; a person's email may be
 * unknown. What it
 * wrote may still be there, and this computer may never have checked it
 * while the grant could edit, as when the owner revoked it from another
 * computer before this one pulled. So a step it could not have run waits
 * for a current editor once, as if its holder had just left (ADR 0012).
 * `generation` is the newest grant generation it wrote automations under,
 * so a later editing period of the same grant is new evidence. `files` is
 * the scope the grant covered, read as Edit.
 */
export interface FormerEditor {
  grantId: string;
  generation: number;
  holder: "person" | "link";
  recipientEmail: string | null;
  files: { paths: readonly string[]; versionId: string | null };
}

/** What this computer knows about who can edit and reach what in a workspace. */
export type ReachRoster =
  // The owner's computer. A workspace that does not sync has no grants, and
  // its owner is this computer's person, whose account may be unknown. In a
  // workspace proved never shared, `localPersonId` is this computer's own id
  // for that person, which names them with or without an account.
  | { kind: "owner"; ownerUserId: string | null; localPersonId?: string; grants: readonly RosterGrant[]; formerEditors?: readonly FormerEditor[] }
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
export type ReachStep = (
  | { kind: "unavailable"; reason: string }
  // Set fields, add records, or change found records in `collection`.
  | { kind: "change-records"; collection: ReachCollection }
  | { kind: "find-records"; collection: ReachCollection }
  // Find, add, or change records in a dataset through one of its approved
  // operations. File Edit on a dataset grants no record access: every other
  // editor must hold a current data grant that lists the operation, and an
  // operation only the owner can use needs the owner to be the only editor.
  | { kind: "dataset-operation"; collection: ReachCollection; datasetId: string; operation: ReachDatasetOperation; grants: ReachDatasetGrants }
  // A dataset field an automation's formulas may see: only while every other
  // editor holds a data grant on a read that shows it. A stopped field is
  // hidden from formulas; it does not stop the run.
  | { kind: "dataset-field"; collection: ReachCollection; datasetId: string; tableId: string; field: { fieldId: string; name: string }; reads: readonly ReachDatasetOperation[]; grants: ReachDatasetGrants }
  // `channelWireId` is null for a Group that has not synced yet.
  | { kind: "post"; group: { channelWireId: string | null; name: string } }
  // A Group whose messages start the automation: every editor must be able
  // to read it, so nobody copies a Group they cannot read into the Collection.
  | { kind: "read-group"; group: { channelWireId: string | null; name: string } }
  | { kind: "notify"; person: ReachPerson }
  // A personal step, such as waking this person's agent.
  | { kind: "personal"; person: ReachPerson }
) & { /** Retains a static step's existing hold identity when storage-specific checks expand. */ identity?: string };

/** A dataset operation a step invokes. */
export interface ReachDatasetOperation {
  operationId: string;
  name: string;
  access: "owner" | "helper" | "link";
}

/** A dataset's current data grants: the operations each principal may use. */
export interface ReachDatasetGrants {
  workspaceId: string;
  grants: ReadonlyArray<{ principalKey: string; operationIds: readonly string[] }>;
}

export interface ReachAutomation {
  id: string;
  collection: ReachCollection;
  // Workspace paths of the code files its run-file steps read. Whoever can
  // edit one of them can change what the automation does.
  codeFiles: readonly string[];
  steps: readonly ReachStep[];
}

// `person` names the editor whose reach stopped the step, when one did.
// `formerStops` are the former links that could have written the step and
// could not have run it: it waits for a current editor once for each
// `evidence`, a link and the generation it last wrote automations under.
export type StepReach =
  | { allowed: true; formerStops?: ReadonlyArray<{ evidence: string; name: string }> }
  | { allowed: false; reason: string; person?: string };

/**
 * A share the owner is about to create. `recipientEmail` is null for a
 * link: whoever opens it is someone the roster does not list yet.
 */
export interface ReachShare {
  paths: readonly string[];
  versionId: string | null;
  access: ShareAccess;
  recipientEmail: string | null;
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
  // The name that tells this editor apart when an email cannot: a share
  // link, or a former editor dohc has no email for.
  link?: { name: string };
}

const ALLOWED: StepReach = { allowed: true };
const SETTINGS = "Settings → Sync and sharing";

function stop(reason: string, person?: string): StepReach {
  return person === undefined ? { allowed: false, reason } : { allowed: false, reason, person };
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

// One spelling for every way a filesystem may name the same path: Unicode
// composed form, no Windows name endings, and case folded until it stops
// changing, so "ſ" is "s" and "ẞ", "ß", and "ss" are one spelling.
function looseKey(path: string): string {
  return path
    .normalize("NFC")
    .split("/")
    .map((segment) => stripWindowsAliasSuffix(segment).toLowerCase().toUpperCase().toLowerCase().normalize("NFC"))
    .join("/");
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

// Whether a person holds a current data grant, through any of their share
// grants, whose operations pass `lists`. A pending invite has no account,
// so no grant can be theirs yet.
function holdsDatasetGrant(person: Person, grants: ReachDatasetGrants, lists: (operationIds: readonly string[]) => boolean): boolean {
  if (person.userId === null) return false;
  const keys = new Set(person.grants.map((grant) => datasetPrincipalKey(grants.workspaceId, grant.grantId, person.userId!)));
  return grants.grants.some((grant) => keys.has(grant.principalKey) && lists(grant.operationIds));
}

function canPost(person: Person, channelWireId: string | null): boolean {
  return person.grants.some(
    (grant) => grant.channel !== null && grant.channel.wireId === channelWireId && grant.channel.canPost,
  );
}

// Everyone on the roster except the owner, one entry per person. A claimed
// grant names an account; a pending invite names only an email. Each share
// link is its own editor, keyed by its grant, whoever made it or opened it:
// a person who opened it in dohc holds a grant of their own.
function peopleOf(roster: Extract<ReachRoster, { kind: "owner" }>): Person[] {
  const people = new Map<string, Person>();
  for (const grant of roster.grants) {
    if (grant.recipientUserId !== null && grant.recipientUserId === roster.ownerUserId) continue;
    if (grant.recipientUserId === null && grant.recipientEmail === null) {
      people.set(`link:${grant.grantId}`, linkPerson(grant, "Anyone with your share link"));
      continue;
    }
    const key = grant.recipientUserId !== null
      ? `user:${grant.recipientUserId}`
      : `email:${grant.recipientEmail!.toLowerCase()}`;
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

// A link names the first path it shares, so two links read apart.
function linkPerson(grant: RosterGrant, who: string): Person {
  const path = grant.files?.paths[0];
  return { userId: null, email: null, grants: [grant], link: { name: path ? `${who} to ${path}` : who } };
}

// The former editors that could have written any of `sources`, each on its
// own, as the editor that grant made them. A named one is not joined with
// the same person's current grants.
function formerEditorsOf(roster: ReachRoster, sources: readonly string[]): Array<Person & { evidence: string }> {
  if (roster.kind !== "owner") return [];
  return (roster.formerEditors ?? [])
    .map((former) => {
      const grant: RosterGrant = {
        grantId: former.grantId, recipientUserId: null, recipientEmail: former.recipientEmail,
        files: { ...former.files, access: "edit" }, channel: null,
      };
      const path = former.files.paths[0];
      const person: Person = former.holder === "link"
        ? linkPerson(grant, "Anyone who had your share link")
        : {
            userId: null, email: former.recipientEmail, grants: [grant],
            // A person dohc has no email for is named by what they had.
            ...(former.recipientEmail === null ? { link: { name: path ? `Someone you shared ${path} with` : "Someone you shared with" } } : {}),
          };
      return { evidence: `${former.grantId}#${former.generation}`, ...person };
    })
    .filter((person) => sources.some((path) => canEdit(person, path)));
}

function nameOf(person: Person): string {
  return person.link?.name ?? person.email ?? "Someone you shared with";
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
    case "outdated-server":
      return `dohc could not check who can edit ${collection.name} because your server is older than this version of dohc. Update your server, then try again.`;
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
    case "unavailable": return stop(step.reason);
    case "change-records": {
      const blocked = editors.find((person) => !reaches(person, step.collection.path, "edit"));
      return blocked ? stop(`${nameOf(blocked)} cannot edit ${step.collection.name}.`, nameOf(blocked)) : ALLOWED;
    }
    case "find-records": {
      const blocked = editors.find((person) => !reaches(person, step.collection.path, "view"));
      return blocked ? stop(`${nameOf(blocked)} cannot view ${step.collection.name}.`, nameOf(blocked)) : ALLOWED;
    }
    case "dataset-operation": {
      const other = editors[0];
      if (other === undefined) return ALLOWED;
      const { operation, collection: target } = step;
      if (operation.access === "owner") {
        return stop(`Only you can use ${operation.name} in ${target.name}, and ${nameOf(other)} can also edit these automations.`, nameOf(other));
      }
      const blocked = editors.find((person) => !holdsDatasetGrant(person, step.grants, (operationIds) => operationIds.includes(operation.operationId)));
      return blocked ? stop(`${nameOf(blocked)} has no grant to use ${operation.name} in ${target.name}.`, nameOf(blocked)) : ALLOWED;
    }
    case "dataset-field": {
      const { field, reads, collection: target } = step;
      const blocked = editors.find((person) => !reads.some((read) => holdsDatasetGrant(person, step.grants, (operationIds) => operationIds.includes(read.operationId))));
      return blocked ? stop(`${nameOf(blocked)} cannot read ${field.name} in ${target.name}, so formulas do not see it.`, nameOf(blocked)) : ALLOWED;
    }
    case "post": {
      const blocked = editors.find((person) => !canPost(person, step.group.channelWireId));
      return blocked ? stop(`${nameOf(blocked)} cannot post in ${step.group.name}.`, nameOf(blocked)) : ALLOWED;
    }
    case "notify": {
      if (step.person.userId === roster.ownerUserId || step.person.userId === roster.localPersonId) return ALLOWED;
      const person = people.find((candidate) => candidate.userId === step.person.userId);
      return person && reaches(person, collection.path, "view")
        ? ALLOWED
        : stop(`${person?.email ?? step.person.name} cannot view ${collection.name}.`);
    }
    case "read-group": {
      const blocked = editors.find((person) =>
        !person.grants.some((grant) => grant.channel !== null && grant.channel.wireId === step.group.channelWireId));
      return blocked ? stop(`${nameOf(blocked)} cannot read ${step.group.name}.`, nameOf(blocked)) : ALLOWED;
    }
    case "personal": {
      // A personal step acts as its person, so it must name this computer's
      // person: by their account, or by this computer's own id for them in a
      // workspace nobody else ever had a part in. Naming anyone else with no
      // account known, dohc cannot tell who the step names, so it runs for
      // nobody.
      const local = roster.localPersonId !== undefined && step.person.userId === roster.localPersonId;
      if (!local && roster.ownerUserId === null) return stop(PERSONAL_NEEDS_ACCOUNT);
      if (!local && step.person.userId !== roster.ownerUserId) {
        const person = people.find((candidate) => candidate.userId === step.person.userId);
        return stop(`This step acts as ${person?.email ?? step.person.name}, and you can also edit ${collection.name}.`);
      }
      const other = editors[0];
      return other ? stop(`This step acts as you, and ${nameOf(other)} can also edit ${collection.name}.`) : ALLOWED;
    }
  }
}

/**
 * What a step's verdict and its confirmation are keyed by. A document step
 * is its place in the automation, which only an edit of the automation can
 * move. Dataset operations and fields include their destination identity,
 * so matching names in different Collections cannot share a verdict.
 */
export function reachStepId(step: ReachStep, index: number): string {
  if (step.identity !== undefined) return step.identity;
  switch (step.kind) {
    case "dataset-operation":
      return JSON.stringify(["operation", step.datasetId, step.operation.operationId]);
    case "dataset-field":
      return JSON.stringify(["field", step.datasetId, step.tableId, step.field.fieldId]);
    default:
      return String(index);
  }
}

/** A formula-visible field belongs to one dataset and table. */
export function datasetFieldKey(datasetId: string, tableId: string, fieldId: string): string {
  return JSON.stringify([datasetId, tableId, fieldId]);
}

export const PERSONAL_NEEDS_ACCOUNT =
  "Sign in to your server so dohc knows who you are. A step that acts as you runs only then.";

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
  const editors = editorsOf(people, sources);
  // Formulas and code read the Collection's records, so everyone who can
  // change them, even through automations.yaml or a code file alone, must
  // be able to view the Collection. A step that stops for its own reason
  // keeps that reason.
  const blind = editors.find((person) => !reaches(person, collection.path, "view"));
  const unseen = blind && stop(`${nameOf(blind)} cannot view ${collection.name}.`, nameOf(blind));
  const former = formerEditorsOf(roster, sources);
  const checkStep = (step: ReachStep): StepReach => {
    const target = step.kind === "change-records" || step.kind === "find-records" || step.kind === "dataset-operation" || step.kind === "dataset-field" ? step.collection : null;
    const targetProblem = target && pathProblem(target.path, target.name, "target");
    if (targetProblem) return stop(targetProblem);
    if (roster.kind === "owner") {
      const reach = checkOwnerStep(roster, collection, step, people, editors);
      if (!reach.allowed || former.length === 0) return reach;
      // Every current editor passed, so each former link is checked alone.
      const formerStops = former
        .filter((link) => !checkOwnerStep(roster, collection, step, people, [link]).allowed)
        .map((link) => ({ evidence: link.evidence, name: nameOf(link) }));
      return formerStops.length === 0 ? reach : { allowed: true, formerStops };
    }
    if (step.kind === "dataset-operation" || step.kind === "dataset-field") return stop(`In a shared view, automations cannot use ${collection.name}'s records.`);
    return target && within(target.path, collection.path)
      ? ALLOWED
      : stop(`In a shared view, automations can use only ${collection.name}.`);
  };
  return automation.steps.map((step) => {
    const verdict = checkStep(step);
    return verdict.allowed && unseen ? unseen : verdict;
  });
}

/** The people other than the owner who can edit any of `sources`. */
function editorsOf(people: readonly Person[], sources: readonly string[]): Person[] {
  return people.filter((person) => sources.some((path) => canEdit(person, path)));
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
  const email = share.recipientEmail?.toLowerCase();
  const known = email === undefined ? undefined : roster.grants.find((grant) => grant.recipientEmail?.toLowerCase() === email);
  const after: ReachRoster = {
    ...roster,
    grants: [
      ...roster.grants,
      {
        grantId: known?.grantId ?? "",
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
