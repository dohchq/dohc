export interface RendererWorkspaceSender {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
}

export interface RendererWorkspaceSession<
  Sender extends RendererWorkspaceSender = RendererWorkspaceSender,
> {
  readonly sender: Sender;
  readonly senderId: number;
  readonly workspaceId: string;
  readonly rendererDocumentId: string;
  readonly generation: number;
  isCurrent(): boolean;
}

export interface RendererWorkspaceRetirement<
  Sender extends RendererWorkspaceSender,
> {
  retireSender(session: RendererWorkspaceSession<Sender>): Promise<void>;
  retireWorkspace(workspaceId: string): Promise<void>;
}

export class RendererWorkspaceOpenSupersededError extends Error {
  constructor() {
    super(
      "The renderer changed workspaces before this workspace finished opening.",
    );
    this.name = "RendererWorkspaceOpenSupersededError";
  }
}

interface SenderState<Sender extends RendererWorkspaceSender> {
  readonly sender: Sender;
  requestSequence: number;
  active: RendererWorkspaceSession<Sender> | undefined;
  retiring: Promise<void> | undefined;
  rendererDocumentId: string | undefined;
  readonly retiredRendererDocumentIds: Set<string>;
  destroyed: boolean;
}

export interface RendererWorkspaceSessionOwnerOptions<
  Sender extends RendererWorkspaceSender,
> {
  retirement: RendererWorkspaceRetirement<Sender>;
  onCleanupError?: (
    scope:
      | { kind: "sender"; senderId: number }
      | { kind: "workspace"; workspaceId: string },
    error: unknown,
  ) => void;
}

/** Owns the exact renderer-to-workspace lease and its retirement ordering. */
export class RendererWorkspaceSessionOwner<
  Sender extends RendererWorkspaceSender,
