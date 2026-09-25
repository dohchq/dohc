import type * as Y from "yjs";
import {
  isEngineStoreBusyRefusal,
  isTransientEngineRefusal,
} from "../live/daemonLiveAdapter";
import {
  RemoteYdocApplyError,
  YdocLiveAdapter,
  YdocOwnerDraftPendingError,
  type ApplyLocalUpdateOptions,
  type YdocResyncNeededError,
  type EngineTransport,
  type YdocAdapterSession,
} from "./ydocLiveAdapter";
import type {
  YdocContentKind,
  ArtifactAssetDescriptor,
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

// How far this failure's retry ladder may walk out, or null for a terminal refusal.
// Every other settle failure answers no: a preimage that no longer matches, a
// target turned read-only, an ACL that denies the replace.
//
// `isTransientEngineRefusal` owns MEMBERSHIP of the retryable class, in one
// place at the protocol boundary. This owns only how long each member may be
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
  // Share one adapter across every doc on a given transport so request ids stay
  // unique per session generation (bot #3601684269). When omitted a private
  // adapter is created and disposed with this session; a shared adapter is
  // never disposed here. R13's framed transport should additionally own id
  // allocation as the hard guarantee.
  adapter?: YdocLiveAdapter;
  workspace: string;
  versionId: string;
  path: string;
  expectedObjectId?: string;
  contentKind?: YdocContentKind;
  // Forwarded to the adapter: false when the caller already holds the
  // document's canonical state and will replay it into this generation.
  seedAbsentLineage?: boolean;
  onRemoteUpdate: (update: Uint8Array) => void;
  onRemoteApplyError?: (error: RemoteYdocApplyError) => void;
  onLocalEditError?: (error: unknown) => void;
  onResyncNeeded?: (error: YdocResyncNeededError) => void;
  onLineageReplaced?: (doc: Y.Doc, recoveredPaths: string[]) => void;
  onSessionError?: (error: unknown) => void;
  // A settle is going to the engine now, identified by `token`. Every
  // outcome below echoes the same token, so a caller pairs start to outcome
  // by identity. The chain belongs to one provider generation; a caller can
  // retain bookkeeping across several generations.
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
  readonly nativeOwner?: {
    readonly sessionId: string;
    flush(): Promise<void>;
    applyRemoteUpdate(update: Uint8Array): Promise<void>;
    onDurableLocalChange(handler: () => void): () => void;
  };
  readonly doc: Y.Doc;
  readonly initialUpdate: Uint8Array;
  // Injected test providers may omit these values. The daemon open response
  // supplies objectId.
  readonly objectId?: string;
  // The provider echoes the requested versionId.
  readonly versionId?: string;
  readonly lineageClaimId?: string | null;
  // Whether this device claimed the lineage from its own unclaimed history.
  readonly lineageOriginatedHere?: boolean;
  readonly contentKind: YdocContentKind;
  readonly artifactAssets?: readonly ArtifactAssetDescriptor[];
  readonly path: string;
  // Whether the ENTERED VERSION has a committed snapshot for this path.
  // "absent" plus a lineage that is also absent means the daemon bound an
  // empty doc over a path the version does not contain: either the caller is
  // creating the file (an empty artifact is on disk, not yet captured), or the
  // path is gone and binding a writable editor to it would materialize a
  // phantom file on the first keystroke. The consumer owns that decision; the
  // contract is stated on `WorkspaceEngineCapture.openYDocSession`.
  readonly head: "present" | "absent";
  // Whether the daemon resumed durable CRDT state for this object. Read with
  // `head`: head-absent plus lineage-existing is a crash-orphaned draft the
  // daemon deliberately resurrects, and its CRDT rows are the only copy of
  // those edits.
  readonly lineage: "existing" | "absent";
  // `armSettle: false` journals the update without scheduling a settle, for
  // a replay the file must not receive until the person edits again.
  applyLocalUpdate(
    update: Uint8Array,
    options?: ApplyLocalUpdateOptions & { armSettle?: boolean },
  ): Promise<void>;
  settleNow(options?: { summary?: string }): Promise<YdocSettleResult>;
  // `settle: false` alone does not promise the file will be left alone: a
  // release the daemon refuses as unsettled escalates to a settling close, so
  // pending edits survive a transient failure. A caller that must never
  // materialize this path has to say so with `settleOnRefusal: false`, which
  // turns that escalation off and surfaces the refusal instead.
  close(options?: {
    settle?: boolean;
    summary?: string;
    settleOnRefusal?: boolean;
  }): Promise<void>;
  // End the session while writing nothing and discarding nothing: the daemon
  // drops the session and its lease and leaves the durable lineage alone, so
  // the next open resurrects this document's edits. The exit for a session
  // that may not settle (the artifact is not this session's to write) and
  // cannot prune (no artifact holds its CRDT's bytes), which would otherwise
  // hold its lease until the daemon restarts.
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
      ...(options.expectedObjectId
        ? { expectedObjectId: options.expectedObjectId }
        : {}),
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
    if (error instanceof YdocOwnerDraftPendingError) return;
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
    // Each outcome names its settle, including a failure before the native write.
    const token = ++settleTokens;
    try {
      options.onSettleStart?.(token);
    } catch {
      // Observer boundary, like notifyError.
    }
    // Register recovery before awaiting it so teardown waits for the whole write.
    const operation = settleChain.then(async () => {
      try {
        await journalChain;
        await session.resyncIfNeeded();
        await session.resendMissingState();
        if (localEditError !== null) throw localEditError;
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
  // until the condition clears. Without this, the work sat
  // undone until an unrelated future edit triggered another settle, while the
  // document read as saved-or-failed with the on-disk artifact stale. A newer
  // armed settle (an edit during the backoff) owns the timer instead — an
  // edit is the strongest retry trigger there is. A terminal refusal never
  // retries: a stale target cannot be helped by trying again.
  let transientRetryMs = settleDebounceMs;

  function scheduleTransientSettleRetry(error: unknown): void {
    const capMs = settleRetryCapMs(error);
    if (closed || cancelSettle !== null || capMs === null) return;
    // The cap belongs to this failure, so a ladder that walked out behind a
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
  const unsubscribeReplacement = session.onLineageReplaced(
    (replacement, recoveredPaths) => {
      options.onLineageReplaced?.(replacement, recoveredPaths);
    },
  );
  const unsubscribeSessionError = session.onSessionError((error) => {
    notifyError(options.onSessionError, error);
    scheduleTransientSettleRetry(error);
  });
  const unsubscribeOwnerDraft = session.onOwnerDraftChanged(() => {
    if (!closed) requestSettle();
  });
  if (session.ownerDraft) requestSettle();

  async function beginTeardown(): Promise<boolean> {
    if (closeComplete) return true;
    closed = true;
    cancelSettle?.();
    cancelSettle = null;
    unsubscribeRemote();
    unsubscribeRemoteError();
    unsubscribeResync();
    unsubscribeReplacement();
    unsubscribeSessionError();
    unsubscribeOwnerDraft();
    await journalChain.catch(() => undefined);
    await settleChain.catch(() => undefined);
    return false;
  }

  return {
    nativeOwner: {
      get sessionId() { return session.sessionId; },
      onDurableLocalChange: handler => session.onDurableLocalChange(handler),
      async flush() {
        if (closed) throw new Error("Owner session is closed.");
        await journalChain;
        await session.resendMissingState();
        if (localEditError !== null) throw localEditError;
      },
      async applyRemoteUpdate(update) {
        if (closed) throw new Error("Owner session is closed.");
        // Native application already committed. Event sequence tracking stays
        // with the daemon event lane; duplicate CRDT delivery is idempotent.
        session.receiveRemoteUpdate(update);
      },
    },
    get doc() {
      return session.doc;
    },
    initialUpdate: session.initialUpdate,
    objectId: session.objectId,
    versionId: options.versionId,
    get lineageClaimId() {
      return session.lineageClaimId;
    },
    get lineageOriginatedHere() {
      return session.lineageOriginatedHere;
    },
    contentKind: session.contentKind,
    get artifactAssets() {
      return session.artifactAssets;
    },
    path: session.path,
    head: session.head,
    lineage: session.lineage,

    applyLocalUpdate(update, applyOptions) {
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
      const { armSettle = true, ...recordOptions } = applyOptions ?? {};
      let operation: Promise<unknown>;
      try {
        operation = session.applyLocalUpdate(update, recordOptions);
      } catch (error) {
        rememberLocalEditError(error);
        throw error;
      }
      // The caller hears the truth about its update; the chain carries the
      // ordering. They are separate promises because a transient refusal must
      // reject one and not the other: a chain left rejected answers every
      // later settle with the same stale failure, and nothing would ever send
      // the engine the text it is complaining about.
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
      if (armSettle) requestSettle();
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

    async close(closeOptions) {
      if (await beginTeardown()) return;
      let preCloseError: unknown;
      if (
        closeOptions?.settle !== false &&
        session.ownerDraft === undefined &&
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
      // Releasing while the engine is still behind discards that only copy:
      // the doc holding the text goes away with the release, and a caller
      // that saw a clean "released, settle failed" would arm a retry that
      // reopens, settles what the lineage holds, and reports a save of a
      // document missing the edit.
      //
      // Only for a TRANSIENT failure, which is the one class the close ladder
      // above retries. A terminal refusal cannot be waited out, so refusing
      // the teardown for one would wedge the entry forever holding a lease
      // nobody can release — worse than reporting the loss.
      if (session.missingLocalState && isTransientEngineRefusal(preCloseError)) {
        throw preCloseError;
      }
      try {
        try {
          await session.close({ settle: false });
        } catch (error) {
          // The escalation preserves pending edits through a transient
          // failure, and it is right for every ordinary teardown. It is
          // wrong for a caller releasing a session it is about to declare
          // absent: the daemon refuses the release precisely because the
          // lineage holds content, and settling it writes the file that
          // caller is about to say does not exist. `settleOnRefusal: false`
          // hands the refusal back instead, and the daemon keeps the session
          // (ydoc_close_inner reinserts it), so the caller still has a live
          // session to decide about.
          if (closeOptions?.settleOnRefusal === false || session.ownerDraft) throw error;
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
      // Evicting while the engine is still behind discards the only copy: the
      // doc holding the text goes away with the session. Refuse only for a
      // TRANSIENT failure, the one class a retry can clear — a terminal
      // refusal cannot be waited out, and wedging the entry forever holding a
      // lease nobody can release is worse than reporting the loss.
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
