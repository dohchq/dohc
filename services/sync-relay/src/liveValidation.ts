import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { OrderedLiveUpdateCutPolicy } from "@dohc/ydoc-projection/live-journal-validation";
import type { FirstOpenBaseInput, FirstOpenBaseResult } from "./firstOpenBase.js";
import type { OwnerOutboxAdmission, CapacityLiveAdmissionValidator } from "./ownerOutboxDelivery.js";
import type { OrdinaryActivationValidation, OrdinaryActivationWork } from "./storage/ordinaryActivationValidation.js";
import type { OrdinaryActivationCapacityValidator } from "./storage/ordinaryActivationSource.js";
import type { LiveJournalValidation } from "./storage/types.js";
import type { FirstOpenHistory, FirstOpenHistoryRead } from "./storage/firstOpenHistory.js";
import {WORKER_LIVE_VALIDATION_POLICY} from "@dohc/ydoc-projection/live-journal-validation";
import { liveRestoreValidator, type LiveRestoreReply, type LiveRestoreValidator, type LiveRestoreWork } from "./liveRestoreValidation.js";

export type SettlementNormalizationInput = {
  document: import("@dohc/live-session-contract").LiveDocumentKey;
  currentPath: string;
  checkpoint: Uint8Array;
};
export type SettlementNormalizationResult =
  | {
      kind: "accepted";
      evidence: {
        stateUpdateSha256: string;
        projectedMarkdownSha256: string;
        projectedMarkdownByteLength: number;
      };
    }
  | {
      kind: "refused";
      reason:
        | "invalid-input"
        | "invalid-update"
        | "invalid-schema"
        | "projection-mutated"
        | "capacity-refused";
      source: "call" | "registration-input";
    };
export type LiveValidationWork = ({ policy: OrderedLiveUpdateCutPolicy } & (
  | { kind: "journal"; input: Parameters<OwnerOutboxAdmission["validate"]>[0] }
  | { kind: "settlement"; input: SettlementNormalizationInput }
  | { kind: "activation"; input: OrdinaryActivationWork }
  | { kind: "restore"; input: LiveRestoreWork }
  | { kind: "first-open"; input: FirstOpenBaseInput }
)) | { kind: "first-open-history"; input: FirstOpenHistoryRead };
export type FirstOpenHistoryFailure = {
  kind: "history-error";
  message: string;
  code?: string;
  errcode?: number;
};

type CapacityRetry = {
  kind: "retry";
  reason: "admission-unavailable";
  waitForCapacity(signal?: AbortSignal): Promise<void>;
};
/** How long a first-open build may run. */
export const FIRST_OPEN_BUILD_MS = 60_000;
type Slot = { child: ChildProcess; busy: boolean; auxiliary: boolean; work?: LiveValidationWork["kind"]; note?: string; protected?: boolean; yielded: boolean; heapExhausted: boolean; exited: Promise<void> };
/** How many notes whose build was ended the executor remembers. */
const MAX_ENDED_BUILDS = 4_096;
/** The validator threw instead of judging the edit, so the edit is tried again. */
export class LiveValidatorFailure extends Error {
  constructor(readonly errorClass: string) {
    super(`Live validation failed with ${errorClass}.`);
    this.name = "LiveValidatorFailure";
  }
}
const MAX_LOGGED_VALIDATOR_FAILURES = 1024;
/** Names each validator failure once per document, candidate edit and error class. */
export function createValidatorFailureLog(log: (message: string) => void = message => console.error(message)) {
  const logged = new Set<string>();
  return (document: import("@dohc/live-session-contract").LiveDocumentKey, candidate: Uint8Array, errorClass: string) => {
    const key = JSON.stringify([document.workspaceId, document.mainVersionId, document.objectId, document.lineageClaimId,
      createHash("sha256").update(candidate).digest("hex"), errorClass]);
    if (logged.has(key)) return;
    if (logged.size >= MAX_LOGGED_VALIDATOR_FAILURES) logged.delete(logged.values().next().value!);
    logged.add(key);
    log(`[sync-relay] live validation failed with ${errorClass} for document ${document.objectId}; the edit waits and is tried again.`);
  };
}
/**
 * Two process-wide validation slots, with no retained waiting inputs. Each job
 * runs in a child process: a V8 heap-limit abort ends that child, not the relay.
 * Activation, restore and first-open work together hold at most one slot, so live edits always keep the other.
 */