> {
  readonly #retirement: RendererWorkspaceRetirement<Sender>;
  readonly #onCleanupError: NonNullable<
    RendererWorkspaceSessionOwnerOptions<Sender>["onCleanupError"]
  >;
  readonly #statesBySender = new WeakMap<Sender, SenderState<Sender>>();
  readonly #stateBySenderId = new Map<number, SenderState<Sender>>();
  readonly #workspaceMembers = new Map<string, Set<SenderState<Sender>>>();
  readonly #workspaceRetirements = new Map<string, Promise<void>>();
  #nextGeneration = 0;

  constructor(options: RendererWorkspaceSessionOwnerOptions<Sender>) {
    this.#retirement = options.retirement;
    this.#onCleanupError = options.onCleanupError ?? (() => undefined);
  }

  async open(
    sender: Sender,
    workspaceId: string,
    rendererDocumentId: string,
  ): Promise<RendererWorkspaceSession<Sender>> {
    if (sender.isDestroyed()) {
      throw new RendererWorkspaceOpenSupersededError();
    }
    const state = this.#stateFor(sender);
    if (state.destroyed) {
      throw new RendererWorkspaceOpenSupersededError();
    }
    if (
      state.retiredRendererDocumentIds.has(rendererDocumentId) ||
      (state.rendererDocumentId !== undefined &&
        state.rendererDocumentId !== rendererDocumentId)
    ) {
      throw new RendererWorkspaceOpenSupersededError();
    }
    state.rendererDocumentId = rendererDocumentId;

    const requestSequence = ++state.requestSequence;
    const active = state.active;
    if (active?.workspaceId === workspaceId && active.isCurrent()) return active;

    const senderRetirement = active
      ? this.#beginSenderRetirement(state, active)
      : state.retiring;
    if (senderRetirement) await senderRetirement;
    this.#assertOpenRequestCurrent(state, requestSequence);

    const workspaceRetirement = this.#workspaceRetirements.get(workspaceId);
    if (workspaceRetirement) await workspaceRetirement;
    this.#assertOpenRequestCurrent(state, requestSequence);

    const session = this.#createSession(state, workspaceId, rendererDocumentId);
    state.active = session;
    const members = this.#workspaceMembers.get(workspaceId) ?? new Set();
    members.add(state);
    this.#workspaceMembers.set(workspaceId, members);
    return session;
  }

  current(sender: Sender): RendererWorkspaceSession<Sender> | undefined {
    const state = this.#statesBySender.get(sender);
    const session = state?.active;
    return session?.isCurrent() ? session : undefined;
  }

  isWorkspaceOpen(workspaceId: string): boolean {
    return (this.#workspaceMembers.get(workspaceId)?.size ?? 0) > 0;
  }

  retireForReload(sender: Sender, rendererDocumentId?: string): Promise<void> {
    let state = this.#statesBySender.get(sender);
    if (!state && rendererDocumentId && !sender.isDestroyed()) {
      state = this.#stateFor(sender);
    }
    if (!state || this.#stateBySenderId.get(sender.id) !== state) {
      return Promise.resolve();
    }
    if (rendererDocumentId) {
      state.retiredRendererDocumentIds.add(rendererDocumentId);
    }
    if (state.rendererDocumentId) {
      state.retiredRendererDocumentIds.add(state.rendererDocumentId);
      state.rendererDocumentId = undefined;
    }
    ++state.requestSequence;
    return state.active
      ? this.#beginSenderRetirement(state, state.active)
      : (state.retiring ?? Promise.resolve());
  }

  #stateFor(sender: Sender): SenderState<Sender> {
    const known = this.#statesBySender.get(sender);
    if (known) {
      if (this.#stateBySenderId.get(sender.id) !== known) {
        throw new RendererWorkspaceOpenSupersededError();
      }
      return known;
    }

    const state: SenderState<Sender> = {
      sender,
      requestSequence: 0,
      active: undefined,
      retiring: undefined,
      rendererDocumentId: undefined,
      retiredRendererDocumentIds: new Set(),
      destroyed: false,
    };
    this.#statesBySender.set(sender, state);

    const displaced = this.#stateBySenderId.get(sender.id);
    this.#stateBySenderId.set(sender.id, state);
    if (displaced && displaced !== state) {
      ++displaced.requestSequence;
      const retiring = displaced.active
        ? this.#beginSenderRetirement(displaced, displaced.active)
        : displaced.retiring;
      if (retiring) {
        const admission = retiring.then(() => undefined);
        state.retiring = admission;
        void admission.finally(() => {
          if (state.retiring === admission) state.retiring = undefined;
        });
      }
    }

    sender.once("destroyed", () => {
      state.destroyed = true;
      ++state.requestSequence;
      const retiring = state.active
        ? this.#beginSenderRetirement(state, state.active)
        : (state.retiring ?? Promise.resolve());
      void retiring.finally(() => {
        if (this.#stateBySenderId.get(sender.id) === state) {
          this.#stateBySenderId.delete(sender.id);
        }
      });
    });
    return state;
  }

  #createSession(
    state: SenderState<Sender>,
    workspaceId: string,
    rendererDocumentId: string,
  ): RendererWorkspaceSession<Sender> {
    const generation = ++this.#nextGeneration;
    let session!: RendererWorkspaceSession<Sender>;
    session = Object.freeze({
      sender: state.sender,
      senderId: state.sender.id,
      workspaceId,
      rendererDocumentId,
      generation,
      isCurrent: () =>
        !state.destroyed &&
        !state.sender.isDestroyed() &&
        this.#stateBySenderId.get(state.sender.id) === state &&
        state.active === session,
    });
    return session;
  }

  #assertOpenRequestCurrent(
    state: SenderState<Sender>,
    requestSequence: number,
  ): void {
    if (
      state.destroyed ||
      state.sender.isDestroyed() ||
      this.#stateBySenderId.get(state.sender.id) !== state ||
      state.requestSequence !== requestSequence
    ) {
      throw new RendererWorkspaceOpenSupersededError();
    }
  }

  #beginSenderRetirement(
    state: SenderState<Sender>,
    session: RendererWorkspaceSession<Sender>,
  ): Promise<void> {
    if (state.retiring) return state.retiring;

    const { promise, resolve } = Promise.withResolvers<void>();
    state.retiring = promise;
    state.active = undefined;

    let senderDrain: Promise<void>;
    try {
      senderDrain = this.#retirement.retireSender(session);
    } catch (error) {
      this.#onCleanupError({ kind: "sender", senderId: session.senderId }, error);
      senderDrain = Promise.resolve();
    }

    void (async () => {
      try {
        await senderDrain.catch((error: unknown) => {
          this.#onCleanupError(
            { kind: "sender", senderId: session.senderId },
            error,
          );
        });
        this.#removeWorkspaceMember(session.workspaceId, state);
        if (!this.isWorkspaceOpen(session.workspaceId)) {
          await this.#retireWorkspace(session.workspaceId);
        }
      } finally {
        if (state.retiring === promise) state.retiring = undefined;
        resolve();
      }
    })();
    return promise;
  }

  #removeWorkspaceMember(
    workspaceId: string,
    state: SenderState<Sender>,
  ): void {
    const members = this.#workspaceMembers.get(workspaceId);
    members?.delete(state);
    if (members?.size === 0) this.#workspaceMembers.delete(workspaceId);
  }

  #retireWorkspace(workspaceId: string): Promise<void> {
    const existing = this.#workspaceRetirements.get(workspaceId);
    if (existing) return existing;

    const { promise, resolve } = Promise.withResolvers<void>();
    this.#workspaceRetirements.set(workspaceId, promise);
    let workspaceDrain: Promise<void>;
    try {
      workspaceDrain = this.#retirement.retireWorkspace(workspaceId);
    } catch (error) {
      this.#onCleanupError({ kind: "workspace", workspaceId }, error);
      workspaceDrain = Promise.resolve();
    }
    void workspaceDrain
      .catch((error: unknown) => {
        this.#onCleanupError({ kind: "workspace", workspaceId }, error);
      })
      .finally(() => {
        if (this.#workspaceRetirements.get(workspaceId) === promise) {
          this.#workspaceRetirements.delete(workspaceId);
        }
        resolve();
      });
    return promise;
  }
}
