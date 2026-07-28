import type * as Y from "yjs";
import { isYdocSessionNotFoundRefusal } from "../live/daemonLiveAdapter";
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
  onRemoteUpdate: (update: Uint8Array) => void;
  onRemoteApplyError?: (error: RemoteYdocApplyError) => void;
  onLocalEditError?: (error: unknown) => void;
  onResyncNeeded?: (error: YdocResyncNeededError) => void;
  onSessionError?: (error: unknown) => void;
  onSettled?: (result: YdocSettleResult) => void | Promise<void>;
  settleDebounceMs?: number;
  scheduleSettle?: (fn: () => void, ms: number) => () => void;
}

export interface EngineYdocProviderSession {
  readonly doc: Y.Doc;
  readonly initialUpdate: Uint8Array;
  readonly contentKind: YdocContentKind;
  readonly path: string;
  applyLocalUpdate(update: Uint8Array): Promise<void>;
  settleNow(options?: { summary?: string }): Promise<YdocSettleResult>;
  applyExternalMarkdownEdit(
    markdown: string,
  ): Promise<YdocApplyExternalMarkdownEditResult>;
  close(options?: { settle?: boolean; summary?: string }): Promise<void>;
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

  function rememberLocalEditError(error: unknown): void {
    if (localEditError === null) localEditError = error;
    notifyError(options.onLocalEditError, error);
  }

  async function runSettle(summary?: string): Promise<YdocSettleResult> {
    await journalChain;
    if (localEditError !== null) throw localEditError;
    const operation = settleChain.then(async () => {
      const result = await session.settle(
        summary !== undefined ? { summary } : undefined,
      );
      await options.onSettled?.(result);
      return result;
    });
    settleChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  function requestSettle(): void {
    cancelSettle?.();
    cancelSettle = scheduleSettle(() => {
      cancelSettle = null;
      void runSettle().catch((error: unknown) => {
        notifyError(options.onSessionError, error);
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
      return runSettle(settleOptions?.summary);
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