export function createLiveValidationExecutor(heapLimitMb = 512, logValidatorFailure = createValidatorFailureLog(), { firstOpenBuildMs = FIRST_OPEN_BUILD_MS, maxEndedBuilds = MAX_ENDED_BUILDS } = {}) {
  const slots = new Set<Slot>();
  const waiters = new Set<() => void>();
  let closed = false, yielding = 0;
  // Notes whose build an activation or restore ended. Each one's next build runs to the end,
  // so a repeating activation delays a note's first open by at most one build. A note leaves only when
  // its next build starts. Notes that were ended and never built again can fill it, and then foreground
  // waits behind builds as it did before this change, until the relay restarts.
  const ended = new Set<string>();
  const hasCapacity = (auxiliary = false) => !closed && (!auxiliary || ![...slots].some(slot => slot.auxiliary)) && (slots.size < 2 || [...slots].some((slot) => !slot.busy));
  const notify = () => {
    for (const wake of [...waiters]) wake();
  };
  function waitForCapacity(signal?: AbortSignal, auxiliary = false): Promise<void> {
    signal?.throwIfAborted();
    if (closed) return Promise.reject(new Error("Live validation closed."));
    if (hasCapacity(auxiliary))
      return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const dispose = () => {
        waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      // A slot another kind of work may not take leaves this waiter waiting.
      const wake = () => {
        if (!closed && !hasCapacity(auxiliary)) return;
        dispose();
        if (closed) reject(new Error("Live validation closed."));
        else resolve();
      };
      const abort = () => {
        dispose();
        reject(signal!.reason);
      };
      waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  // An idle child must not keep the relay's event loop alive.
  const hold = (slot: Slot, held: boolean) => {
    for (const handle of [slot.child, slot.child.channel, slot.child.stderr as Socket | null])
      if (held) handle?.ref();
      else handle?.unref();
  };
  // A fork refused before it started has no process to signal.
  const kill = (slot: Slot) => {
    if (slot.child.pid !== undefined) slot.child.kill("SIGKILL");
  };
  function spawn() {
    const source = import.meta.url.endsWith(".ts");
    const child = fork(
      fileURLToPath(
        new URL(
          source ? "./liveValidationWorker.ts" : "./liveValidationWorker.js",
          import.meta.url,
        ),
      ),
      [],
      {
        execArgv: [
          ...(source
            ? [
                "--import",
                pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
              ]
            : []),
          `--max-old-space-size=${heapLimitMb}`,
          // A worker thread's default 4 MiB stack, less Node's 192 KiB guard.
          "--stack-size=3904",
        ],
        serialization: "advanced",
        stdio: ["ignore", "inherit", "pipe", "ipc"],
      },
    );
    let exit: () => void = () => {};
    const exited = new Promise<void>((resolve) => (exit = resolve));
    const slot: Slot = { child, busy: false, auxiliary: false, yielded: false, heapExhausted: false, exited };
    slots.add(slot);
    const release = () => {
      slots.delete(slot);
      exit();
      notify();
    };
    // Listen before touching stdio: a fork refused with EMFILE has none, then errors and closes.
    // A failed child must not crash the relay. A fork refused with EAGAIN has unopened pipes and may never close.
    child.on("error", () => {
      if (child.pid !== undefined) return;
      if (child.connected) child.disconnect();
      release();
    });
    // `close` follows the exit and the end of stderr, so its verdict is complete.
    child.once("close", release);
    let carry = "";
    // Reading a refused fork's unopened stderr fails; that must not crash the relay.
    child.stderr?.on("error", () => {});
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      process.stderr.write(text);
      const seen = carry + text;
      if (/Reached heap limit|JavaScript heap out of memory/.test(seen))
        slot.heapExhausted = true;
      carry = seen.slice(-32);
    });
    hold(slot, false);
    return slot;
  }
  async function submit<Result>(
    work: LiveValidationWork,
    heapExhausted: Result,
    signal?: AbortSignal,
    claim?: (slot: Slot) => void,
  ): Promise<Result | CapacityRetry> {
    signal?.throwIfAborted();
    if (closed) throw new Error("Live validation closed.");
    const foreground = work.kind === "activation" || work.kind === "restore";
    const auxiliary = foreground || work.kind === "first-open" || work.kind === "first-open-history";
    // A first-open build can take a minute; an activation or restore ends it rather than
    // wait, unless it is its note's turn, and the build answers `busy`. No first-open job starts meanwhile.
    const building = foreground && ended.size < maxEndedBuilds ? [...slots].find((slot) => slot.work === "first-open" && !slot.protected) : undefined;
    if (building) {
      building.yielded = true;
      if (building.note !== undefined) ended.add(building.note);
      yielding++;
      try {
        kill(building);
        await building.exited;
      } finally {
        yielding--;
      }
      signal?.throwIfAborted();
      if (closed) throw new Error("Live validation closed.");
    }
    // After ending a build it starts its own child, so an idle live-edit child stays warm.
    const slot = auxiliary && ((yielding > 0 && !foreground) || [...slots].some((slot) => slot.auxiliary)) ? undefined :
      (building && slots.size < 2 ? spawn() : undefined) ??
      [...slots].find((slot) => !slot.busy) ??
      (slots.size < 2 ? spawn() : undefined);
    if (!slot)
      return {
        kind: "retry",
        reason: "admission-unavailable",
        waitForCapacity: (signal?: AbortSignal) => waitForCapacity(signal, auxiliary),
      };
    slot.busy = true;
    claim?.(slot);
    slot.auxiliary = auxiliary;
    slot.work = work.kind;
    // A malformed input fails in the child, as any other build input does.
    slot.note = work.kind === "first-open" ? JSON.stringify([work.input.document?.workspaceId, work.input.document?.objectId]) : undefined;
    slot.protected = slot.note !== undefined && ended.delete(slot.note);
    hold(slot, true);
    return new Promise<Result>((resolve, reject) => {
      let done = false;
      const settle = () => {
        if (done) return false;
        done = true;
        signal?.removeEventListener("abort", abort);
        slot.child.off("message", complete);
        slot.child.off("error", fail);
        slot.child.off("close", ended);
        return true;
      };
      const fail = (error: unknown) => {
        if (!settle()) return;
        // The slot stays busy until the child has exited.
        kill(slot);
        reject(error);
      };
      const abort = () => fail(signal!.reason);
      const ended = (code: number | null, exitSignal: NodeJS.Signals | null) => {
        if (!settle()) return;
        // Node exits 134 on Windows where POSIX reports SIGABRT.
        if ((code === 134 || exitSignal === "SIGABRT") && slot.heapExhausted)
          resolve(heapExhausted);
        else reject(new Error("Live validation worker exited."));
      };
      const complete = (value: unknown) => {
        const failed = value as {kind?: unknown; errorClass?: unknown};
        if (work.kind === "first-open" && failed.kind === "failed") {
          fail(new LiveValidatorFailure(typeof failed.errorClass === "string" ? failed.errorClass : "unknown"));
          return;
        }
        if (!settle()) return;
        // An ended build's answer can arrive before its killed child exits; the slot stays busy until then.
        if (!slot.yielded) {
          slot.busy = false;
          slot.auxiliary = false;
          slot.work = slot.note = slot.protected = undefined;
          // A result that arrives after `close` began must not release its hold.
          if (!closed) hold(slot, false);
        }
        if (failed.kind === "failed") reject(new LiveValidatorFailure(typeof failed.errorClass === "string" ? failed.errorClass : "unknown"));
        else resolve(value as Result);
        notify();
      };
      slot.child.once("message", complete);
      slot.child.once("error", fail);
      slot.child.once("close", ended);
      signal?.addEventListener("abort", abort, { once: true });
      // A refused fork has no channel; its `error` event fails the job.
      if (slot.child.pid === undefined) return;
      // Advanced serialization copies typed arrays; never detach storage or caller buffers.
      try {
        slot.child.send(work, (error) => {
          if (error) fail(error);
        });
      } catch (error) {
        fail(error);
      }
    });
  }
  function validator(
    policy: OrderedLiveUpdateCutPolicy,
  ): CapacityLiveAdmissionValidator {
    const ownedPolicy = Object.freeze({ ...policy });
    const validate: OwnerOutboxAdmission["validate"] = (input, signal) =>
      submit<LiveJournalValidation>(
        { kind: "journal", policy: ownedPolicy, input },
        { kind: "refused", reason: "capacity-refused", source: "final" },
        signal,
      ).catch((error: unknown) => {
        if (error instanceof LiveValidatorFailure) logValidatorFailure(input.document, input.candidate, error.errorClass);
        throw error;
      });
    return Object.assign(validate, { waitForCapacity, hasCapacity });
  }
  /** Activation does not wait for a slot: a busy pool answers `retry` with the wait for one, after which a pass captures again. */
  function ordinaryActivation(policy: OrderedLiveUpdateCutPolicy): OrdinaryActivationCapacityValidator {
    const ownedPolicy = Object.freeze({ ...policy });
    return (input, signal) =>
      submit<Exclude<OrdinaryActivationValidation, { kind: "retry" }>>(
        { kind: "activation", policy: ownedPolicy, input },
        { kind: "capacity-refused" },
        signal,
      );
  }
  /** Preparation refuses a busy pool; admission waits with its captured reads and cancellation signal. */
  function restore(policy: OrderedLiveUpdateCutPolicy): LiveRestoreValidator {
    const ownedPolicy = Object.freeze({ ...policy });
    return liveRestoreValidator((input, signal) =>
      submit<LiveRestoreReply | { kind: "capacity-refused" }>(
        { kind: "restore", policy: ownedPolicy, input },
        { kind: "capacity-refused" },
        signal,
      ),
    );
  }
  /**
   * Runs at most one first-open job at a time and never waits for a slot, so
   * live admission keeps the other. A busy caller retries on its next pass.
   */
  async function firstOpen<Result extends { kind: string }>(
    work: LiveValidationWork,
    heapExhausted: Result,
    signal?: AbortSignal,
    waitForExitSignal?: AbortSignal,
  ): Promise<Result | { kind: "busy" }> {
    let claimed: Slot | undefined;
    try {
      const result = await submit<Result>(work, heapExhausted, signal, slot => { claimed = slot; });
      return result.kind === "retry" ? { kind: "busy" } : result as Result;
    } catch (error) {
      // A build ended for an activation or restore ran nothing to completion; it is asked again later.
      if (claimed?.yielded) return { kind: "busy" };
      // A deadline answers only after the child releases its slot.
      if (claimed && waitForExitSignal?.aborted && error === waitForExitSignal.reason) await claimed.exited;
      throw error;
    }
  }
  async function close() {
    closed = true;
    notify();
    await Promise.all(
      [...slots].map((slot) => {
        // Keep the relay alive until each child has closed.
        hold(slot, true);
        kill(slot);
        return slot.exited;
      }),
    );
  }
  return {
    validator,
    ordinaryActivation,
    restore,
    async normalizeSettlement(
      input: SettlementNormalizationInput,
      signal?: AbortSignal,
    ) {
      return submit<SettlementNormalizationResult>(
        { kind: "settlement", policy: WORKER_LIVE_VALIDATION_POLICY, input },
        { kind: "refused", reason: "capacity-refused", source: "registration-input" },
        signal,
      );
    },
    /**
     * A build that runs its worker out of memory does so on every try, so it
     * is refused for good. A build that passes its deadline says only that
     * this host was slow this time. Both answer after the child has closed.
     */
    async buildFirstOpenBase(
      policy: OrderedLiveUpdateCutPolicy,
      input: FirstOpenBaseInput,
      signal?: AbortSignal,
    ): Promise<FirstOpenBaseResult | { kind: "busy" } | { kind: "deadline" }> {
      const deadline = AbortSignal.timeout(firstOpenBuildMs);
      try {
        return await firstOpen<FirstOpenBaseResult>(
          { kind: "first-open", policy, input },
          { kind: "refused", reason: "seed-worker-capacity" },
          signal ? AbortSignal.any([signal, deadline]) : deadline,
          deadline,
        );
      } catch (error) {
        if (!deadline.aborted || error !== deadline.reason) throw error;
        return { kind: "deadline" };
      }
    },
    /** Reads first-open history on the worker's own read-only connection, in the first-open slot. */
    readFirstOpenHistory(read: FirstOpenHistoryRead, signal?: AbortSignal) {
      return firstOpen<FirstOpenHistory | FirstOpenHistoryFailure | { kind: "internal_error" }>({ kind: "first-open-history", input: read }, { kind: "internal_error" }, signal).then(result => {
        if (result.kind === "history-error") throw Object.assign(new Error(result.message), {code: result.code, errcode: result.errcode});
        if (result.kind === "internal_error") throw new Error("First-open history child exceeded its heap limit.");
        return result;
      });
    },
    close,
  };
}
export const liveValidation = createLiveValidationExecutor();
