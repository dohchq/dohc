import type {
  RendererWorkspaceSender,
  RendererWorkspaceSession,
} from "../window/rendererWorkspaceSessionOwner";

interface PresenceMutationEntry {
  tail: Promise<void>;
  mayBePresent: boolean;
  incarnationId: string | undefined;
  leave: (() => Promise<void>) | undefined;
}

interface PresenceMutationSessionState {
  readonly entries: Map<string, PresenceMutationEntry>;
  retired: boolean;
  retirement: Promise<void> | undefined;
}

interface RetiredPresenceLeave {
  readonly leave: () => Promise<void>;
  expiry: unknown | undefined;
  draining: Promise<void> | undefined;
}

interface PresenceMutationOwnerOptions {
  tombstoneTtlMs?: number;
  scheduleExpiry?: (callback: () => void, delayMs: number) => unknown;
  cancelExpiry?: (handle: unknown) => void;
}

interface PresencePublishOperations<Snapshot> {
  resolve(): Promise<{
    publish(): Promise<Snapshot>;
    leave(): Promise<void>;
  }>;
}

/** Owns serialized presence writes for one exact renderer workspace lease. */
export class PresenceMutationOwner<Sender extends RendererWorkspaceSender> {
  readonly #states = new WeakMap<
    RendererWorkspaceSession<Sender>,
    PresenceMutationSessionState
  >();
  readonly #retiredLeaves = new Map<string, RetiredPresenceLeave>();
  readonly #tombstoneTtlMs: number;
  readonly #scheduleExpiry: (callback: () => void, delayMs: number) => unknown;
  readonly #cancelExpiry: (handle: unknown) => void;

  constructor(options: PresenceMutationOwnerOptions = {}) {
    // Relay entries expire after 30 seconds today. Keep this desktop-owned
    // bound explicit instead of importing service internals into the app.
    this.#tombstoneTtlMs = options.tombstoneTtlMs ?? 30_000;
    this.#scheduleExpiry =
      options.scheduleExpiry ??
      ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.#cancelExpiry =
      options.cancelExpiry ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  publish<Snapshot>(
    session: RendererWorkspaceSession<Sender>,
    key: string,
    incarnationId: string,
    operations: PresencePublishOperations<Snapshot>,
  ): Promise<Snapshot | undefined> {
    const state = this.#admit(session);
    if (!state) return Promise.resolve(undefined);
    const entry = this.#entry(state, key);
    // Invocation order is the ownership order. PresenceChannel cannot invoke
    // another publish after stop starts, so the newest channel's immediate
    // publish synchronously supersedes its predecessor before either awaits.
    entry.incarnationId = incarnationId;

    const operation = entry.tail.then(async () => {
      if (
        state.retired ||
        !session.isCurrent() ||
        entry.incarnationId !== incarnationId
      ) {
        return undefined;
      }
      await this.#drainRetiredLeave(key);
      if (
        state.retired ||
        !session.isCurrent() ||
        entry.incarnationId !== incarnationId
      ) {
        return undefined;
      }
      const transport = await operations.resolve();
      if (
        state.retired ||
        !session.isCurrent() ||
        entry.incarnationId !== incarnationId
      ) {
        return undefined;
      }
      // The relay may apply a request even when its response later fails. Once
      // a publish starts, retirement owes this exact identity a leave.
      entry.leave = transport.leave;
      entry.mayBePresent = true;
      const snapshot = await transport.publish();
      return state.retired ||
        !session.isCurrent() ||
        entry.incarnationId !== incarnationId
        ? undefined
        : snapshot;
    });
    entry.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  leave(
    session: RendererWorkspaceSession<Sender>,
    key: string,
    incarnationId: string,
    resolveLeave: () => Promise<() => Promise<void>>,
  ): Promise<boolean> {
    const state = this.#admit(session);
    if (!state) return Promise.resolve(false);
    const entry = state.entries.get(key);
    if (!entry || entry.incarnationId !== incarnationId) {
      return Promise.resolve(false);
    }

    const operation = entry.tail.then(async () => {
      if (
        state.retired ||
        !session.isCurrent() ||
        entry.incarnationId !== incarnationId
      ) {
        return false;
      }
      await this.#drainRetiredLeave(key);
      if (
        state.retired ||
        !session.isCurrent() ||
        entry.incarnationId !== incarnationId
      ) {
        return false;
      }
      entry.leave ??= await resolveLeave();
      if (
        state.retired ||
        !session.isCurrent() ||
        entry.incarnationId !== incarnationId
      ) {
        return false;
      }
      // A renderer may stop before its initial publish returns. Serialize the
      // leave behind that publish and keep it retryable until it succeeds.
      entry.mayBePresent = true;
      await entry.leave();
      entry.mayBePresent = false;
      return (
        !state.retired &&
        session.isCurrent() &&
        entry.incarnationId === incarnationId
      );
    });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    entry.tail = tail;
    void tail.then(() => {
      if (
        !entry.mayBePresent &&
        entry.tail === tail &&
        state.entries.get(key) === entry
      ) {
        state.entries.delete(key);
      }
    });
    return operation;
  }

  retireSender(session: RendererWorkspaceSession<Sender>): Promise<void> {
    const state = this.#states.get(session);
    if (!state) return Promise.resolve();
    if (state.retirement) return state.retirement;
    state.retired = true;

    const drains = [...state.entries.entries()].map(([key, entry]) => {
      const drain = entry.tail.then(async () => {
        if (!entry.mayBePresent || !entry.leave) return;
        try {
          await entry.leave();
          entry.mayBePresent = false;
        } catch (error) {
          // Do not let a failed best-effort leave erase ownership. A successor
          // using the same request identity must retry this exact transport
          // before it can publish or leave under its own session.
          this.#rememberRetiredLeave(key, entry.leave);
          throw error;
        }
      });
      entry.tail = drain.then(
        () => undefined,
        () => undefined,
      );
      return drain;
    });
    state.retirement = Promise.allSettled(drains).then((results) => {
      this.#states.delete(session);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Could not retire renderer presence");
      }
    });
    return state.retirement;
  }

  #admit(
    session: RendererWorkspaceSession<Sender>,
  ): PresenceMutationSessionState | undefined {
    if (!session.isCurrent()) return undefined;
    const known = this.#states.get(session);
    if (known) return known.retired ? undefined : known;
    const state: PresenceMutationSessionState = {
      entries: new Map(),
      retired: false,
      retirement: undefined,
    };
    this.#states.set(session, state);
    return state;
  }

