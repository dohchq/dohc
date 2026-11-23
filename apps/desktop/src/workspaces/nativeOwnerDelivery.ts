import { isDeepStrictEqual } from "node:util";
import { OwnerYDocOutbox } from "@dohc/workspace-engine-client";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { OwnerYDocFrameDelivery, type OwnerAcceptedState } from "./ownerYDocFrameDelivery";
import { OwnerYDocOutboxDrainer, type OwnerKnownRefusals } from "./ownerYDocOutbox";
import type {
  DesktopOwnerDeliveryConfig,
  DesktopOwnerDeliveryDocument,
} from "./desktopOwnerDelivery";
import { isOwnerDeliveryBackoff } from "./ownerDeliveryBackoff";

export { OwnerKnownRefusals } from "./ownerYDocOutbox";

type DrainResult = Awaited<ReturnType<OwnerYDocOutboxDrainer["drainOnce"]>>;

interface NativeOwnerDeliveryPassOptions {
  client: EngineClient;
  workspaceHandle: string;
  document: DesktopOwnerDeliveryDocument;
  config: DesktopOwnerDeliveryConfig;
  /** Kept by the caller across passes, so a refusal received once is recorded, not admitted again. */
  refusals: OwnerKnownRefusals;
  signal: AbortSignal;
  /** The bearer and its account come from one credential; assertCurrent retires both. */
  bearer: string;
  accountId: string;
  assertCurrent(): void;
  /** Enrollment can set aside an older queue even when this pass sends nothing. */
  onEnrolled?(): Promise<void>;
  /** Never enrolls: an unbound document returns "unbound", and an answer counts only after an opening sync installed. */
  observedOnly?: boolean;
  /**
   * The server list's `head` for this note. When this computer has applied exactly that far and
   * holds no edit for it, the pass returns "empty" without opening the note's connection.
   * Equal numbers can still differ in content, as after the server restores an older backup;
   * the caller's periodic full pass covers that.
   */
  serverHead?: number;
  /**
   * Keeps the note's connection open after its queue empties: each edit goes
   * as soon as it lands, and the room's edits reach the owner's screen. The
   * pass ends when `signal` ends or the connection closes.
   */
  lasting?: OwnerLastingEdits;
  /** Runs each engine call. A lasting pass takes the workspace session one call at a time. */
  hold?<T>(work: () => Promise<T>): Promise<T>;
}

/** The edits that land in the workspace, for a lasting pass. */
export interface OwnerLastingEdits {
  /** How many edits landed so far. */
  count(): number;
  /** Settles once more than `seen` edits landed; rejects when `signal` ends. */
  landed(seen: number, signal: AbortSignal): Promise<void>;
  /** The relay took one of this note's edits. */
  acknowledged(): void;
}

