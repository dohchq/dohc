import type * as Y from "yjs";
import {
  isEngineStoreBusyRefusal,
  isTransientEngineRefusal,
} from "../live/daemonLiveAdapter";
import {
  RemoteYdocApplyError,
  YdocLiveAdapter,
  type YdocResyncNeededError,
  type EngineTransport,
  type YdocAdapterSession,
} from "./ydocLiveAdapter";
import type {
  YdocApplyExternalMarkdownEditResult,
  YdocContentKind,
  YdocSettleResult,
} from "./ydocWireContract";

const DEFAULT_SETTLE_DEBOUNCE_MS = 800;

// The retry ceiling for a settle refused `file-locked` (an external program
// holds the artifact's handle). The edits are journaled and the write job is
// durably pending, so retrying is the only missing piece — the delay doubles
// from the settle debounce up to this cap, which bounds how long the on-disk
// artifact stays stale after the lock releases.
const LOCKED_SETTLE_RETRY_CAP_MS = 10_000;

// The retry ceiling for a settle refused `engine-store-busy` (dohc's own
// database was busy). An order of magnitude below the lock's, because the two
// waits are for different things: a file lock is held by a program outside
// dohc and can last as long as that program does, while SQLite contention is
// dohc's own writers meeting and clears in milliseconds. Walking out to ten
// seconds for it would hold the document unsettled far longer than the
// condition it waits on lasts.
const STORE_BUSY_SETTLE_RETRY_CAP_MS = 1_000;

// How far this failure's retry ladder may walk out, or null when retrying
// cannot help. ONE question decides it — is the condition transient? — and
// both answers here are yes, for two different busy things (#554, #658).
// Every other settle failure answers no: a preimage that no longer matches, a
// target turned read-only, an ACL that denies the replace.
//
// `isTransientEngineRefusal` owns MEMBERSHIP of the retryable class, in one
// place at the protocol boundary. This owns only HOW LONG each member may be
// waited on, so a class added there cannot silently acquire a ladder here — it
// lands on the conservative ceiling instead.
function settleRetryCapMs(error: unknown): number | null {
  if (!isTransientEngineRefusal(error)) return null;
  if (isEngineStoreBusyRefusal(error)) return STORE_BUSY_SETTLE_RETRY_CAP_MS;
  return LOCKED_SETTLE_RETRY_CAP_MS;
}

// A close whose pre-close settle failed but whose daemon release SUCCEEDED.
// Callers must distinguish this from a failed release: the session and its
// lease are gone, so keeping a "still reserved" guard on the path would defer
// its capture forever while nothing holds the reservation.
export class YdocReleasedWithSettleFailureError extends Error {
  constructor(path: string, cause: unknown) {
    super(
      `Y.Doc session for ${path} released, but its pre-close settle failed.`,
      { cause },
    );
    this.name = "YdocReleasedWithSettleFailureError";
  }
}

export interface EngineYdocProviderSessionOptions {
  transport: EngineTransport;
  // Share ONE adapter across every doc on a given transport so request ids stay
  // unique per session generation (bot #3601684269). When omitted a private
  // adapter is created and disposed with this session; a shared adapter is
  // never disposed here. R13's framed transport should additionally own id
  // allocation as the hard guarantee.
  adapter?: YdocLiveAdapter;
  workspace: string;
  versionId: string;
  path: string;
  contentKind?: YdocContentKind;
  // Forwarded to the adapter: false when the caller already holds the
  // document's canonical state and will replay it into this generation.
  seedAbsentLineage?: boolean;
  onRemoteUpdate: (update: Uint8Array) => void;
  onRemoteApplyError?: (error: RemoteYdocApplyError) => void;
  onLocalEditError?: (error: unknown) => void;
  onResyncNeeded?: (error: YdocResyncNeededError) => void;
  onSessionError?: (error: unknown) => void;
  // A settle is going to the engine now, identified by `token`. Every
  // outcome below echoes the SAME token, so a caller pairs start to outcome
  // by identity — never by arrival order. Order is not a sound basis here: an
  // aborting settle never reaches settleChain and so completes out of start
  // order, and settleChain is per GENERATION while a caller's bookkeeping is
  // per session. This is what lets a caller report a HONEST save state.
  onSettleStart?: (token: number) => void;
  // A settle FAILED. The debounced settle is the only path that writes the
  // user's edits to the file, so a dropped failure here is silent data loss:
  // the caller must surface it, not just retry-if-reconnectable.
  onSettleError?: (error: unknown, token: number) => void;
  onSettled?: (result: YdocSettleResult, token: number) => void | Promise<void>;
  settleDebounceMs?: number;
  scheduleSettle?: (fn: () => void, ms: number) => () => void;
}