  #entry(
    state: PresenceMutationSessionState,
    key: string,
  ): PresenceMutationEntry {
    const known = state.entries.get(key);
    if (known) return known;
    const entry: PresenceMutationEntry = {
      tail: Promise.resolve(),
      mayBePresent: false,
      incarnationId: undefined,
      leave: undefined,
    };
    state.entries.set(key, entry);
    return entry;
  }

  async #drainRetiredLeave(key: string): Promise<void> {
    const tombstone = this.#retiredLeaves.get(key);
    if (!tombstone) return;
    let drain = tombstone.draining;
    if (!drain) {
      if (tombstone.expiry !== undefined) {
        this.#cancelExpiry(tombstone.expiry);
        tombstone.expiry = undefined;
      }
      drain = Promise.resolve().then(tombstone.leave);
      tombstone.draining = drain;
      void drain.then(
        () => {
          if (tombstone.draining === drain) tombstone.draining = undefined;
        },
        () => {
          if (tombstone.draining === drain) {
            tombstone.draining = undefined;
            if (this.#retiredLeaves.get(key) === tombstone) {
              this.#armRetiredLeaveExpiry(key, tombstone);
            }
          }
        },
      );
    }
    await drain;
    if (this.#retiredLeaves.get(key) === tombstone) {
      this.#forgetRetiredLeave(key, tombstone);
    }
  }

  #rememberRetiredLeave(key: string, leave: () => Promise<void>): void {
    const prior = this.#retiredLeaves.get(key);
    if (prior) this.#forgetRetiredLeave(key, prior);
    const tombstone: RetiredPresenceLeave = {
      leave,
      draining: undefined,
      expiry: undefined,
    };
    this.#retiredLeaves.set(key, tombstone);
    this.#armRetiredLeaveExpiry(key, tombstone);
  }

  #forgetRetiredLeave(key: string, tombstone: RetiredPresenceLeave): void {
    this.#retiredLeaves.delete(key);
    if (tombstone.expiry !== undefined) {
      this.#cancelExpiry(tombstone.expiry);
      tombstone.expiry = undefined;
    }
  }

  #armRetiredLeaveExpiry(
    key: string,
    tombstone: RetiredPresenceLeave,
  ): void {
    let expiry: unknown;
    expiry = this.#scheduleExpiry(() => {
      if (
        this.#retiredLeaves.get(key) === tombstone &&
        tombstone.expiry === expiry &&
        !tombstone.draining
      ) {
        tombstone.expiry = undefined;
        this.#retiredLeaves.delete(key);
      }
    }, this.#tombstoneTtlMs);
    tombstone.expiry = expiry;
  }
}
