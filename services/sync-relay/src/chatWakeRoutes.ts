import { jsonResponse, readBoundedJson, type TokenBucketLimiter } from "@dohc/service-http";
import type { ResolveAccountSession } from "@dohc/workspace-auth/session";
import { handleForName, normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import { asRecord } from "@dohc/workspace-core";
import { bearerAccountSession } from "./accountWorkspaceRoutes";
import { DiscussionActivityCapacityError, type DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, RelayError, relayError } from "./errors";
import { PERSONAL_AGENT_ID_PREFIX } from "./relayLogInputs";
import { observeChatWakeChanges } from "./relayWriteChanges";
import { parseString, parseWorkspaceId } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";
import { CHAT_RUNNER_AGENTS, type ChatRunner } from "./storage/chatWakes";

// The routes an owner's computers use to wake its agents: declare the agents
// each computer runs in a workspace, wait for wakes that list the computer,
// claim one, and confirm its trigger. Only a Bearer account session reaches
// them, and every row is the session's account's, in a workspace it owns now;
// any other answers as missing. No route creates a wake.

export type ChatWakeRoute =
  | { route: "chat-runners"; workspaceId: string }
  | { route: "chat-wakes" }
  | { route: "chat-wake"; wakeId: string; action: "claim" | "queued" };

/** The longest a wake read waits. */
export const CHAT_WAKE_WAIT_MAX_MS = 25_000;
/** The wake reads one account may hold waiting at once, across its computers. */
const CHAT_WAKE_WAITS_PER_ACCOUNT = 16;
/** The wake reads one computer may hold waiting at once. */
export const CHAT_WAKE_WAITS_PER_INSTALL = 2;
// A runners or claim body is small.
const BODY_MAX_BYTES = 32 * 1024;
const BODY_RECEIPT_MS = 10_000;
const WAKE_ID = /^wake-[0-9a-f]{32}$/u;
// A desktop agent's settings ID. A personal agent's starts with `p-` and is never a runner.
const AGENT_ID = /^(?=.{1,64}$)[a-z](?:-?[a-z0-9])*$/u;
const SEQUENCE = /^(?:0|[1-9]\d{0,15})$/u;

/** Parses `/sync/wakes/...`, already split into segments. */
export function parseChatWakeRoute(parts: readonly string[]): ChatWakeRoute {
  if (parts.length === 2) return { route: "chat-wakes" };
  const [, , wakeId, action] = parts;
  if (parts.length === 4 && wakeId !== undefined && WAKE_ID.test(wakeId) && (action === "claim" || action === "queued")) {
    return { route: "chat-wake", wakeId, action };
  }
  throw notFound();
}

/** Parses `/sync/workspaces/:workspaceId/runners`. An ID that cannot be a workspace answers as one the account doesn't own. */
export function parseChatRunnersRoute(workspaceId: string | undefined): ChatWakeRoute {
  try { return { route: "chat-runners", workspaceId: parseWorkspaceId(workspaceId) }; }
  catch { throw notFound(); }
}

/** Each account's wake reads wait in their own group. */
function chatWakeWaitGroup(accountId: string): string {
  return `chat-wakes:${accountId}`;
}

/**
 * Wake reads, in each account's own group. A change to any of the account's
 * wakes wakes them, after its transaction; so does a credential change, by
 * wakeAccount. A held read is a parked promise with one timer: it runs no
 * query and no loop until something wakes it or its time ends.
 */
export function createChatWakeWaits(storage: object, hub: Pick<DiscussionActivityHub, "wait" | "wake">) {
  const accounts = new Map<string, Map<string, number>>();
  const stopObserving = observeChatWakeChanges(storage, (accountId) => hub.wake(chatWakeWaitGroup(accountId)));
  const busy = () => new RelayError("server_busy", "Your server is holding as many wake requests as it can. Try again shortly.");

  return {
    /** Parks until a wake or `holdMs`. Answers server_busy past the computer's, the account's, or the server's waits. */
    async wait(input: { accountId: string; installId: string; caller: string; holdMs: number; signal: AbortSignal; shouldPark(): boolean }): Promise<void> {
      const installs = accounts.get(input.accountId) ?? new Map<string, number>();
      const held = [...installs.values()].reduce((total, count) => total + count, 0);
      if (held >= CHAT_WAKE_WAITS_PER_ACCOUNT || (installs.get(input.installId) ?? 0) >= CHAT_WAKE_WAITS_PER_INSTALL) throw busy();
      accounts.set(input.accountId, installs);
      installs.set(input.installId, (installs.get(input.installId) ?? 0) + 1);
      try {
        await hub.wait(chatWakeWaitGroup(input.accountId), `account:${input.caller}`,
          { holdMs: input.holdMs, signal: input.signal, shouldPark: input.shouldPark });
      } catch (error) {
        throw error instanceof DiscussionActivityCapacityError ? busy() : error;
      } finally {
        const left = installs.get(input.installId)! - 1;
        if (left > 0) installs.set(input.installId, left);
        else installs.delete(input.installId);
        if (installs.size === 0) accounts.delete(input.accountId);
      }
    },
    /** The account's credentials changed: its reads check them again. */
    wakeAccount(accountId: string): void {
      hub.wake(chatWakeWaitGroup(accountId));
    },
    close: stopObserving,
  };
}

type ChatWakeWaits = ReturnType<typeof createChatWakeWaits>;

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await readBoundedJson(request, BODY_MAX_BYTES, AbortSignal.any([request.signal, AbortSignal.timeout(BODY_RECEIPT_MS)]));
  } catch (error) {
    throw error instanceof RangeError ? relayError("payload_too_large") : badRequest("request body must be valid JSON");
  }
  const object = asRecord(body);
  if (object === null) throw badRequest("request body must be a JSON object");
  return object;
}