export interface EngineYdocProviderSession {
  readonly doc: Y.Doc;
  readonly initialUpdate: Uint8Array;
  // Optional only for injected test providers. The daemon-backed provider
  // always supplies both values.
  readonly objectId?: string;
  readonly versionId?: string;
  readonly contentKind: YdocContentKind;
  readonly path: string;
  // Whether the ENTERED VERSION has a committed snapshot for this path.
  // "absent" plus a lineage that is also absent means the daemon bound an
  // EMPTY doc over a path the version does not contain: either the caller is
  // creating the file (an empty artifact is on disk, not yet captured), or the
  // path is gone and binding a writable editor to it would materialize a
  // phantom file on the first keystroke. The consumer owns that decision; the
  // contract is stated on `WorkspaceEngineCapture.openYDocSession`.
  readonly head: "present" | "absent";
  // Whether the daemon resumed durable CRDT state for this object. Read WITH
  // `head`: head-absent plus lineage-existing is a crash-orphaned draft the
  // daemon deliberately resurrects, and its CRDT rows are the only copy of
  // those edits.
  readonly lineage: "existing" | "absent";
  applyLocalUpdate(update: Uint8Array): Promise<void>;
  settleNow(options?: { summary?: string }): Promise<YdocSettleResult>;
  applyExternalMarkdownEdit(
    markdown: string,
  ): Promise<YdocApplyExternalMarkdownEditResult>;
  // `settle: false` alone does NOT promise the file will be left alone: a
  // release the daemon refuses as unsettled ESCALATES to a settling close, so
  // pending edits survive a transient failure. A caller that must never
  // materialize this path has to say so with `settleOnRefusal: false`, which
  // turns that escalation off and surfaces the refusal instead.
  close(options?: {
    settle?: boolean;
    summary?: string;
    settleOnRefusal?: boolean;
  }): Promise<void>;
  // End the session while writing NOTHING and discarding NOTHING: the daemon
  // drops the session and its lease and leaves the durable lineage alone, so
  // the next open resurrects this document's edits. The exit for a session
  // that may not settle (the artifact is not this session's to write) and
  // cannot prune (no artifact holds its CRDT's bytes), which would otherwise
  // hold its lease until the daemon restarts (#665).
  evict(): Promise<void>;
}

