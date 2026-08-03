import type * as Y from "yjs";
import {
  isFileLockedRefusal,
  isYdocSessionNotFoundRefusal,
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
        // Any settle that reached disk resets the lock-retry ladder.
        lockedRetryMs = settleDebounceMs;
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

  // A settle refused `file-locked` retries on a doubling delay until the
  // external handle releases (#554). Without this, the durable write job sat
  // pending until an unrelated future edit triggered another settle, while
  // the document read as saved-or-failed with the on-disk artifact stale. A
  // newer armed settle (an edit during the backoff) owns the timer instead —
  // an edit is the strongest retry trigger there is. Non-lock failures never
  // retry: a stale-target refusal cannot be helped by trying again.
  let lockedRetryMs = settleDebounceMs;

  function scheduleLockedRetry(error: unknown): void {
    if (closed || cancelSettle !== null || !isFileLockedRefusal(error)) return;
    const delay = lockedRetryMs;
    lockedRetryMs = Math.min(lockedRetryMs * 2, LOCKED_SETTLE_RETRY_CAP_MS);
    cancelSettle = scheduleSettle(() => {
      cancelSettle = null;
      void runSettle().catch((retryError: unknown) => {
        notifyError(options.onSessionError, retryError);
        scheduleLockedRetry(retryError);
      });
    }, delay);
  }

  function requestSettle(): void {
    cancelSettle?.();
    cancelSettle = scheduleSettle(() => {
      cancelSettle = null;
      void runSettle().catch((error: unknown) => {
        notifyError(options.onSessionError, error);
        scheduleLockedRetry(error);
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

  return {
    doc: session.doc,
    initialUpdate: session.initialUpdate,
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
      journalChain = journalChain
        .then(() => operation)
        .then(() => undefined)
        .catch((error: unknown) => {
          rememberLocalEditError(error);
          throw error;
        });
      void journalChain.catch(() => undefined);
      requestSettle();
      return journalChain;
    },

    async settleNow(settleOptions) {
      cancelSettle?.();
      cancelSettle = null;
      const operation = runSettle(settleOptions?.summary);
      // The caller gets the rejection; the retry is armed here too, because
      // an explicit flush that hit the lock leaves the same durably pending
      // write as a debounced one.
      operation.catch((error: unknown) => {
        scheduleLockedRetry(error);
      });
      return operation;
    },

    applyExternalMarkdownEdit(markdown) {
      return session.applyExternalMarkdownEdit(markdown);
    },

    async close(closeOptions) {
      if (closeComplete) return;
      closed = true;
      cancelSettle?.();
      cancelSettle = null;
      unsubscribeRemote();
      unsubscribeRemoteError();
      unsubscribeResync();
      unsubscribeSessionError();
      await journalChain.catch(() => undefined);
      await settleChain.catch(() => undefined);
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
      try {
        try {
          await session.close({ settle: false });
        } catch (error) {
          if (!isYdocSessionNotFoundRefusal(error)) {
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
            try {
              // Escalate to a settling close after a transient failure so
              // pending edits are preserved.
              await session.close({ settle: true });
            } catch (settlingCloseError) {
              if (!isYdocSessionNotFoundRefusal(settlingCloseError)) {
                throw settlingCloseError;
              }
            }
          }
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
  };
}
