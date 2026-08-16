import { relayRequest } from "./relayRequest";
import {
  ShareUnavailableError,
  type SentShareProposal,
  type ShareProposal,
  type ShareProposalDecision,
  type ShareProposalOp,
  type ShareProposalSettlement,
  type ShareProposalState,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";

// #646 PR3. The proposal routes that do NOT go through the engine.
//
// Submitting is the engine's job — it reads this replica's own journal, so it
// has to be the process that holds the store. Reviewing, settling, listing and
// withdrawing read and write ONLY relay state, so they are plain authenticated
// relay calls, in the same shape and with the same auth as `shareViewInfo.ts`.

// The relay answered with something that is not a proposal this client can
// show or settle. Refused rather than softened: a review row built from a
// half-read response tells the granter it is accepting one thing while the
// relay holds another, and accepting is what writes to the granter's own
// workspace.
function unreadable(detail: string): Error {
  return new Error(`The relay did not describe a proposal in a readable way: ${detail}`);
}

async function relayFetch(
  relay: SyncRelayConnection,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await relayRequest({
    relay,
    path,
    init,
    // The relay answers one generic 404 for every lookup failure — a share
    // that ended, a proposal that never existed, and a workspace this account
    // does not own all read the same, so none of them can be told apart here.
    errors: { 404: () => new ShareUnavailableError() },
    label: "Proposal request",
  });
  return (await response.json()) as unknown;
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw unreadable(`${at} is not an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: Record<string, unknown>, key: string, at: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw unreadable(`${at}.${key} is not a string`);
  }
  return field;
}

function nullableText(
  value: Record<string, unknown>,
  key: string,
  at: string,
): string | null {
  const field = value[key];
  if (field === null) return null;
  if (typeof field !== "string" || field.length === 0) {
    throw unreadable(`${at}.${key} is not a string or null`);
  }
  return field;
}

function count(value: Record<string, unknown>, key: string, at: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw unreadable(
      `${at}.${key} is not a non-negative integer`,
    );
  }
  return field;
}

function nullableCount(
  value: Record<string, unknown>,
  key: string,
  at: string,
): number | null {
  if (value[key] === null) return null;
  return count(value, key, at);
}

function flag(value: Record<string, unknown>, key: string, at: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw unreadable(`${at}.${key} is not a boolean`);
  }
  return field;
}

const PROPOSAL_STATES: readonly ShareProposalState[] = [
  "open",
  "accepted",
  "declined",
  "withdrawn",
];

// Closed set, no fallback. An unknown state is a relay this client is not
// speaking the same protocol as, and every guess picks a wrong button: read
// as `open` it offers accept on a settled proposal, read as `accepted` it
// hides work the granter still has to answer.
function proposalState(
  value: Record<string, unknown>,
  at: string,
): ShareProposalState {
  const field = value.state;
  const known = PROPOSAL_STATES.find((state) => state === field);
  if (known === undefined) {
    throw unreadable(`${at}.state is not a proposal state`);
  }
  return known;
}

function operation(
  value: Record<string, unknown>,
  at: string,
): "write" | "delete" {
  const field = value.operation;
  if (field !== "write" && field !== "delete") {
    throw unreadable(`${at}.operation is not an operation`);
  }
  return field;
}

function nullableContentKind(
  value: Record<string, unknown>,
  at: string,
): "text" | "binary" | null {
  const field = value.afterContentKind;
  if (field === null) return null;
  if (field !== "text" && field !== "binary") {
    throw unreadable(
      `${at}.afterContentKind is not a content kind`,
    );
  }
  return field;
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) {
    throw unreadable(`${at} is not an array`);
  }
  return value;
}

function parseOp(value: unknown, at: string): ShareProposalOp {
  const op = record(value, at);
  const after = nullableText(op, "afterPath", at);
  const kind = operation(op, at);
  // A write with nowhere to write is not a change this client can show, and
  // a delete that names an after side is two changes wearing one label.
  if ((kind === "write") !== (after !== null)) {
    throw unreadable(
      `${at} states ${kind} with an after path of ${after === null ? "null" : "a path"}`,
    );
  }
  return {
    opIndex: count(op, "opIndex", at),
    basedOnPath: nullableText(op, "basedOnPath", at),
    operation: kind,
    afterPath: after,
    afterBlobSha256: nullableText(op, "afterBlobSha256", at),
    afterContentKind: nullableContentKind(op, at),
    currentPath: nullableText(op, "currentPath", at),
    drifted: flag(op, "drifted", at),
  };
}

// This route serves what the granter still has to ANSWER, so every proposal
// on it is open. It states no state and no settled time, and this parser asks
// for neither: a validator for a field that is always the same value refuses
// responses over a constant it never reads.
function parseProposal(value: unknown, at: string): ShareProposal {
  const proposal = record(value, at);
  return {
    proposalId: text(proposal, "proposalId", at),
    shareId: text(proposal, "shareId", at),
    proposedByEmail: nullableText(proposal, "proposedByEmail", at),
    createdAtMs: count(proposal, "createdAtMs", at),
    ops: array(proposal.ops, `${at}.ops`).map((op, index) =>
      parseOp(op, `${at}.ops[${index}]`),
    ),
  };
}

function parseSentProposal(value: unknown, at: string): SentShareProposal {
  const proposal = record(value, at);
  return {
    proposalId: text(proposal, "proposalId", at),
    state: proposalState(proposal, at),
    createdAtMs: count(proposal, "createdAtMs", at),
    settledAtMs: nullableCount(proposal, "settledAtMs", at),
    ops: count(proposal, "ops", at),
  };
}

function parseSettlement(
  value: unknown,
  at: string,
  proposalId: string,
): ShareProposalSettlement {
  const settled = record(value, at);
  const answered = text(settled, "proposalId", at);
  // The relay answering about another proposal is not a settlement this
  // client can report — it would mark the wrong row settled.
  if (answered !== proposalId) {
    throw unreadable(
      `${at}.proposalId answered ${answered} for ${proposalId}`,
    );
  }
  return { proposalId: answered, state: proposalState(settled, at) };
}

/**
 * The proposals waiting on the granter, with every op expanded for review.
 *
 * Workspace-scoped, so ownership is derived by the relay's own owner gate. A
 * recipient cannot reach this route: a received share never states the
 * granter's workspace id.
 */
export async function listShareProposals(input: {
  relay: SyncRelayConnection;
  workspaceId: string;
}): Promise<ShareProposal[]> {
  const body = record(
    await relayFetch(
      input.relay,
      `/sync/${encodeURIComponent(input.workspaceId)}/proposals`,
    ),
    "proposals response",
  );
  return array(body.proposals, "proposals").map((proposal, index) =>
    parseProposal(proposal, `proposals[${index}]`),
  );
}

/**
 * Accept or decline one proposal. Accept releases the recipient's changes
 * into the granter's own log; decline leaves them where they are.
 */
export async function settleShareProposal(input: {
  relay: SyncRelayConnection;
  workspaceId: string;
  proposalId: string;
  decision: ShareProposalDecision;
}): Promise<ShareProposalSettlement> {
  const body = await relayFetch(
    input.relay,
    `/sync/${encodeURIComponent(input.workspaceId)}/proposals/${encodeURIComponent(
      input.proposalId,
    )}/${input.decision}`,
    { method: "POST" },
  );
  return parseSettlement(body, `${input.decision} response`, input.proposalId);
}

/**
 * The proposals this replica sent through one share — the sent, accepted and
 * declined states the recipient sees. Share-scoped: the recipient states the
 * share it holds, never the granter's workspace.
 */
export async function listMyShareProposals(input: {
  relay: SyncRelayConnection;
  shareId: string;
}): Promise<SentShareProposal[]> {
  const body = record(
    await relayFetch(
      input.relay,
      `/sync/shares/${encodeURIComponent(input.shareId)}/proposals`,
    ),
    "sent proposals response",
  );
  return array(body.proposals, "sent proposals").map((proposal, index) =>
    parseSentProposal(proposal, `sent proposals[${index}]`),
  );
}

/**
 * Take a sent proposal back. This is the reverse path submitting owes, so it
 * works only from `open` — the relay refuses a proposal the granter already
 * settled.
 */
export async function withdrawShareProposal(input: {
  relay: SyncRelayConnection;
  shareId: string;
  proposalId: string;
}): Promise<ShareProposalSettlement> {
  const body = await relayFetch(
    input.relay,
    `/sync/shares/${encodeURIComponent(input.shareId)}/proposals/${encodeURIComponent(
      input.proposalId,
    )}/withdraw`,
    { method: "POST" },
  );
  return parseSettlement(body, "withdraw response", input.proposalId);
}
