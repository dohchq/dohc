import { createHash } from "node:crypto";
import {
  NOTICE_BODY_MAX_CHARS,
  NOTICE_TITLE_MAX_CHARS,
  isNoticeTarget,
  type AutomationControlsTarget,
  type NoticeTarget,
} from "@dohc/workspace-contracts/relay";
import { cutText } from "./automationChat";

// The notice a failed run sends to this computer's person, who can try it
// again here. One notice per failure, so a failure that happens again is
// news again. The notice for an automation's newest failed run replaces the
// one before it on this computer.

// Mirrors of crates/dohc-engine-domain/src/automations.rs: the chain depth
// cap, and the failure reasons the engine records for a chain stop and for a
// run that did not finish.
const AUTOMATION_CHAIN_DEPTH_CAP = 4;
/** The failure a claim at the chain depth cap is inserted with, in the engine and the dataset ledger. */
export const AUTOMATION_CHAIN_STOPPED = "chain-stopped";
const AUTOMATION_RECLAIM_EXHAUSTED = "reclaim-exhausted";

// The copy for everyone but this computer's person. It leaves out the
// computer's name and the step's error, which can name what only this
// person can see.
export const FAILED_ELSEWHERE_BODY = "It ran on another person's computer, so only they can try it again.";
const NEVER_STARTED_ELSEWHERE_BODY = "It could not start on another person's computer, so no one can try it again.";

/** An automation's newest failed claim, from the engine or the dataset ledger. */
export interface AutomationFailure {
  automationId: string;
  /** The claim Try again runs. */
  claimId: string;
  /** It failed before it started, as a chain stop or a change too large to claim, so no Try again can run it. */
  neverStarted: boolean;
  /** The chain depth cap stopped it before it started. */
  chainStopped: boolean;
  error: string;
  updatedAtMs: number;
  /** How many times the automation's claims have failed here. It only grows. */
  generation: number;
  /** A dataset automation's failures count per instance of its dataset; null for a document Collection. */
  datasetInstance: string | null;
  switchedOff?: AutomationCircuitBreaker;
}

/** The successful switch-off saved before this failure is reported. */
export interface AutomationCircuitBreaker {
  reason: "consecutive-timeouts";
  collectionPath: string;
}

export function automationControlsTarget(automationId: string, collectionPath: string): AutomationControlsTarget {
  return { recovery: "automation-controls", automation: automationId, path: `${collectionPath}/automations.yaml` };
}

export const AUTOMATION_SWITCHED_OFF_BODY =
  "dohc switched this automation off after 3 runs in a row took too long. Open the automation to turn it back on.";

export const AUTOMATION_SWITCHED_OFF_EDIT_BODY =
  "dohc switched this automation off after 3 runs in a row took too long. Open its automations file to turn it back on.";

export const AUTOMATION_SWITCHED_OFF_VIEW_BODY =
  "dohc switched this automation off after 3 runs in a row took too long. Ask someone who can edit the Collection to turn it back on.";

/** The relay chooses the next step from the recipient's current permission. */
export function automationFailureBodyForPermission(body: string, canEdit: boolean, isOwner: boolean): string {
  const next = isOwner ? AUTOMATION_SWITCHED_OFF_BODY : canEdit ? AUTOMATION_SWITCHED_OFF_EDIT_BODY : AUTOMATION_SWITCHED_OFF_VIEW_BODY;
  return body.startsWith(AUTOMATION_SWITCHED_OFF_BODY)
    ? cutText(next + body.slice(AUTOMATION_SWITCHED_OFF_BODY.length), NOTICE_BODY_MAX_CHARS)
    : body;
}

/** The computer that ran the automation. Only it holds the run, so only it can try the run again. */
export interface FailureComputer {
  installId: string;
  label: string;
}

export interface AutomationFailedNotice {
  workspaceId: string;
  noticeId: string;
  kind: "automation-failed";
  title: string;
  body: string;
  target: NoticeTarget & { automation: string };
}

/**
 * The key a computer records its reported failures under: the automation,
 * and for a dataset automation the dataset instance its count belongs to.
 */
export function automationFailureKey(failure: Pick<AutomationFailure, "automationId" | "datasetInstance">): string {
  return failure.datasetInstance === null ? failure.automationId : `${failure.automationId}@${failure.datasetInstance}`;
}

/** The failure a notice reports: the run it names, and the count when it failed. */
export type ReportedRun = Pick<AutomationFailure, "automationId" | "datasetInstance" | "claimId" | "generation">;

/**
 * Different for each computer, run, and failure count, because each
 * computer counts its own failures and a run can fail again.
 */
export function automationFailedNoticeId(input: {
  workspaceId: string;
  installId: string;
  failure: ReportedRun;
}): string {
  const { workspaceId, installId, failure } = input;
  const digest = createHash("sha256")
    .update(JSON.stringify([workspaceId, installId, automationFailureKey(failure), failure.claimId, failure.generation]))
    .digest("hex");
  return `automation-failed:${digest.slice(0, 40)}`;
}

// Control characters other than a line feed or tab would make the relay
// refuse the notice.
function plain(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ");
}

