import { createHash } from "node:crypto";
import {
  NOTICE_BODY_MAX_CHARS,
  NOTICE_TARGET_FIELD_MAX_CHARS,
  NOTICE_TITLE_MAX_CHARS,
} from "@dohc/workspace-contracts/relay";
import { cutText } from "./automationChat";

// The notice a failed run sends to this computer's person, who can try it
// again here. One notice per failure, so a failure that happens again is
// news again. The notice for an automation's newest failed run replaces the
// one before it on this computer.

// Mirrors of crates/dohc-engine-domain/src/automations.rs: the chain depth
// cap, and the failure reason the engine records for a run that did not
// finish. A chain stop is a flag on the failure, not a reason text.
const AUTOMATION_CHAIN_DEPTH_CAP = 4;
const AUTOMATION_RECLAIM_EXHAUSTED = "reclaim-exhausted";

/** An automation's newest failed claim, from the engine or the dataset ledger. */
export interface AutomationFailure {
  automationId: string;
  /** The claim Try again runs. */
  claimId: string;
  /** It never ran, as a chain stop, so no Try again can run it. */
  chainStopped: boolean;
  error: string;
  updatedAtMs: number;
  /** How many times the automation's claims have failed here. It only grows. */
  generation: number;
  /** A dataset automation's failures count per instance of its dataset; null for a document Collection. */
  datasetInstance: string | null;
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
  target: { automation: string; path?: string; run?: string };
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

// A Collection automation's engine id is "collection:<collection path>#<id>".
// Open goes to its Collection's automations.yaml.
function automationTarget(automationId: string, claimId: string | null): AutomationFailedNotice["target"] {
  const collection = /^collection:(.+)#[^#]+$/u.exec(automationId)?.[1];
  const path = collection === undefined ? undefined : `${collection}/automations.yaml`;
  return {
    automation: automationId,
    ...(path !== undefined && [...path].length <= NOTICE_TARGET_FIELD_MAX_CHARS ? { path } : {}),
    ...(claimId !== null ? { run: claimId } : {}),
  };
}

/**
 * One failure as a notice: what happened, why when the engine recorded a
 * known reason, and where it ran. The two engine reasons get their own
 * sentences; any other error is the step's own text. A chain stop never
 * ran, so it offers no Try again.
 */
export function automationFailedNotice(input: {
  workspaceId: string;
  computer: FailureComputer;
  failure: AutomationFailure;
  /** The automation's name in its automations.yaml, when dohc can read it. */
  name: string | null;
}): AutomationFailedNotice {
  const { workspaceId, computer, failure } = input;
  const name = plain(input.name ?? /#([^#]+)$/u.exec(failure.automationId)?.[1] ?? failure.automationId).trim() || "An automation";
  const quoted = (room: number) => `"${cutText(name, Math.max(1, room - 2))}"`;
  const count = failure.generation > 1 ? `${failure.generation} failures so far. ` : "";
  const where = ` It ran on ${plain(computer.label).trim() || "another computer"}.`;
  let title: string;
  let what: string;
  if (failure.chainStopped) {
    title = "An automation chain stopped";
    what = `dohc stops a chain of automations after ${AUTOMATION_CHAIN_DEPTH_CAP} steps, so ${quoted(NOTICE_TITLE_MAX_CHARS)} did not run.`;
  } else if (failure.error === AUTOMATION_RECLAIM_EXHAUSTED) {
    title = `Automation ${quoted(NOTICE_TITLE_MAX_CHARS - "Automation  did not finish".length)} did not finish`;
    what = "dohc stopped retrying a run that did not finish.";
  } else {
    title = `Automation ${quoted(NOTICE_TITLE_MAX_CHARS - "Automation  failed".length)} failed`;
    what = sentence(failure.error);
  }
  const room = NOTICE_BODY_MAX_CHARS - [...count].length - [...where].length;
  return {
    workspaceId,
    noticeId: automationFailedNoticeId({ workspaceId, installId: computer.installId, failure }),
    kind: "automation-failed",
    title,
    body: `${count}${cutText(what, room)}${where}`,
    target: automationTarget(failure.automationId, failure.chainStopped ? null : failure.claimId),
  };
}