const exactly = (object: Record<string, unknown>, keys: readonly string[]) => {
  const present = Object.keys(object);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(object, key));
};

type Declaration = { installId: string; computerLabel: string; runners: Array<Omit<ChatRunner, "installId" | "computerLabel">> };

// `{installId, computerLabel, runners: [{agentId, displayName, enabled}]}`. The handle comes from the name, as the desktop derives it.
function parseDeclaration(body: Record<string, unknown>): Declaration {
  const shape = "the body must be exactly { installId, computerLabel, runners: [{ agentId, displayName, enabled }] }";
  if (!exactly(body, ["installId", "computerLabel", "runners"]) || !Array.isArray(body.runners)) throw badRequest(shape);
  const installId = parseString(body.installId, "installId", 256);
  const computerLabel = parseString(body.computerLabel, "computerLabel", 64);
  const listed = body.runners as unknown[];
  if (listed.length > CHAT_RUNNER_AGENTS) throw badRequest(`a computer declares at most ${CHAT_RUNNER_AGENTS} agents`);
  const runners = listed.map((value) => {
    const runner = asRecord(value);
    if (runner === null || !exactly(runner, ["agentId", "displayName", "enabled"]) || typeof runner.agentId !== "string" ||
      !AGENT_ID.test(runner.agentId) || runner.agentId.startsWith(PERSONAL_AGENT_ID_PREFIX) || typeof runner.enabled !== "boolean") {
      throw badRequest(shape);
    }
    const displayName = parseString(runner.displayName, "displayName", 200);
    return { agentId: runner.agentId, displayName, handle: normalizeHandle(handleForName(displayName)), enabled: runner.enabled };
  });
  const handles = runners.map((runner) => runner.handle).filter((handle) => handle !== "");
  if (new Set(runners.map((runner) => runner.agentId)).size !== runners.length || new Set(handles).size !== handles.length) {
    throw badRequest("each agent needs its own ID and its own name");
  }
  return { installId, computerLabel, runners };
}

function parseInstall(body: Record<string, unknown>): string {
  if (!exactly(body, ["installId"])) throw badRequest("the body must be exactly { installId }");
  return parseString(body.installId, "installId", 256);
}

