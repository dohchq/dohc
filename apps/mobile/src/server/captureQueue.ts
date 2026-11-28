import type { AccountState, SignIn } from "./account";
import { isFields, okAnswer, segment, text } from "./api";
import { ServerError } from "./client";
import { sleep as timerSleep } from "./deviceFlow";
import { FILE_WRITE_TIMEOUT_MS, newFileRequestId } from "./fileWrites";
import type { KeptStore, Row, SqlValue } from "./keptStore";

export const CAPTURE_MAX_BODY_BYTES = 256 * 1024;

export interface CaptureDraft {
  readonly workspaceId: string;
  readonly title?: string;
  readonly body?: string;
  readonly url?: string;
  readonly kind: "note" | "link";
}

export interface QueuedCapture extends CaptureDraft {
  readonly sequence: number;
  readonly origin: string;
  readonly accountId: string;
  readonly requestId: string;
  readonly stage: "queued" | "sending" | "refused";
  readonly reason: string | null;
}

export interface CaptureEvent {
  readonly seq: number;
  readonly kind: "saved" | "queued" | "refused";
  readonly title: string;
  readonly reason?: string;
}

export interface CaptureQueueState {
  readonly status: "loading" | "ready" | "failed";
  readonly items: readonly QueuedCapture[];
  readonly lastEvent: CaptureEvent | null;
}

export interface CaptureQueue {
  state(): CaptureQueueState;
  subscribe(listener: () => void): () => void;
  enqueue(input: CaptureDraft & { readonly requestId?: string }): Promise<QueuedCapture>;
  discard(requestId: string): Promise<void>;
  signOutCount(): number | null;
  holdForSignOut(): Promise<void>;
  releaseSignOut(): void;
  workspaces(openableIds: readonly string[]): void;
  wake(workspaceId?: string): void;
  follow(account: {
    state(): AccountState;
    subscribe(listener: () => void): () => void;
  }): () => void;
}

type CaptureReply =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly reason: string };

const isTerminal = (error: unknown) =>
  error instanceof ServerError && (error.status === 400 || error.status === 413);
const isNotFound = (error: unknown) => error instanceof ServerError && error.status === 404;

export function captureRequestBody(
  draft: Pick<CaptureDraft, "title" | "body" | "url" | "kind">,
  requestId: string,
) {
  return {
    ...(draft.title?.trim() ? { title: draft.title.trim() } : {}),
    ...(draft.body?.trim() ? { body: draft.body } : {}),
    ...(draft.url?.trim() ? { url: draft.url.trim() } : {}),
    kind: draft.kind,
    requestId,
  };
}

export const capturePayloadBytes = (
  draft: Pick<CaptureDraft, "title" | "body" | "url" | "kind">,
): number =>
  new TextEncoder().encode(JSON.stringify(captureRequestBody(draft, "0".repeat(36)))).byteLength;

export const captureLabel = (draft: Pick<CaptureDraft, "title" | "url" | "body">): string =>
  draft.title?.trim() ||
  draft.url?.trim() ||
  draft.body
    ?.split(/\r?\n/u)
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 80) ||
  "Captured item";

function readReply(body: unknown): CaptureReply | null {
  const answer = okAnswer(body);
  const res = answer && isFields(answer.result) ? answer.result : null;
  if (!res || typeof res.ok !== "boolean") return null;
  if (res.ok)
    return text(res.path, 1024) &&
      text(res.objectId, 256) &&
      text(res.recordId, 64) &&
      text(res.title, 512)
      ? { ok: true, title: res.title }
      : null;
  return text(res.refusal, 64) && text(res.reason, 512) ? { ok: false, reason: res.reason } : null;
}