/** The authority lease and engine session must remain held until this pass settles. */
export function runNativeOwnerDeliveryPass(
  options: NativeOwnerDeliveryPassOptions & { observedOnly: true },
): Promise<DrainResult | "unbound">;
export function runNativeOwnerDeliveryPass(
  options: NativeOwnerDeliveryPassOptions & { observedOnly?: false },
): Promise<DrainResult>;
export async function runNativeOwnerDeliveryPass(
  options: NativeOwnerDeliveryPassOptions,
): Promise<DrainResult | "unbound"> {
  const { client, document, config, signal } = options;
  const pending = new Set<Promise<unknown>>();
  const check = () => {
    signal.throwIfAborted();
    options.assertCurrent();
  };
  async function guarded<T>(
    work: (signal: AbortSignal) => Promise<T>,
    attemptSignal = signal,
  ): Promise<T> {
    check();
    const currentSignal = AbortSignal.any([signal, attemptSignal]);
    currentSignal.throwIfAborted();
    const task = options.hold ? options.hold(() => work(currentSignal)) : work(currentSignal);
    pending.add(task);
    try {
      const result = await task;
      currentSignal.throwIfAborted();
      check();
      return result;
    } finally {
      pending.delete(task);
    }
  }
  const target = {
    binding: document.binding,
    relayDatabaseNamespace: document.relayDatabaseNamespace,
  };
  const request = () => ({
    id: 0,
    workspace: options.workspaceHandle,
    deadlineMs: config.attemptTimeoutMs,
  });
  let preparation: Awaited<ReturnType<EngineClient["ownerYDocPrepareEnrollment"]>> | undefined;
  let position:
    | { revision: number; acceptedCursor: number; nativeHeadSequence: number }
    | undefined;
  function bound(binding: typeof document.binding) {
    check();
    if (!isDeepStrictEqual(binding, target.binding))
      throw new Error("Owner delivery binding changed.");
  }
  function prior() {
    if (!position) throw new Error("Owner accepted state has not been read.");
    return {
      expectedRevision: position.revision,
      expectedNativeHeadSequence: position.nativeHeadSequence,
      previousAcceptedCursor: position.acceptedCursor,
    };
  }
  const acceptedState: OwnerAcceptedState = {
    async readState(binding, attemptSignal) {
      bound(binding);
      if (preparation?.status === "capture")
        return { stateVector: Uint8Array.of(0), journalCursor: 0 };
      const state = await guarded(
        (signal) => client.ownerYDocReadState(request(), target, signal),
        attemptSignal,
      );
      position = state;
      return { stateVector: state.stateVector, journalCursor: state.acceptedCursor };
    },
    async applyInitialSync(input, attemptSignal) {
      bound(input.binding);
      await guarded(
        (signal) => client.ownerYDocRestartCommittedRows(request(), target.binding, signal),
        attemptSignal,
      );
      if (preparation?.status === "capture") {
        const captured = preparation.captured;
        const draft = await guarded(
          (signal) =>
            client.ownerYDocEnroll(
              request(),
              {
                ...target,
                captured,
                journalCursor: input.appliedThroughJournalCursor,
                hostVector: input.hostVector,
                checkpoint: input.missingStateUpdate,
              },
              signal,
            ),
          attemptSignal,
        );
        preparation = { status: "observed", draft };
        position = draft;
        await options.onEnrolled?.();
        return "applied";
      }
      position = await guarded(
        (signal) =>
          client.ownerYDocApplyInitialSync(
            request(),
            {
              ...target,
              ...prior(),
              journalCursor: input.appliedThroughJournalCursor,
              hostVector: input.hostVector,
              updateBytes: input.missingStateUpdate,
            },
            signal,
          ),
        attemptSignal,
      );
      return "applied";
    },
    async applyAcceptedFrame(input, attemptSignal) {
      bound(input.binding);
      if (input.previousAcceptedCursor !== position?.acceptedCursor) return "retry";
      position = await guarded(
        (signal) =>
          client.ownerYDocApplyAcceptedFrame(
            request(),
            {
              ...target,
              ...prior(),
              journalCursor: input.journalCursor,
              ...(input.rowsThrough === undefined ? {} : { rowsThrough: input.rowsThrough }),
              updateBytes: input.updateBytes,
            },
            signal,
          ),
        attemptSignal,
      );
      return "applied";
    },
    async putRow(input, attemptSignal) {
      bound(input.binding);
      return guarded(
        (signal) =>
          client.ownerYDocPutCommittedRow(
            request(),
            { binding: target.binding, cursor: input.position, updateBytes: input.updateBytes },
            signal,
          ),
        attemptSignal,
      );
    },
  };
  const outbox = new OwnerYDocOutbox(
    { sendRequest: (request) => guarded(() => client.sendRequest(request, signal)) },
    options.workspaceHandle,
  );
  const delivery = new OwnerYDocFrameDelivery({
    relayUrl: config.relayUrl,
    frames: config.frames,
    attemptTimeoutMs: config.attemptTimeoutMs,
    signal,
    acceptedState,
    freshBearer: async () => {
      check();
      return options.bearer;
    },
    authenticatedAccountId: async () => {
      check();
      return options.accountId;
    },
  });
  let drainer: OwnerYDocOutboxDrainer | undefined;
  // One closure watch per route: racing each wait against the route would leave a reaction on it per edit.
  let route: { ended: Promise<void>; closed: AbortSignal } | undefined;
  /** The lasting pass: deliver what waits, then hold the connection open until an edit lands. */
  async function stayOpen(
    lasting: OwnerLastingEdits,
    outboxId: string | null,
  ): Promise<DrainResult> {
    for (;;) {
      const seen = lasting.count();
      // A note's queue starts with its first edit.
      if (outboxId === null) {
        const again = await guarded((signal) =>
          client.ownerYDocPrepareEnrollment(request(), target, signal),
        );
        if (again.status !== "observed") return "retry";
        outboxId = again.draft.outboxId;
      }
      if (outboxId !== null) {
        drainer ??= new OwnerYDocOutboxDrainer(outbox, outboxId, delivery, options.refusals, true);
        const result = await drainer.drainOnce();
        check();
        if (result === "acknowledged") {
          lasting.acknowledged();
          continue;
        }
        if (result !== "empty") return result;
      }
      const authority = await delivery.freshOwnerAuthority(document.binding);
      check();
      if (authority.kind === "quarantine") {
        if (outboxId !== null)
          await outbox.quarantine({
            outboxId,
            reason: authority.reason,
            ...(authority.observedBinding === undefined
              ? {}
              : { observedBinding: authority.observedBinding }),
          });
        return "frozen";
      }
      if (authority.kind !== "authority") return "retry";
      const ended = delivery.ended();
      if (route?.ended !== ended) {
        const closed = new AbortController();
        void ended.then(() => closed.abort());
        route = { ended, closed: closed.signal };
      }
      try {
        await lasting.landed(seen, AbortSignal.any([signal, route.closed]));
      } catch (error) {
        if (signal.aborted || !route.closed.aborted) throw error;
        return "retry";
      }
    }
  }
  const answered = (result: "acknowledged" | "empty") =>
    options.observedOnly && !delivery.synchronized ? "retry" : result;
  try {
    let synchronized = false;
    preparation = await guarded((signal) =>
      client.ownerYDocPrepareEnrollment(request(), target, signal),
    );
    if (options.observedOnly && preparation.status === "capture") return "unbound";
    // This computer closed this generation when its page was retired; its edits wait in a recovery copy.
    if (preparation.status === "retired") return "empty";
    if (
      options.serverHead !== undefined &&
      preparation.status === "observed" &&
      preparation.draft.pendingBytes === 0 &&
      preparation.draft.state !== "quarantined" &&
      preparation.draft.acceptedCursor === options.serverHead &&
      isDeepStrictEqual(preparation.draft.binding, document.binding)
    )
      return "empty";
    if (preparation.status === "capture" || preparation.draft.outboxId === null) {
      const authority = await delivery.freshOwnerAuthority(document.binding);
      check();
      if (authority.kind !== "authority")
        return authority.kind === "quarantine" ? "frozen" : "retry";
      synchronized = true;
      // Re-read durable discovery after uncertain commits and concurrent draft writes.
      preparation = await guarded((signal) =>
        client.ownerYDocPrepareEnrollment(request(), target, signal),
      );
    }
    if (preparation.status === "retired") return "empty";
    if (preparation.status !== "observed") return "retry";
    if (options.lasting) return await stayOpen(options.lasting, preparation.draft.outboxId);
    if (preparation.draft.outboxId === null) return answered("empty");
    // The route answers when the relay takes an edit, before the owner's file holds it.
    drainer = new OwnerYDocOutboxDrainer(
      outbox,
      preparation.draft.outboxId,
      delivery,
      options.refusals,
      true,
    );
    const result = await drainer.drainOnce();
    if (result === "empty" && !synchronized) {
      const authority = await delivery.freshOwnerAuthority(document.binding);
      check();
      if (authority.kind === "quarantine") {
        await outbox.quarantine({
          outboxId: preparation.draft.outboxId,
          reason: authority.reason,
          ...(authority.observedBinding === undefined
            ? {}
            : { observedBinding: authority.observedBinding }),
        });
        return "frozen";
      }
      if (authority.kind !== "authority") return "retry";
    }
    return result === "acknowledged" || result === "empty" ? answered(result) : result;
  } catch (error) {
    if (isOwnerDeliveryBackoff(error)) return "retry";
    throw error;
  } finally {
    drainer?.dispose();
    delivery.dispose();
    outbox.dispose();
    await Promise.allSettled([...pending]);
  }
}
