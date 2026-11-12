import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { jsonResponse, readBoundedJson, type TokenBucketLimiter } from "@dohc/service-http";
import { badRequest, errorResponse, notFound, relayError } from "./errors";
import type { LinkAuthorityResolver, PersonalAuthority } from "./linkAuthority";
import { HELD_OPEN_EVALUATE_MS, HELD_OPEN_MAX_MS, HELD_OPEN_MAX_PER_AGENT, HELD_OPEN_MAX_WAITERS } from "./liveHostingLimits";
import type { PersonalAgents } from "./personalAgents";
import { observeRelayWrites } from "./relayWriteChanges";
import { parseString, parseWorkspaceId } from "./requestInputs";
import { serviceHostReadiness, type ServiceHostReadinessHost } from "./serviceHostEnrollmentRoutes";
import { MAX_SHARE_PATH_CHARS } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import type { LiveJournalHistoryAuthority } from "./storage/liveJournalHistory";
import type { PersonalCredential } from "./storage/personalAgentChat";
import { LiveHostingRefusal, type ServiceHostEnrollment } from "./storage/serviceHostEnrollment";

// share-web calls this over the relay exchange key when a personal agent reads
// or edits a live document. The open authenticates the access token at the
// account's fence, then asks for hosting in one transaction: the agent reaches
// the workspace at Edit, its account owns it, and the path holds a current
// rich document. It then holds for the document to be ready.

export const PERSONAL_LIVE_DOCUMENT_PATH = "/sync/live/personal-document";
export const PERSONAL_LIVE_DOCUMENT_MAX_BODY_BYTES = 4 * 1024;

/** Why an open ends without a document. Each needs its owner, not a retry. */
export type PersonalLiveDocumentRefusal = "live_paused_by_owner" | "live_host_full" | "live_hosting_unsupported" | (string & {});

export type PersonalLiveDocumentAnswer =
  | { status: "ready"; objectId: string; binding: LiveObjectBinding }
  | { status: "preparing" }
  | { status: "refused"; reason: PersonalLiveDocumentRefusal };

const REFUSAL_MESSAGES: Record<string, string> = {
  live_paused_by_owner: "The owner paused live editing of this document.",
  live_host_full: "This server is hosting as many documents for agents as it can.",
  live_hosting_unsupported: "This server does not host live documents for agents.",
  "live-document-without-lineage": "The owner must open this document in dohc on a desktop first.",
  "document-unavailable": "The document is no longer at this path.",
  "workspace-changed": "The workspace changed. The owner must open the document again.",
  "live-history-over-budget": "This document's edit history is past what this server reads or checks. Live editing starts once the document has a new base.",
};
const REFUSED = "This server cannot continue this document until its owner tries again.";

