export interface EngineYDocSessionSender {
  readonly id: number;
}

export interface EngineYDocSessionIdentity<
  TSender extends EngineYDocSessionSender,
> {
  sender: TSender;
  generation: number;
}

export interface EngineYDocSessionCaller<
  TSender extends EngineYDocSessionSender,
> extends EngineYDocSessionIdentity<TSender> {
  sessionId: string;
}

export interface ReleasableEngineYDocSession {
  close: () => Promise<void>;
}

export interface EngineYDocSessionSignals<TEvent, TUpdate, TReplacement> {
  emit: (event: TEvent) => void;
  remoteUpdate: (update: TUpdate) => void;
  replaceLineage: (replacement: TReplacement) => void;
}

export type EngineYDocSessionOutboundMessage<TEvent, TUpdate, TReplacement> =
  | { kind: "session-event"; event: TEvent }
  | {
      kind: "remote-update";
      update: TUpdate;
      lineageGeneration: number;
    }
  | {
      kind: "lineage-replacement";
      replacement: TReplacement;
      lineageGeneration: number;
    };

export interface EngineYDocSessionOutbound<
  TSender extends EngineYDocSessionSender,
  TEvent,
  TUpdate,
  TReplacement,
> extends EngineYDocSessionCaller<TSender> {
  workspaceId: string;
  path: string;
  message: EngineYDocSessionOutboundMessage<TEvent, TUpdate, TReplacement>;
}

export type EngineYDocSessionReleaseOutcome =
  | { kind: "released" }
  | { kind: "failed"; error: unknown };

export type EngineYDocSessionReleaseResult =
  | EngineYDocSessionReleaseOutcome
  | { kind: "refused"; reason: "session-unavailable" };

export type EngineYDocSessionOpenResult<TValue> =
  | { kind: "opened"; value: TValue; lineageGeneration: number }
  | {
      kind: "cancelled";
      reason:
        | "lineage-announcement-failed"
        | "released"
        | "sender-retired"
        | "superseded";
      release: EngineYDocSessionReleaseOutcome;
    }
  | { kind: "refused"; reason: "session-in-use" }
  | { kind: "refused"; reason: "open-refused"; error: unknown }
  | { kind: "refused"; reason: "session-unreleased"; error: unknown };

export type EngineYDocSessionApplyResult<TValue> =
  | { kind: "applied"; value: TValue }
  | {
      kind: "refused";
      reason: "session-unavailable" | "lineage-transition";
    };

export type EngineYDocSessionAcknowledgeResult<TUpdate> =
  | { kind: "applied"; updates: TUpdate[] }
  | {
      kind: "refused";
      reason: "session-unavailable" | "lineage-transition";
    };

export interface OpenEngineYDocOwnedSessionInput<
  TSender extends EngineYDocSessionSender,
  TSession extends ReleasableEngineYDocSession,
  TEvent,
  TUpdate,
  TReplacement,
  TValue,
