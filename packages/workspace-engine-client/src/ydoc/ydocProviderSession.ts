import type * as Y from "yjs";
import {
  RemoteYdocApplyError,
  YdocLiveAdapter,
  type EngineTransport,
  type YdocAdapterSession,
} from "./ydocLiveAdapter";
import type {
  YdocApplyExternalMarkdownEditResult,
  YdocContentKind,
  YdocSettleResult,
} from "./ydocWireContract";

const DEFAULT_SETTLE_DEBOUNCE_MS = 800;

export interface EngineYdocProviderSessionOptions {
  transport: EngineTransport;
  workspace: string;
  versionId: string;
  path: string;
  contentKind?: YdocContentKind;
  onRemoteUpdate: (update: Uint8Array) => void;
  onRemoteApplyError?: (error: RemoteYdocApplyError) => void;
  onSettled?: (result: YdocSettleResult) => void | Promise<void>;
  settleDebounceMs?: number;
  scheduleSettle?: (fn: () => void, ms: number) => () => void;
}

export interface EngineYdocProviderSession {
  readonly doc: Y.Doc;
  readonly initialUpdate: Uint8Array;
  readonly contentKind: YdocContentKind;
  readonly path: string;
  applyLocalUpdate(update: Uint8Array): void;
  settleNow(options?: { summary?: string }): Promise<YdocSettleResult>;
  applyExternalMarkdownEdit(
    markdown: string,
  ): Promise<YdocApplyExternalMarkdownEditResult>;
  close(options?: { settle?: boolean; summary?: string }): Promise<void>;
}

export async function openEngineYdocProviderSession(
  options: EngineYdocProviderSessionOptions,
): Promise<EngineYdocProviderSession> {
  const adapter = new YdocLiveAdapter(options.transport);
  let session: YdocAdapterSession;
  try {
    session = await adapter.openSession({
      workspace: options.workspace,
      versionId: options.versionId,
      path: options.path,
      ...(options.contentKind ? { contentKind: options.contentKind } : {}),
    });
  } catch (error) {
    adapter.dispose();
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

  async function runSettle(summary?: string): Promise<YdocSettleResult> {
    await journalChain;
    let result!: YdocSettleResult;
    let settleError: unknown;
    settleChain = settleChain
      .then(async () => {
        result = await session.settle(
          summary !== undefined ? { summary } : undefined,
        );
        await options.onSettled?.(result);
      })
      .catch((error: unknown) => {
        settleError = error;
      });
    await settleChain;
    if (settleError !== undefined) throw settleError;
    return result;
  }

  function requestSettle(): void {
    cancelSettle?.();
    cancelSettle = scheduleSettle(() => {
      cancelSettle = null;
      void runSettle().catch(() => undefined);
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

  return {
    doc: session.doc,
    initialUpdate: session.initialUpdate,
    contentKind: session.contentKind,
    path: session.path,

    applyLocalUpdate(update) {
      if (closed) return;
      // Validation and live-doc apply happen synchronously before the promise.
      const operation = session.applyLocalUpdate(update);
      journalChain = journalChain
        .then(() => operation)
        .then(() => undefined)
        .catch(() => undefined);
      requestSettle();
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
      await journalChain;
      await settleChain;
      if (closeOptions?.settle !== false) {
        await runSettle(closeOptions?.summary ?? "session close");
      }
      await session.close({ settle: false });
      adapter.dispose();
      closeComplete = true;
    },
  };
}