function take(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function release(counts: Map<string, number>, key: string): void {
  const count = (counts.get(key) ?? 1) - 1;
  if (count === 0) counts.delete(key); else counts.set(key, count);
}

function answerResponse(answer: PersonalLiveDocumentAnswer): Response {
  if (answer.status === "ready") return jsonResponse({ ok: true, status: "ready", objectId: answer.objectId, binding: answer.binding });
  // The demand stays, so a retry soon after usually finds the document ready.
  if (answer.status === "preparing") return jsonResponse({ ok: true, status: "preparing" }, 202);
  return jsonResponse({ ok: false, code: answer.reason, error: REFUSAL_MESSAGES[answer.reason] ?? REFUSED }, 409);
}

export function createPersonalLiveDocumentRoute(input: {
  storage: SyncRelayStorage;
  linkAuthority: Pick<LinkAuthorityResolver, "personal" | "freshPersonal">;
  personalAgents: Pick<PersonalAgents, "register">;
  /** Admits requests per connection, with the personal agent tools. */
  limiter: TokenBucketLimiter;
  nowMs: () => number;
  /** The self-hosted live host and the id it provisions. Without it, or with another host configured, every open refuses. */
  live?: { host: ServiceHostReadinessHost; history: LiveJournalHistoryAuthority; hostId: string };
  limits?: { maxMs?: number; evaluateMs?: number; perAgent?: number; waiters?: number };
}) {
  const { storage, linkAuthority, nowMs, live } = input;
  const maxMs = input.limits?.maxMs ?? HELD_OPEN_MAX_MS;
  const evaluateMs = input.limits?.evaluateMs ?? HELD_OPEN_EVALUATE_MS;
  const perAgent = input.limits?.perAgent ?? HELD_OPEN_MAX_PER_AGENT;
  const maxWaiters = input.limits?.waiters ?? HELD_OPEN_MAX_WAITERS;
  const readiness = live && serviceHostReadiness({ storage, history: live.history, host: live.host,
    activation: storage.createServiceActivationStore(live.history) });
  const supported = () => {
    const control = storage.getLiveHostControl();
    return !!live && control?.configuredMode === "service" && control.configuredHostId === live.hostId;
  };
  const credential = (authority: PersonalAuthority): PersonalCredential =>
    ({ check: authority.check, connectionId: authority.connectionId, fenceEpoch: authority.fenceEpoch });

  // The answer the document has now, or null while it is still starting.
  function evaluate(workspaceId: string, objectId: string): PersonalLiveDocumentAnswer | null {
    const row = storage.readServiceHostEnrollmentByObjectId(workspaceId, objectId);
    if (!row) return { status: "refused", reason: "document-unavailable" };
    if (row.ownerStop !== null) return { status: "refused", reason: "live_paused_by_owner" };
    // Retired without a Stop while it waited: nothing hosts it until the next open enrolls it again.
    if (row.retired) return { status: "preparing" };
    const state = readiness!.state(row);
    if (state.status === "ready") return { status: "ready", objectId: state.objectId, binding: state.document.binding };
    if (state.status === "paused") return { status: "refused", reason: "live_paused_by_owner" };
    // Without a reason, the host itself is not running yet.
    if (state.status === "unavailable" && state.reason !== undefined) return { status: "refused", reason: state.reason };
    return null;
  }

  // Waiters join a set for their document. After each relay write and every
  // tick, each waited-on document is read once and its answer goes to all of them.
  type Finish = (answer: PersonalLiveDocumentAnswer | Error | null) => void;
  const waiting = new Map<string, { workspaceId: string; objectId: string; waiters: Set<Finish> }>();
  const heldByAgent = new Map<string, number>();
  let held = 0;
  let stopObserving: (() => void) | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  function evaluateWaiting(): void {
    for (const entry of [...waiting.values()]) {
      let answer: PersonalLiveDocumentAnswer | Error | null;
      try {
        answer = evaluate(entry.workspaceId, entry.objectId);
      } catch (error) {
        answer = error instanceof Error ? error : new Error(String(error));
      }
      if (answer !== null) for (const finish of [...entry.waiters]) finish(answer);
    }
  }

  function hold(workspaceId: string, objectId: string, signal: AbortSignal): Promise<PersonalLiveDocumentAnswer | null> {
    const key = JSON.stringify([workspaceId, objectId]);
    let entry = waiting.get(key);
    if (!entry) {
      entry = { workspaceId, objectId, waiters: new Set() };
      waiting.set(key, entry);
    }
    const joined = entry;
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(null), maxMs);
      const abort = () => finish(null);
      const finish: Finish = (answer) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        joined.waiters.delete(finish);
        if (joined.waiters.size === 0 && waiting.get(key) === joined) waiting.delete(key);
        if (waiting.size === 0) {
          stopObserving?.();
          stopObserving = undefined;
          clearInterval(tick);
          tick = undefined;
        }
        if (answer instanceof Error) reject(answer); else resolve(answer);
      };
      joined.waiters.add(finish);
      stopObserving ??= observeRelayWrites(storage, evaluateWaiting);
      if (!tick) {
        tick = setInterval(evaluateWaiting, evaluateMs);
        tick.unref();
      }
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function readBody(request: Request): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      body = await readBoundedJson(request, PERSONAL_LIVE_DOCUMENT_MAX_BODY_BYTES, request.signal);
    } catch {
      throw badRequest("invalid request");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("invalid request");
    return body as Record<string, unknown>;
  }

  async function open(request: Request): Promise<Response> {
    if (request.method !== "POST") throw relayError("method_not_allowed");
    // The account's fence is read from Postgres first; while it can't answer, the open is 503.
    const authority = await linkAuthority.personal(request);
    if (!input.limiter.allow(authority.callerKey, nowMs())) throw relayError("link_read_rate_limited");
    const body = await readBody(request);
    if (Object.keys(body).some(key => key !== "workspaceId" && key !== "path") || !("workspaceId" in body) || !("path" in body)) {
      throw badRequest("invalid request");
    }
    const workspaceId = parseWorkspaceId(body.workspaceId);
    const path = parseString(body.path, "path", MAX_SHARE_PATH_CHARS);
    // Only the self-hosted live host hosts documents for agents. Any other host refuses before any write.
    if (!readiness || !supported()) return answerResponse({ status: "refused", reason: "live_hosting_unsupported" });
    // The body is in, so the fence is read again, and the transaction authorizes at that epoch.
    const current = await linkAuthority.freshPersonal(authority);
    let row: ServiceHostEnrollment;
    try {
      row = storage.ensureOwnedLiveDocument({ intent: "personal-open", personal: credential(current), workspaceId, path,
        nowMs: nowMs(), guard: () => request.signal.throwIfAborted() });
    } catch (error) {
      if (error instanceof LiveHostingRefusal) return answerResponse({ status: "refused", reason: error.reason });
      throw error;
    }
    const now = evaluate(row.workspaceId, row.objectId);
    if (now !== null) return answerResponse(now);
    // Past either limit, or without the registry to end it, the open has still committed, and answers at once.
    const { agentId } = current;
    if (held >= maxWaiters || (heldByAgent.get(agentId) ?? 0) >= perAgent) return answerResponse({ status: "preparing" });
    // Running work ending: Sign out, a narrowed reach, or a newer fence.
    const ended = new AbortController();
    let unregister: () => void;
    try {
      unregister = input.personalAgents.register({
        agentId, ownerUserId: current.ownerUserId, connectionId: current.connectionId, fenceEpoch: current.fenceEpoch,
        workspaceIds: [workspaceId], kind: "wait", needs: "edit", terminate: () => ended.abort(),
      });
    } catch {
      return answerResponse({ status: "preparing" });
    }
    held++;
    take(heldByAgent, agentId);
    // The hold's slot and registration end with it, before anything else is read.
    const settled = await hold(row.workspaceId, row.objectId, AbortSignal.any([request.signal, ended.signal])).finally(() => {
      unregister();
      held--;
      release(heldByAgent, agentId);
    });
    if (request.signal.aborted) throw notFound();
    if (!ended.signal.aborted) return answerResponse(settled ?? { status: "preparing" });
    // Its access changed while it waited, so it is read again before any answer leaves.
    const fresh = await linkAuthority.freshPersonal(current);
    const reach = storage.readPersonalReach(credential(fresh), workspaceId, nowMs());
    if (!reach) throw relayError("personal_agent_out_of_reach");
    if (reach.level !== "edit") throw relayError("personal_agent_edit_needed");
    return answerResponse(evaluate(row.workspaceId, row.objectId) ?? { status: "preparing" });
  }

  return Object.assign(async (request: Request): Promise<Response> => {
    try {
      return await open(request);
    } catch (error) {
      // A caller that left gets no detail, and its abort is not a server fault.
      return errorResponse(request.signal.aborted ? notFound() : error);
    }
  }, {
    /** Held opens now, and the documents they wait on, for tests and measurement. */
    held: () => ({ waiters: held, documents: waiting.size }),
    /** Reads every waited-on document once, as a relay write or tick does. */
    evaluateWaiting,
  });
}