> extends EngineYDocSessionCaller<TSender> {
  workspaceId: string;
  path: string;
  openSession: (
    signals: EngineYDocSessionSignals<TEvent, TUpdate, TReplacement>,
  ) => Promise<{ session: TSession; value: TValue }>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type SessionState = "opening" | "open" | "releasing";
type OpenCancellation = Extract<
  EngineYDocSessionOpenResult<never>,
  { kind: "cancelled" }
>["reason"];

interface LineageHandoff<TUpdate> {
  lineageGeneration: number;
  updates: TUpdate[];
}

interface QueuedLineageReplacement<TUpdate, TReplacement> {
  replacement: TReplacement;
  updates: TUpdate[];
}

interface SenderGeneration<TSender extends EngineYDocSessionSender> {
  sender: TSender;
  generation: number;
  retired: boolean;
}

interface SessionRecord<
  TSender extends EngineYDocSessionSender,
  TSession extends ReleasableEngineYDocSession,
  TUpdate,
  TReplacement,
> {
  readonly key: string;
  readonly openToken: symbol;
  readonly sender: TSender;
  readonly senderId: number;
  readonly generation: number;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly openingRetirement: Deferred<EngineYDocSessionReleaseOutcome>;
  state: SessionState;
  cancellation: OpenCancellation | null;
  session: TSession | null;
  closeInFlight: Promise<EngineYDocSessionReleaseOutcome> | null;
  releaseFailure: { error: unknown } | null;
  lineageGeneration: number;
  handoff: LineageHandoff<TUpdate> | null;
  queuedHandoff: QueuedLineageReplacement<TUpdate, TReplacement> | null;
}

export interface EngineYDocSessionOwnerOptions<
  TSender extends EngineYDocSessionSender,
  TEvent,
  TUpdate,
  TReplacement,
> {
  onOutbound: (
    outbound: EngineYDocSessionOutbound<
      TSender,
      TEvent,
      TUpdate,
      TReplacement
    >,
  ) => void;
}

/** Owns renderer-scoped engine Y.Doc sessions across every asynchronous state. */
export class EngineYDocSessionOwner<
  TSender extends EngineYDocSessionSender,
  TSession extends ReleasableEngineYDocSession,
  TEvent,
  TUpdate,
  TReplacement,
> {
  readonly #onOutbound: EngineYDocSessionOwnerOptions<
    TSender,
    TEvent,
    TUpdate,
    TReplacement
  >["onOutbound"];
  readonly #slots = new Map<
    string,
    SessionRecord<TSender, TSession, TUpdate, TReplacement>
  >();
  readonly #records = new Set<
    SessionRecord<TSender, TSession, TUpdate, TReplacement>
  >();
  readonly #senderGenerations = new Map<number, SenderGeneration<TSender>>();

  constructor(
    options: EngineYDocSessionOwnerOptions<
      TSender,
      TEvent,
      TUpdate,
      TReplacement
    >,
  ) {
    this.#onOutbound = options.onOutbound;
  }

  open<TValue>(
    input: OpenEngineYDocOwnedSessionInput<
      TSender,
      TSession,
      TEvent,
      TUpdate,
      TReplacement,
      TValue
    >,
  ): Promise<EngineYDocSessionOpenResult<TValue>> {
    const stale = this.#admitGeneration(input);
    if (stale) {
      return Promise.resolve({
        kind: "cancelled",
        reason: stale,
        release: { kind: "released" },
      });
    }
    const key = sessionKey(input.sender.id, input.sessionId);
    const occupied = this.#slots.get(key);
    if (occupied && this.#sameIdentity(occupied, input)) {
      if (occupied.state === "releasing" && occupied.releaseFailure) {
        return Promise.resolve({
          kind: "refused",
          reason: "session-unreleased",
          error: occupied.releaseFailure.error,
        });
      }
      return Promise.resolve({ kind: "refused", reason: "session-in-use" });
    }
    if (occupied) {
      void this.#retire(occupied, "superseded", true);
    }

    const record: SessionRecord<TSender, TSession, TUpdate, TReplacement> = {
      key,
      openToken: Symbol("engine-ydoc-open"),
      sender: input.sender,
      senderId: input.sender.id,
      generation: input.generation,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      path: input.path,
      openingRetirement: deferred<EngineYDocSessionReleaseOutcome>(),
      state: "opening",
      cancellation: null,
      session: null,
      closeInFlight: null,
      releaseFailure: null,
      lineageGeneration: 1,
      handoff: null,
      queuedHandoff: null,
    };

    // The reservation and its retirement promise exist before openSession can
    // reach its first await or invoke a callback.
    this.#slots.set(key, record);
    this.#records.add(record);
    return this.#finishOpen(record, input);
  }

  applyUpdate<TValue>(
    input: EngineYDocSessionCaller<TSender> & { lineageGeneration: number },
    apply: (session: TSession) => TValue,
  ): EngineYDocSessionApplyResult<TValue> {
    const record = this.#current(input);
    if (!record || record.state !== "open" || record.session === null) {
      return { kind: "refused", reason: "session-unavailable" };
    }
    if (
      record.handoff !== null ||
      input.lineageGeneration !== record.lineageGeneration
    ) {
      return { kind: "refused", reason: "lineage-transition" };
    }
    return { kind: "applied", value: apply(record.session) };
  }

  acknowledgeLineageReplacement(
    input: EngineYDocSessionCaller<TSender> & { lineageGeneration: number },
  ): EngineYDocSessionAcknowledgeResult<TUpdate> {
    const record = this.#current(input);
    if (!record || record.state !== "open") {
      return { kind: "refused", reason: "session-unavailable" };
    }
    const handoff = record.handoff;
    if (!handoff || handoff.lineageGeneration !== input.lineageGeneration) {
      return { kind: "refused", reason: "lineage-transition" };
    }

    record.lineageGeneration = handoff.lineageGeneration;
    record.handoff = null;
    const queued = record.queuedHandoff;
    record.queuedHandoff = null;
    if (queued) {
      this.#installHandoff(record, queued.replacement, queued.updates);
      return { kind: "applied", updates: [] };
    }
    return { kind: "applied", updates: handoff.updates };
  }

  release(
    input: EngineYDocSessionCaller<TSender>,
  ): Promise<EngineYDocSessionReleaseResult> {
    const record = this.#current(input);
    if (!record) {
      return Promise.resolve({
        kind: "refused",
        reason: "session-unavailable",
      });
    }
    return this.#retire(record, "released", false);
  }

  retireSender(
    input: EngineYDocSessionIdentity<TSender>,
  ): Promise<EngineYDocSessionReleaseOutcome[]> {
    this.#retireGeneration(input);
    const records = [...this.#records].filter(
      (record) =>
        record.sender === input.sender &&
        record.senderId === input.sender.id &&
        record.generation === input.generation,
    );
    return Promise.all(
      records.map((record) => this.#retire(record, "sender-retired", true)),
    );
  }

  async #finishOpen<TValue>(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
    input: OpenEngineYDocOwnedSessionInput<
      TSender,
      TSession,
      TEvent,
      TUpdate,
      TReplacement,
      TValue
    >,
  ): Promise<EngineYDocSessionOpenResult<TValue>> {
    const unreleased = await this.#releaseDocumentRetirements(record);
    if (record.state === "releasing") {
      return this.#cancelWithoutSession(record);
    }
    if (unreleased) {
      this.#forget(record);
      return {
        kind: "refused",
        reason: "session-unreleased",
        error: unreleased,
      };
    }

    const signals = this.#signals(record);
    let opened: { session: TSession; value: TValue };
    try {
      opened = await input.openSession(signals);
    } catch (error) {
      if (!this.#isCurrentAndActive(record)) {
        return this.#cancelWithoutSession(record);
      }
      this.#forget(record);
      return { kind: "refused", reason: "open-refused", error };
    }

    record.session = opened.session;
    if (!this.#isCurrentAndActive(record)) {
      const release = await this.#close(record);
      record.openingRetirement.resolve(release);
      return {
        kind: "cancelled",
        reason: record.cancellation ?? "superseded",
        release,
      };
    }

    record.state = "open";
    return {
      kind: "opened",
      value: opened.value,
      lineageGeneration: record.lineageGeneration,
    };
  }

  async #releaseDocumentRetirements(
    opening: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
  ): Promise<unknown | null> {
    const blockers = [...this.#records].filter(
      (record) =>
        record !== opening &&
        record.state === "releasing" &&
        record.workspaceId === opening.workspaceId &&
        record.path === opening.path,
    );
    for (const blocker of blockers) {
      const release = await this.#retire(
        blocker,
        blocker.cancellation ?? "superseded",
        false,
      );
      if (release.kind === "failed") return release.error;
      if (opening.state === "releasing") return null;
    }
    return null;
  }

  #signals(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
  ): EngineYDocSessionSignals<TEvent, TUpdate, TReplacement> {
    const token = record.openToken;
    return {
      emit: (event) => {
        this.#send(record, token, { kind: "session-event", event });
      },
      remoteUpdate: (update) => {
        if (!this.#maySend(record, token)) return;
        const handoff = record.handoff;
        if (handoff) {
          (record.queuedHandoff ?? handoff).updates.push(update);
          return;
        }
        this.#send(record, token, {
          kind: "remote-update",
          update,
          lineageGeneration: record.lineageGeneration,
        });
      },
      replaceLineage: (replacement) => {
        if (!this.#maySend(record, token)) return;
        if (record.handoff) {
          record.queuedHandoff = {
            replacement,
            updates: [],
          };
          return;
        }
        this.#installHandoff(record, replacement, []);
      },
    };
  }

  #installHandoff(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
    replacement: TReplacement,
    updates: TUpdate[],
  ): void {
    const handoff = {
      lineageGeneration: record.lineageGeneration + 1,
      updates,
    };
    record.handoff = handoff;
    if (
      !this.#send(record, record.openToken, {
        kind: "lineage-replacement",
        replacement,
        lineageGeneration: handoff.lineageGeneration,
      })
    ) {
      void this.#retire(record, "lineage-announcement-failed", false);
    }
  }

  #send(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
    token: symbol,
    message: EngineYDocSessionOutboundMessage<TEvent, TUpdate, TReplacement>,
  ): boolean {
    if (!this.#maySend(record, token)) return false;
    try {
      this.#onOutbound({
        sender: record.sender,
        generation: record.generation,
        sessionId: record.sessionId,
        workspaceId: record.workspaceId,
        path: record.path,
        message,
      });
      return true;
    } catch {
      return false;
    }
  }

  #maySend(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
    token: symbol,
  ): boolean {
    return record.openToken === token && this.#isCurrentAndActive(record);
  }

  #isCurrentAndActive(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
  ): boolean {
    return (
      this.#ownsActiveGeneration(record) &&
      this.#slots.get(record.key) === record &&
      (record.state === "opening" || record.state === "open")
    );
  }

  #current(
    input: EngineYDocSessionCaller<TSender>,
  ): SessionRecord<TSender, TSession, TUpdate, TReplacement> | null {
    const record = this.#slots.get(sessionKey(input.sender.id, input.sessionId));
    if (
      !record ||
      !this.#sameIdentity(record, input) ||
      !this.#ownsActiveGeneration(record)
    ) {
      return null;
    }
    return record;
  }

  #sameIdentity(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
    input: EngineYDocSessionIdentity<TSender>,
  ): boolean {
    return (
      record.sender === input.sender &&
      record.senderId === input.sender.id &&
      record.generation === input.generation
    );
  }

  #admitGeneration(
    input: EngineYDocSessionIdentity<TSender>,
  ): "sender-retired" | "superseded" | null {
    const current = this.#senderGenerations.get(input.sender.id);
    if (!current || input.generation > current.generation) {
      this.#senderGenerations.set(input.sender.id, {
        sender: input.sender,
        generation: input.generation,
        retired: false,
      });
      this.#retireOlderGenerations(input.sender.id, input.generation);
      return null;
    }
    if (
      input.generation < current.generation ||
      input.sender !== current.sender
    ) {
      return "superseded";
    }
    return current.retired ? "sender-retired" : null;
  }

  #ownsActiveGeneration(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
  ): boolean {
    const current = this.#senderGenerations.get(record.senderId);
    return (
      current !== undefined &&
      !current.retired &&
      current.sender === record.sender &&
      current.generation === record.generation
    );
  }

  #retireOlderGenerations(senderId: number, generation: number): void {
    for (const record of [...this.#records]) {
      if (record.senderId !== senderId || record.generation >= generation) {
        continue;
      }
      void this.#retire(record, "superseded", true);
    }
  }

  #retireGeneration(input: EngineYDocSessionIdentity<TSender>): void {
    const current = this.#senderGenerations.get(input.sender.id);
    if (!current || input.generation > current.generation) {
      this.#senderGenerations.set(input.sender.id, {
        sender: input.sender,
        generation: input.generation,
        retired: true,
      });
      this.#retireOlderGenerations(input.sender.id, input.generation);
      return;
    }
    if (
      input.generation === current.generation &&
      input.sender === current.sender
    ) {
      current.retired = true;
      this.#retireOlderGenerations(input.sender.id, input.generation);
    }
  }

  #retire(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
    cancellation: OpenCancellation,
    vacateSlot: boolean,
  ): Promise<EngineYDocSessionReleaseOutcome> {
    if (vacateSlot && this.#slots.get(record.key) === record) {
      this.#slots.delete(record.key);
    }
    if (record.state === "opening") {
      record.state = "releasing";
      record.cancellation = cancellation;
      record.handoff = null;
      record.queuedHandoff = null;
      return record.openingRetirement.promise;
    }
    record.cancellation ??= cancellation;
    if (record.session === null) return record.openingRetirement.promise;
    return this.#close(record);
  }

  #close(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
  ): Promise<EngineYDocSessionReleaseOutcome> {
    if (record.closeInFlight) return record.closeInFlight;
    const session = record.session;
    if (!session) return Promise.resolve({ kind: "released" });

    record.state = "releasing";
    record.handoff = null;
    record.queuedHandoff = null;
    record.releaseFailure = null;
    const close = (async (): Promise<EngineYDocSessionReleaseOutcome> => {
      try {
        await session.close();
      } catch (error) {
        record.releaseFailure = { error };
        return { kind: "failed", error };
      }
      this.#forget(record);
      return { kind: "released" };
    })();
    record.closeInFlight = close;
    void close.then(() => {
      if (record.closeInFlight === close) record.closeInFlight = null;
    });
    return close;
  }

  #cancelWithoutSession(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
  ): Extract<EngineYDocSessionOpenResult<never>, { kind: "cancelled" }> {
    const release = { kind: "released" } as const;
    const reason = record.cancellation ?? "superseded";
    this.#forget(record);
    record.openingRetirement.resolve(release);
    return { kind: "cancelled", reason, release };
  }

  #forget(
    record: SessionRecord<TSender, TSession, TUpdate, TReplacement>,
  ): void {
    if (this.#slots.get(record.key) === record) this.#slots.delete(record.key);
    this.#records.delete(record);
  }
}

function sessionKey(senderId: number, sessionId: string): string {
  return `${senderId}:${sessionId}`;
}