function sentence(text: string): string {
  const trimmed = plain(text).trim();
  if (trimmed.length === 0) return "The automation failed.";
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

// Open goes to its Collection's automations.yaml, where the Collection is now.
function automationTarget(automationId: string, collectionPath: string | null, claimId: string | null): AutomationFailedNotice["target"] {
  const path = collectionPath === null ? undefined : `${collectionPath}/automations.yaml`;
  const target = {
    automation: automationId,
    ...{ path },
    ...(claimId !== null ? { run: claimId } : {}),
  };
  return isNoticeTarget(target) ? target : { automation: automationId, ...(claimId !== null ? { run: claimId } : {}) };
}

// The automation as a notice names it, in quotes, within `room` characters.
function quotedName(failure: AutomationFailure, name: string | null, room: number): string {
  const shown = plain(name ?? /#([^#]+)$/u.exec(failure.automationId)?.[1] ?? failure.automationId).trim() || "An automation";
  return `"${cutText(shown, Math.max(1, room - 2))}"`;
}

// Why a chain stop ran nothing, and what to check. It names nothing private.
const CHAIN_STOPPED_WHY = `dohc stops a chain after automations and agents start each other ${AUTOMATION_CHAIN_DEPTH_CAP} times in a row. ` +
  "Check which automations start each other.";
/** Why a press at the chain depth cap ran nothing, as the pressing window shows it. */
export const CHAIN_STOPPED_PRESS = `This press did not run. ${CHAIN_STOPPED_WHY}`;

// Why a chain stop's automation did not run, for every person told.
function chainStopped(failure: AutomationFailure, name: string | null): string {
  return `${quotedName(failure, name, NOTICE_TITLE_MAX_CHARS)} did not run. ${CHAIN_STOPPED_WHY}`;
}

/**
 * One failure as a notice: what happened, why when the ledger recorded a
 * known reason, and where. The two engine reasons get their own sentences;
 * any other error is the step's own text. A run that never started offers
 * no Try again, since none can run it.
 */
export function automationFailedNotice(input: {
  workspaceId: string;
  computer: FailureComputer;
  failure: AutomationFailure;
  /** The automation's name in its automations.yaml, when dohc can read it. */
  name: string | null;
  /** Where its Collection is now, or null when this computer no longer has it. */
  collectionPath: string | null;
}): AutomationFailedNotice {
  const { workspaceId, computer, failure } = input;
  const quoted = (room: number) => quotedName(failure, input.name, room);
  const count = failure.generation > 1 ? `${failure.generation} failures so far. ` : "";
  const label = plain(computer.label).trim() || "another computer";
  const where = failure.neverStarted ? ` This happened on ${label}.` : ` It ran on ${label}.`;
  let title: string;
  let what: string;
  if (failure.switchedOff !== undefined) {
    title = `Automation ${quoted(NOTICE_TITLE_MAX_CHARS - "Automation  switched off".length)} switched off`;
    const detail = failure.error.startsWith(AUTOMATION_SWITCHED_OFF_BODY)
      ? failure.error.slice(AUTOMATION_SWITCHED_OFF_BODY.length).trim() : failure.error;
    what = `${AUTOMATION_SWITCHED_OFF_BODY}${detail ? ` ${sentence(detail)}` : ""}`;
  } else if (failure.chainStopped && (failure.datasetInstance === null || failure.error === AUTOMATION_CHAIN_STOPPED)) {
    title = "An automation chain stopped";
    what = chainStopped(failure, input.name);
  } else if (failure.error === AUTOMATION_RECLAIM_EXHAUSTED) {
    title = `Automation ${quoted(NOTICE_TITLE_MAX_CHARS - "Automation  did not finish".length)} did not finish`;
    what = "dohc stopped retrying a run that did not finish.";
  } else {
    title = `Automation ${quoted(NOTICE_TITLE_MAX_CHARS - "Automation  failed".length)} failed`;
    const reason = failure.datasetInstance !== null && failure.chainStopped
      ? failure.error === "claim-limit" ? "This change triggered too many automation runs. Make a smaller change."
        : failure.error === "record-id-too-long" ? "This record's ID is too long for an automation run. Use a shorter ID."
          : `The automation could not read this change. ${failure.error || "Check the Collection's records."}`
      : failure.error;
    what = sentence(reason);
  }
  const room = NOTICE_BODY_MAX_CHARS - [...count].length - [...where].length;
  const controls = failure.switchedOff === undefined ? null : {
    ...automationControlsTarget(failure.automationId, input.collectionPath ?? failure.switchedOff.collectionPath), run: failure.claimId,
  };
  return {
    workspaceId,
    noticeId: automationFailedNoticeId({ workspaceId, installId: computer.installId, failure }),
    kind: "automation-failed",
    title,
    body: failure.switchedOff === undefined ? `${count}${cutText(what, room)}${where}` :
      `${cutText(what, NOTICE_BODY_MAX_CHARS - [...where].length)}${where}`,
    target: controls !== null && isNoticeTarget(controls) ? controls
      : automationTarget(failure.automationId, controls === null ? input.collectionPath : null, failure.neverStarted ? null : failure.claimId),
  };
}

/**
 * The body the other people involved get, in place of the step's error and
 * the computer's name. It promises a retry only when one can run.
 */
export function automationFailedElsewhereBody(failure: AutomationFailure, name: string | null): string {
  if (failure.switchedOff !== undefined) return AUTOMATION_SWITCHED_OFF_BODY;
  if (failure.chainStopped) return chainStopped(failure, name);
  return failure.neverStarted ? NEVER_STARTED_ELSEWHERE_BODY : FAILED_ELSEWHERE_BODY;
}