export async function openEngineYdocProviderSession(
  options: EngineYdocProviderSessionOptions,
): Promise<EngineYdocProviderSession> {
  const ownsAdapter = options.adapter === undefined;
  const adapter = options.adapter ?? new YdocLiveAdapter(options.transport);
  let session: YdocAdapterSession;
  try {
    session = await adapter.openSession({
      workspace: options.workspace,
      versionId: options.versionId,
      path: options.path,
      ...(options.contentKind ? { contentKind: options.contentKind } : {}),
      ...(options.seedAbsentLineage !== undefined
        ? { seedAbsentLineage: options.seedAbsentLineage }
        : {}),
    });
  } catch (error) {
    if (ownsAdapter) adapter.dispose();
    throw error;
  }

  const settleDebounceMs =
    options.settleDebounceMs ?? DEFAULT_SETTLE_DEBOUNCE_MS;
  const scheduleSettle =
    options.scheduleSettle ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });

  let closed = false;
  let closeComplete = false;
  let journalChain: Promise<void> = Promise.resolve();
  let settleChain: Promise<void> = Promise.resolve();
  let cancelSettle: (() => void) | null = null;
  let localEditError: unknown = null;
  let closeError: unknown = null;

  function notifyError(
    callback: ((error: unknown) => void) | undefined,
    error: unknown,
  ): void {
    try {
      callback?.(error);
    } catch {
      // Provider error callbacks are observer boundaries and cannot be allowed
      // to re-enter Yjs or the transport dispatcher.
    }
  }

  // Monotonic per-session settle identity. Never reused, so a token can only
  // ever name the one settle that minted it.
  let settleTokens = 0;

  function notifySettleError(error: unknown, token: number): void {
    try {
      options.onSettleError?.(error, token);
    } catch {
      // Observer boundary: a status hook must never re-enter the transport.
    }
  }

  function rememberLocalEditError(error: unknown): void {
    if (localEditError === null) localEditError = error;
    notifyError(options.onLocalEditError, error);
  }

  async function runSettle(summary?: string): Promise<YdocSettleResult> {
    // One identity per settle, echoed by whichever outcome this run produces.
    // Callers pair on it instead of on arrival order, which does NOT hold:
    // the two abort paths below throw before reaching settleChain, so an
    // aborting settle completes ahead of settles that queued earlier.
    //
    // Announced before those aborts so every outcome has a matching start.
    const token = ++settleTokens;
    try {
      options.onSettleStart?.(token);
    } catch {
      // Observer boundary, like notifyError.
    }
    // A journal failure means the edit never reached the engine AT ALL —
    // strictly worse than a failed settle, and it aborts this settle before
    // the chain below. Report it on the same channel: otherwise it routes
    // only to onSessionError, which the desktop wires to a reconnect handler
    // that drops anything non-reconnect, and the document sits on "Saving…"
    // forever with nothing logged.
    try {
      await journalChain;
      // AFTER the chain, so writes already in flight keep their order, and
      // BEFORE the settle, which must never commit a projection the engine is
      // still missing text for. A refusal here aborts this settle exactly as a
      // journal failure does, and the ladder tries again.
      await session.resendMissingState();
    } catch (error) {
      notifySettleError(error, token);
      throw error;
    }
    // A SYNCHRONOUS applyLocalUpdate throw records the error without ever
    // attaching it to journalChain, so the await above resolves clean.
    if (localEditError !== null) {
      notifySettleError(localEditError, token);
      throw localEditError;
    }
    const operation = settleChain.then(async () => {
      try {
        const result = await session.settle(
          summary !== undefined ? { summary } : undefined,
        );
        // onSettled is what lands the .md; its failure is a save failure too.
        await options.onSettled?.(result, token);
        // Any settle that reached disk resets the retry ladder.
        transientRetryMs = settleDebounceMs;
        return result;
      } catch (error) {
        notifySettleError(error, token);
        throw error;
      }
    });
    settleChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  // A settle refused by a transient condition retries on a doubling delay
  // until the condition clears (#554, #658). Without this, the work sat
  // undone until an unrelated future edit triggered another settle, while the
  // document read as saved-or-failed with the on-disk artifact stale. A newer
  // armed settle (an edit during the backoff) owns the timer instead — an
  // edit is the strongest retry trigger there is. A terminal refusal never
  // retries: a stale target cannot be helped by trying again.
  let transientRetryMs = settleDebounceMs;

  function scheduleTransientSettleRetry(error: unknown): void {
    const capMs = settleRetryCapMs(error);
    if (closed || cancelSettle !== null || capMs === null) return;
    // The cap belongs to THIS failure, so a ladder that walked out behind a
    // file lock cannot make the next busy-database wait ten seconds.
    const delay = Math.min(transientRetryMs, capMs);
    transientRetryMs = Math.min(delay * 2, capMs);
    cancelSettle = scheduleSettle(() => {
      cancelSettle = null;
      void runSettle().catch((retryError: unknown) => {
        notifyError(options.onSessionError, retryError);
        scheduleTransientSettleRetry(retryError);
      });
    }, delay);
  }

  function requestSettle(): void {
    cancelSettle?.();
    cancelSettle = scheduleSettle(() => {
      cancelSettle = null;
      void runSettle().catch((error: unknown) => {
        notifyError(options.onSessionError, error);
        scheduleTransientSettleRetry(error);
      });
    }, settleDebounceMs);
  }

  const unsubscribeRemote = session.onRemoteUpdate((update) => {
    if (closed) return;
    options.onRemoteUpdate(update);
    requestSettle();
  });
  const unsubscribeRemoteError = session.onRemoteApplyError((error) => {
    options.onRemoteApplyError?.(error);
  });
  const unsubscribeResync = session.onResyncNeeded((error) => {
    options.onResyncNeeded?.(error);
  });
  const unsubscribeSessionError = session.onSessionError((error) => {
    notifyError(options.onSessionError, error);
  });

  async function beginTeardown(): Promise<boolean> {
    if (closeComplete) return true;
    closed = true;
    cancelSettle?.();
    cancelSettle = null;
    unsubscribeRemote();
    unsubscribeRemoteError();
    unsubscribeResync();
    unsubscribeSessionError();
    await journalChain.catch(() => undefined);
    await settleChain.catch(() => undefined);
    return false;
  }

  return {
    doc: session.doc,
    initialUpdate: session.initialUpdate,
    objectId: session.objectId,
    versionId: options.versionId,
    contentKind: session.contentKind,
    path: session.path,
    head: session.head,
    lineage: session.lineage,

    applyLocalUpdate(update) {
      if (closed) {
        if (closeComplete) return Promise.resolve();
        return Promise.reject(
          localEditError ??
            closeError ??
            new Error(
              `Y.Doc provider session for ${options.path} is closing and has not released its daemon session.`,
            ),
        );
      }
      let operation: Promise<unknown>;
      try {
        operation = session.applyLocalUpdate(update);
      } catch (error) {
        rememberLocalEditError(error);
        throw error;
      }
      // The caller hears the truth about ITS update; the chain carries the
      // ordering. They are separate promises because a transient refusal must
      // reject one and not the other: a chain left rejected answers every
      // later settle with the same stale failure, and nothing would ever send
      // the engine the text it is complaining about (#658).
      const journaled = journalChain
        .then(() => operation)
        .then(() => undefined);
      journalChain = journaled.catch((error: unknown) => {
        // The SESSION records the debt — it is what the engine refused, and
        // its `resendMissingState` is a no-op when none is owed — so nothing
        // here has to keep a copy that could go stale.
        if (isTransientEngineRefusal(error)) return;
        rememberLocalEditError(error);
        throw error;
      });
      void journalChain.catch(() => undefined);
      requestSettle();
      return journaled;
    },

    async settleNow(settleOptions) {
      cancelSettle?.();
      cancelSettle = null;
      const operation = runSettle(settleOptions?.summary);
      // The caller gets the rejection; the retry is armed here too, because
      // an explicit flush that hit the lock leaves the same durably pending
      // write as a debounced one.
      operation.catch((error: unknown) => {
        scheduleTransientSettleRetry(error);
      });
      return operation;
    },

    async applyExternalMarkdownEdit(markdown) {
      // The adapter flushes its record chain before merging, so the engine
      // merges against fully-recorded state rather than a stale doc. That
      // flush cannot see what a TRANSIENT refusal left unsent: the chain is
      // neutralized after one, so awaiting it succeeds while the engine is
      // still missing this session's text — and the merge would then run
      // against a document without it, reordering or dropping the user's
      // edit inside the canonical Y.Doc.
      //
      // Send it first, exactly as a settle does, and for the same reason: no
      // operation that reads durable state may run while durable state is
      // known to be behind (#658).
      await session.resendMissingState();
      return await session.applyExternalMarkdownEdit(markdown);
    },

    async close(closeOptions) {
      if (await beginTeardown()) return;
      let preCloseError: unknown;
      if (
        closeOptions?.settle !== false &&
        localEditError === null
      ) {
        try {
          await runSettle(closeOptions?.summary ?? "session close");
        } catch (error) {
          preCloseError = error;
        }
      }
      // Hand over anything the engine is still missing, whatever `settle`
      // says. `settle: false` declines the ARTIFACT; it does not decline the
      // user's text, and a caller that skips the settle above (a version
      // switch, a rename, the vacate before a delete) would otherwise release
      // a session holding the only copy of it.
      if (preCloseError === undefined) {
        try {
          await session.resendMissingState();
        } catch (error) {
          preCloseError = error;
        }
      }
      // Releasing while the engine is STILL behind discards that only copy:
      // the doc holding the text goes away with the release, and a caller
      // that saw a clean "released, settle failed" would arm a retry that
      // reopens, settles what the lineage holds, and reports a save of a
      // document missing the edit.
      //
      // Only for a TRANSIENT failure, which is the one class the close ladder
      // above retries. A terminal refusal cannot be waited out, so refusing
      // the teardown for one would wedge the entry forever holding a lease
      // nobody can release — worse than reporting the loss (#658).
      if (session.missingLocalState && isTransientEngineRefusal(preCloseError)) {
        throw preCloseError;
      }
      try {
        try {
          await session.close({ settle: false });
        } catch (error) {
          // The escalation preserves pending edits through a transient
          // failure, and it is right for every ordinary teardown. It is
          // WRONG for a caller releasing a session it is about to declare
          // absent: the daemon refuses the release precisely BECAUSE the
          // lineage holds content, and settling it writes the file that
          // caller is about to say does not exist. `settleOnRefusal: false`
          // hands the refusal back instead, and the daemon keeps the session
          // (ydoc_close_inner reinserts it), so the caller still has a live
          // session to decide about.
          if (closeOptions?.settleOnRefusal === false) throw error;
          // Escalate to a settling close after a transient failure so
          // pending edits are preserved.
          await session.close({ settle: true });
        }
        if (ownsAdapter) adapter.dispose();
        closeComplete = true;
        closeError = null;
      } catch (error) {
        closeError = error;
        throw error;
      }
      if (preCloseError !== undefined) {
        throw new YdocReleasedWithSettleFailureError(options.path, preCloseError);
      }
    },

    async evict() {
      if (await beginTeardown()) return;
      // No settle: an evict declines the ARTIFACT. It does not decline the
      // user's text, and the durable lineage is the only place that text
      // survives the teardown — so hand over anything the engine is still
      // missing, exactly as a close does. A transient refusal is what leaves
      // a debt here, and `resendMissingState` is a no-op when none is owed.
      let resendError: unknown;
      try {
        await session.resendMissingState();
      } catch (error) {
        resendError = error;
      }
      // Evicting while the engine is STILL behind discards the only copy: the
      // doc holding the text goes away with the session. Refuse only for a
      // TRANSIENT failure, the one class a retry can clear — a terminal
      // refusal cannot be waited out, and wedging the entry forever holding a
      // lease nobody can release is worse than reporting the loss (#658).
      if (session.missingLocalState && isTransientEngineRefusal(resendError)) {
        closeError = resendError;
        throw resendError;
      }
      try {
        await session.evict();
      } catch (error) {
        closeError = error;
        throw error;
      }
      if (ownsAdapter) adapter.dispose();
      closeComplete = true;
      closeError = null;
    },
  };
}