function parseSequence(value: string | null, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null) return 0;
  const number = Number(value);
  if (!SEQUENCE.test(value) || !Number.isSafeInteger(number) || number > max) throw badRequest(`${name} must be an integer from 0 to ${max}`);
  return number;
}

/**
 * The routes. `GET /sync/wakes?installId=&since=&wait=` answers the waiting
 * wakes that list the computer and changed after `since`, waiting up to
 * `wait` ms for one when none has; the session is checked again after each
 * wait and before the answer. `PUT /sync/workspaces/:id/runners` replaces the
 * computer's agents there. `POST /sync/wakes/:id/claim` and `.../queued`,
 * each with `{installId}`, claim a wake and confirm its trigger.
 */
export function createChatWakeRoutes(options: {
  storage: SyncRelayStorage;
  resolveAccountSession: ResolveAccountSession;
  waits: ChatWakeWaits;
  nowMs(): number;
  /** Keyed by sign-in. */
  limiter: TokenBucketLimiter;
}) {
  const { storage, waits } = options;
  const session = (request: Request) => bearerAccountSession(storage, options.resolveAccountSession, request);

  return async function respondToChatWakes(request: Request, route: ChatWakeRoute): Promise<Response> {
    const method = route.route === "chat-wakes" ? "GET" : route.route === "chat-runners" ? "PUT" : "POST";
    if (request.method !== method) throw relayError("method_not_allowed");
    const caller = await session(request);
    if (!options.limiter.allow(caller.sessionId, options.nowMs())) {
      throw new RelayError("server_busy", "This sign-in is asking faster than your server answers. Try again shortly.");
    }
    const same = async () => {
      const current = await session(request);
      if (current.sessionId !== caller.sessionId || current.userId !== caller.userId) throw notFound();
    };
    const accountId = caller.userId;

    if (route.route === "chat-wakes") {
      const url = new URL(request.url);
      const installId = parseString(url.searchParams.get("installId"), "installId", 256);
      const since = parseSequence(url.searchParams.get("since"), "since");
      const deadlineAtMs = Date.now() + parseSequence(url.searchParams.get("wait"), "wait", CHAT_WAKE_WAIT_MAX_MS);
      // Parks only while nothing changed after `since`: a head that moved answers at once, even with no wake for this computer.
      // The sign-in is checked before each read, and nothing is awaited between the last read, which checks the owner, and the answer.
      for (;;) {
        await same();
        const page = storage.listWaitingChatWakes({ accountId, installId, since, nowMs: options.nowMs() });
        if (page.wakes.length > 0 || page.cursor !== since || deadlineAtMs <= Date.now() || request.signal.aborted) {
          return jsonResponse({ ok: true, cursor: String(page.cursor), wakes: page.wakes });
        }
        await waits.wait({ accountId, installId, caller: caller.sessionId, holdMs: deadlineAtMs - Date.now(), signal: request.signal,
          shouldPark: () => storage.chatWakeHead(accountId) === since });
      }
    }

    if (route.route === "chat-runners") {
      if (!storage.workspaceIsOwnedBy(route.workspaceId, accountId)) throw notFound();
      const declared = parseDeclaration(await readBody(request));
      // Reading the body waited, so the sign-in is checked again; storage checks the owner in its transaction.
      await same();
      if (!storage.replaceChatRunners({ accountId, workspaceId: route.workspaceId, ...declared, nowMs: options.nowMs() })) throw notFound();
      return jsonResponse({ ok: true, workspaceId: route.workspaceId, installId: declared.installId, runners: declared.runners.length });
    }

    const installId = parseInstall(await readBody(request));
    await same();
    const input = { accountId, wakeId: route.wakeId, installId, nowMs: options.nowMs() };
    if (route.action === "claim") {
      const claimed = storage.claimChatWake(input);
      if (claimed === null) throw notFound();
      return jsonResponse({ ok: true, won: claimed.won, wake: claimed.wake });
    }
    const confirmed = storage.confirmChatWakeQueued(input);
    if (confirmed === null) throw notFound();
    return jsonResponse({ ok: true, wake: confirmed });
  };
}