function decodeRow(row: Row): QueuedCapture | null {
  if (
    typeof row.sequence !== "number" ||
    typeof row.origin !== "string" ||
    typeof row.account_id !== "string" ||
    typeof row.workspace_id !== "string" ||
    typeof row.request_id !== "string" ||
    typeof row.payload !== "string" ||
    (row.stage !== "queued" && row.stage !== "refused")
  )
    return null;
  try {
    const d = JSON.parse(row.payload) as Record<string, unknown>;
    return {
      sequence: row.sequence,
      origin: row.origin,
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      requestId: row.request_id,
      ...(typeof d.title === "string" && d.title ? { title: d.title } : {}),
      ...(typeof d.body === "string" ? { body: d.body } : {}),
      ...(typeof d.url === "string" && d.url ? { url: d.url } : {}),
      kind: d.kind === "link" ? "link" : "note",
      stage: row.stage,
      reason: typeof row.reason === "string" ? row.reason : null,
    };
  } catch {
    return null;
  }
}

export function createCaptureQueue(options: {
  readonly store: KeptStore;
  readonly sends?: boolean;
  readonly held?: () => boolean;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly retryMs?: (failures: number) => number;
  readonly onSaved?: (workspaceId: string) => void;
}): CaptureQueue {
  const { store, onSaved } = options;
  const sends = options.sends ?? true;
  const held = options.held ?? (() => false);
  const sleep = options.sleep ?? timerSleep;
  const retryMs = options.retryMs ?? ((n) => Math.min(1000 * 2 ** (n - 1), 60_000));

  let status: CaptureQueueState["status"] = "loading";
  let loading = false;
  let signingOut = false;
  let epoch = 0;
  let eventSeq = 0;
  let lastEvent: CaptureEvent | null = null;
  let session: SignIn | null = null;
  let lastAccount: { readonly origin: string; readonly userId: string } | null = null;
  let nudge = new AbortController();
  let snapshot: CaptureQueueState | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const items = new Map<string, QueuedCapture>();
  const active = new Map<string, { readonly requestId: string; readonly abort: AbortController }>();
  const parked = new Set<string>();
  const notified = new Set<string>();
  const listeners = new Set<() => void>();

  const scope = (origin: string, accountId: string, workspaceId: string) =>
    `${origin}\0${accountId}\0${workspaceId}`;
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const out = queue.then(run);
    queue = out.catch(() => undefined);
    return out;
  };
  const isHeld = () => signingOut || held();
  const sorted = () => [...items.values()].sort((a, b) => a.sequence - b.sequence);
  const changed = () => {
    snapshot = null;
    for (const fn of listeners) fn();
  };
  const emit = (event: Omit<CaptureEvent, "seq">) => {
    lastEvent = { ...event, seq: ++eventSeq };
    changed();
  };
  const bumpNudge = () => {
    const prev = nudge;
    nudge = new AbortController();
    prev.abort();
  };
  const abortAll = () => {
    for (const entry of active.values()) entry.abort.abort();
    active.clear();
  };
  const mutateDb = (at: number, sqlText: string, params: readonly SqlValue[]) =>
    serial(async () => {
      if (epoch !== at || isHeld()) return false;
      await store.transaction(async (sql) => {
        if (epoch !== at || isHeld()) return;
        await sql.run(sqlText, params);
      });
      return epoch === at && !isHeld();
    });

  const load = () => {
    if (loading || status === "ready") return Promise.resolve();
    loading = true;
    const at = epoch;
    return serial(async () => {
      try {
        if (epoch !== at || isHeld()) return;
        const rows = await store.read(
          "SELECT sequence, origin, account_id, workspace_id, request_id, payload, stage, reason FROM captures ORDER BY sequence",
          [],
        );
        if (epoch !== at || isHeld()) return;
        items.clear();
        for (const row of rows) {
          const decoded = decodeRow(row);
          if (decoded) items.set(decoded.requestId, decoded);
        }
        status = "ready";
        changed();
        pump();
      } catch {
        if (epoch === at) {
          status = "failed";
          changed();
        }
      } finally {
        loading = false;
      }
    });
  };

  function pump() {
    if (!sends || status !== "ready" || isHeld() || !session?.isCurrent()) return;
    const seen = new Set<string>();
    for (const item of sorted()) {
      if (
        item.stage === "refused" ||
        item.origin !== session.origin ||
        item.accountId !== session.userId ||
        seen.has(item.workspaceId)
      )
        continue;
      seen.add(item.workspaceId);
      const key = scope(item.origin, item.accountId, item.workspaceId);
      if (active.has(item.workspaceId) || parked.has(key)) continue;
      void sendItem(item.requestId, item.workspaceId, session);
    }
  }

  async function pause(ms: number, stop: AbortSignal) {
    if (stop.aborted) return;
    const wait = new AbortController();
    const end = () => wait.abort();
    const woken = nudge.signal;
    stop.addEventListener("abort", end);
    woken.addEventListener("abort", end);
    await sleep(ms, wait.signal).catch(() => undefined);
    stop.removeEventListener("abort", end);
    woken.removeEventListener("abort", end);
  }

  async function sendItem(requestId: string, workspaceId: string, signIn: SignIn) {
    const abort = new AbortController();
    active.set(workspaceId, { requestId, abort });
    const at = epoch;
    const live = () =>
      !abort.signal.aborted &&
      epoch === at &&
      !isHeld() &&
      session === signIn &&
      signIn.isCurrent();
    const failRefused = async (reason: string) => {
      const ok = await mutateDb(
        at,
        "UPDATE captures SET stage = 'refused', reason = ? WHERE request_id = ?",
        [reason, requestId],
      ).catch(() => false);
      const cur = ok ? items.get(requestId) : undefined;
      if (!cur) return;
      items.set(requestId, { ...cur, stage: "refused", reason });
      emit({ kind: "refused", title: captureLabel(cur), reason });
    };
    let failures = 0;
    try {
      while (live()) {
        const cur = items.get(requestId);
        if (!cur || cur.stage === "refused") return;
        items.set(requestId, { ...cur, stage: "sending" });
        changed();
        let reply: CaptureReply;
        try {
          reply = await signIn.client.send(
            "POST",
            `/sync/${segment(cur.workspaceId)}/ops/captureInboxItem`,
            readReply,
            captureRequestBody(cur, cur.requestId),
            { signal: abort.signal, timeoutMs: FILE_WRITE_TIMEOUT_MS },
          );
        } catch (error) {
          const reset = items.get(requestId);
          if (!live()) {
            if (reset?.stage === "sending") {
              items.set(requestId, { ...reset, stage: "queued" });
              changed();
            }
            return;
          }
          if (isTerminal(error))
            return await failRefused(error instanceof Error ? error.message : "Could not send.");
          if (reset?.stage === "sending") {
            items.set(requestId, { ...reset, stage: "queued" });
            if (notified.has(requestId)) changed();
            else {
              notified.add(requestId);
              emit({ kind: "queued", title: captureLabel(reset) });
            }
          }
          if (isNotFound(error)) {
            parked.add(scope(cur.origin, cur.accountId, cur.workspaceId));
            return;
          }
          await pause(retryMs(++failures), abort.signal);
          continue;
        }
        if (!live()) return;
        if (!reply.ok) return await failRefused(reply.reason);
        const deleted = await mutateDb(at, "DELETE FROM captures WHERE request_id = ?", [
          requestId,
        ]).catch(() => false);
        if (!deleted) {
          await pause(retryMs(++failures), abort.signal);
          continue;
        }
        items.delete(requestId);
        notified.delete(requestId);
        onSaved?.(cur.workspaceId);
        emit({ kind: "saved", title: reply.title });
        return;
      }
    } finally {
      if (active.get(workspaceId)?.abort === abort) active.delete(workspaceId);
      pump();
    }
  }

  const wake = (workspaceId?: string) => {
    if (workspaceId && session) parked.delete(scope(session.origin, session.userId, workspaceId));
    bumpNudge();
    if (status === "failed") void load();
    else pump();
  };

  return {
    state: () => (snapshot ??= { status, items: sorted(), lastEvent }),
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    enqueue(input) {
      const signIn = session;
      const at = epoch;
      if (!sends || !signIn?.isCurrent() || isHeld())
        return Promise.reject(new Error("Capture queue is unavailable."));
      const requestId = input.requestId ?? newFileRequestId();
      const fields = {
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        ...(input.body?.trim() ? { body: input.body } : {}),
        ...(input.url?.trim() ? { url: input.url.trim() } : {}),
        kind: input.kind,
      };
      const payload = JSON.stringify(fields);
      return serial(async () => {
        if (epoch !== at || isHeld() || !signIn.isCurrent())
          throw new Error("Capture queue is unavailable.");
        const seq = await store.transaction(async (sql) => {
          if (epoch !== at || isHeld()) throw new Error("Capture queue is unavailable.");
          await sql.run(
            "INSERT OR IGNORE INTO captures (origin, account_id, workspace_id, request_id, payload, stage, reason) VALUES (?, ?, ?, ?, ?, 'queued', NULL)",
            [signIn.origin, signIn.userId, input.workspaceId, requestId, payload],
          );
          const rows = await sql.all("SELECT sequence FROM captures WHERE request_id = ?", [
            requestId,
          ]);
          if (typeof rows[0]?.sequence !== "number") throw new Error("Could not store capture.");
          return rows[0].sequence;
        });
        const item: QueuedCapture = {
          sequence: seq,
          origin: signIn.origin,
          accountId: signIn.userId,
          workspaceId: input.workspaceId,
          requestId,
          ...fields,
          stage: "queued",
          reason: null,
        };
        if (epoch === at && !isHeld()) {
          parked.delete(scope(signIn.origin, signIn.userId, input.workspaceId));
          items.set(requestId, item);
          if (status === "loading") status = "ready";
          changed();
          pump();
        }
        return item;
      });
    },
    async discard(requestId) {
      const at = epoch;
      for (const entry of active.values()) if (entry.requestId === requestId) entry.abort.abort();
      if (await mutateDb(at, "DELETE FROM captures WHERE request_id = ?", [requestId])) {
        items.delete(requestId);
        notified.delete(requestId);
        changed();
        pump();
      }
    },
    signOutCount() {
      if (status !== "ready") return null;
      const acct = session ?? lastAccount;
      if (!acct) return 0;
      let count = 0;
      for (const item of items.values())
        if (item.origin === acct.origin && item.accountId === acct.userId) count += 1;
      return count;
    },
    async holdForSignOut() {
      signingOut = true;
      epoch += 1;
      status = "loading";
      abortAll();
      parked.clear();
      bumpNudge();
      items.clear();
      notified.clear();
      changed();
      await queue;
    },
    releaseSignOut() {
      signingOut = false;
      if (!isHeld() && session?.isCurrent()) void load();
    },
    workspaces(openableIds) {
      if (!session) return;
      let unparked = false;
      for (const id of openableIds)
        if (parked.delete(scope(session.origin, session.userId, id))) unparked = true;
      if (unparked) pump();
    },
    wake,
    follow(account) {
      let stopped = false;
      const sync = () => {
        const cur = account.state();
        const next = cur.status === "signed-in" ? cur.signIn : null;
        if (next === session) return;
        session = next;
        if (next) lastAccount = { origin: next.origin, userId: next.userId };
        if (!next) abortAll();
        else if (status === "loading" || status === "failed") void load();
        else wake();
      };
      void load();
      sync();
      const unsub = account.subscribe(() => !stopped && sync());
      return () => {
        stopped = true;
        session = null;
        unsub();
        abortAll();
      };
    },
  };
}
