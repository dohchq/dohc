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
  readonly attachmentId: symbol;
  readonly rendererDocumentId: string;
  readonly generation: number;
  isCurrent(): boolean;
}

export interface RendererWorkspaceRetirement<
  Sender extends RendererWorkspaceSender,
> {
  retireSender(
    session: RendererWorkspaceSession<Sender>,
  ): RendererWorkspaceSenderRetirement;
  retireWorkspace(
    workspace: Pick<
      RendererWorkspaceSession<Sender>,
      "workspaceId" | "attachmentId"
    >,
  ): Promise<void>;
}

export interface RendererWorkspaceSenderRetirement {
  /** Cleanup that can collide with the next session's sender-owned resources. */
  readonly requiredForAdmission: Promise<void>;
  /** Cleanup tracked for attachment re-entry but not unrelated admission. */
  readonly detachedFromAdmission: Promise<void>;
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
  retiring: SenderRetirement | undefined;
  rendererDocumentId: string | undefined;
  readonly retiredRendererDocumentIds: Set<string>;
  destroyed: boolean;
}

interface SenderRetirement {
  readonly admission: Promise<void>;
  readonly completion: Promise<void>;
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
  readonly #workspaceMembers = new Map<
    symbol,
    { readonly workspaceId: string; readonly members: Set<SenderState<Sender>> }
  >();
  readonly #workspaceRetirements = new Map<symbol, Promise<void>>();
  readonly #detachedSenderRetirements = new Map<symbol, Set<Promise<void>>>();
  #nextGeneration = 0;

  constructor(options: RendererWorkspaceSessionOwnerOptions<Sender>) {
    this.#retirement = options.retirement;
    this.#onCleanupError = options.onCleanupError ?? (() => undefined);
  }

  async open(
    sender: Sender,
    workspace: { readonly workspaceId: string; readonly attachmentId: symbol },
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
    if (
      active?.workspaceId === workspace.workspaceId &&
      active.attachmentId === workspace.attachmentId &&
      active.isCurrent()
    ) {
      return active;
    }

    const senderRetirement = active
      ? this.#beginSenderRetirement(state, active)
      : state.retiring;
    if (senderRetirement) await senderRetirement.admission;
    this.#assertOpenRequestCurrent(state, requestSequence);

    const workspaceRetirement = this.#workspaceRetirements.get(
      workspace.attachmentId,
    );
    if (workspaceRetirement) await workspaceRetirement;
    this.#assertOpenRequestCurrent(state, requestSequence);

    const session = this.#createSession(state, workspace, rendererDocumentId);
    state.active = session;
    const membership = this.#workspaceMembers.get(workspace.attachmentId) ?? {
      workspaceId: workspace.workspaceId,
      members: new Set<SenderState<Sender>>(),
    };
    membership.members.add(state);
    this.#workspaceMembers.set(workspace.attachmentId, membership);
    return session;
  }

  current(sender: Sender): RendererWorkspaceSession<Sender> | undefined {
    const state = this.#statesBySender.get(sender);
    const session = state?.active;
    return session?.isCurrent() ? session : undefined;
  }

  currentForDocument(
    sender: Sender,
    rendererDocumentId: string,
  ): RendererWorkspaceSession<Sender> | undefined {
    const session = this.current(sender);
    return session?.rendererDocumentId === rendererDocumentId
      ? session
      : undefined;
  }

  isWorkspaceOpen(workspaceId: string): boolean {
    for (const membership of this.#workspaceMembers.values()) {
      if (membership.workspaceId === workspaceId && membership.members.size > 0) {
        return true;
      }
    }
    return false;
  }

  isAttachmentOpen(attachmentId: symbol): boolean {
    return (this.#workspaceMembers.get(attachmentId)?.members.size ?? 0) > 0;
  }

  retireForReload(
    sender: Sender,
    rendererDocumentId: string,
  ): Promise<boolean> {
    let state = this.#statesBySender.get(sender);
    if (!state && !sender.isDestroyed()) {
      state = this.#stateFor(sender);
    }
    if (!state || this.#stateBySenderId.get(sender.id) !== state) {
      return Promise.resolve(false);
    }
    if (
      state.retiredRendererDocumentIds.has(rendererDocumentId) ||
      (state.rendererDocumentId !== undefined &&
        state.rendererDocumentId !== rendererDocumentId)
    ) {
      return Promise.resolve(false);
    }
    state.rendererDocumentId = rendererDocumentId;
    return this.#retireCurrentDocument(state).then(() => true);
  }

  retireAfterCrash(sender: Sender): Promise<void> {
    const state = this.#statesBySender.get(sender);
    if (!state || this.#stateBySenderId.get(sender.id) !== state) {
      return Promise.resolve();
    }
    return this.#retireCurrentDocument(state);
  }

  #retireCurrentDocument(state: SenderState<Sender>): Promise<void> {
    if (state.rendererDocumentId) {
      state.retiredRendererDocumentIds.add(state.rendererDocumentId);
      state.rendererDocumentId = undefined;
    }
    ++state.requestSequence;
    return state.active
      ? this.#beginSenderRetirement(state, state.active).completion
      : (state.retiring?.completion ?? Promise.resolve());
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
        const inherited = {
          admission: retiring.admission,
          completion: retiring.completion,
        };
        state.retiring = inherited;
        void inherited.admission.finally(() => {
          if (state.retiring === inherited) state.retiring = undefined;
        });
      }
    }

    sender.once("destroyed", () => {
      state.destroyed = true;
      ++state.requestSequence;
      const retiring = state.active
        ? this.#beginSenderRetirement(state, state.active)
        : state.retiring;
      void (retiring?.completion ?? Promise.resolve()).finally(() => {
        if (this.#stateBySenderId.get(sender.id) === state) {
          this.#stateBySenderId.delete(sender.id);
        }
      });
    });
    return state;
  }

  #createSession(
    state: SenderState<Sender>,
    workspace: { readonly workspaceId: string; readonly attachmentId: symbol },
    rendererDocumentId: string,
  ): RendererWorkspaceSession<Sender> {
    const generation = ++this.#nextGeneration;
    let session!: RendererWorkspaceSession<Sender>;
    session = Object.freeze({
      sender: state.sender,
      senderId: state.sender.id,
      workspaceId: workspace.workspaceId,
      attachmentId: workspace.attachmentId,
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
  ): SenderRetirement {
    if (state.retiring) return state.retiring;

    state.active = undefined;

    let senderRetirement: RendererWorkspaceSenderRetirement;
    try {
      senderRetirement = this.#retirement.retireSender(session);
    } catch (error) {
      this.#onCleanupError({ kind: "sender", senderId: session.senderId }, error);
      senderRetirement = {
        requiredForAdmission: Promise.resolve(),
        detachedFromAdmission: Promise.resolve(),
      };
    }

    const requiredForAdmission = senderRetirement.requiredForAdmission.catch(
      (error: unknown) => {
        this.#onCleanupError(
          { kind: "sender", senderId: session.senderId },
          error,
        );
      },
    );
    const detached = senderRetirement.detachedFromAdmission.catch(
      (error: unknown) => {
        this.#onCleanupError(
          { kind: "sender", senderId: session.senderId },
          error,
        );
      },
    );
    this.#trackDetachedSenderRetirement(session.attachmentId, detached);

    const admission = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<void>();
    const retirement = {
      admission: admission.promise,
      completion: completion.promise,
    };
    state.retiring = retirement;

    void (async () => {
      let completionDrain = detached;
      try {
        await requiredForAdmission;
        this.#removeWorkspaceMember(session, state);
        if (!this.#workspaceMembers.has(session.attachmentId)) {
          completionDrain = this.#retireWorkspace(session);
        }
      } finally {
        if (state.retiring === retirement) state.retiring = undefined;
        admission.resolve();
      }
      await completionDrain;
      completion.resolve();
    })();
    return retirement;
  }

  #trackDetachedSenderRetirement(
    attachmentId: symbol,
    drain: Promise<void>,
  ): void {
    const drains =
      this.#detachedSenderRetirements.get(attachmentId) ?? new Set();
    drains.add(drain);
    this.#detachedSenderRetirements.set(attachmentId, drains);
    void drain.finally(() => {
      drains.delete(drain);
      if (
        drains.size === 0 &&
        this.#detachedSenderRetirements.get(attachmentId) === drains
      ) {
        this.#detachedSenderRetirements.delete(attachmentId);
      }
    });
  }

  #removeWorkspaceMember(
    workspace: Pick<RendererWorkspaceSession<Sender>, "attachmentId">,
    state: SenderState<Sender>,
  ): void {
    const membership = this.#workspaceMembers.get(workspace.attachmentId);
    membership?.members.delete(state);
    if (membership?.members.size === 0) {
      this.#workspaceMembers.delete(workspace.attachmentId);
    }
  }

  #retireWorkspace(
    workspace: Pick<
      RendererWorkspaceSession<Sender>,
      "workspaceId" | "attachmentId"
    >,
  ): Promise<void> {
    const existing = this.#workspaceRetirements.get(workspace.attachmentId);
    if (existing) return existing;

    const { promise, resolve } = Promise.withResolvers<void>();
    this.#workspaceRetirements.set(workspace.attachmentId, promise);
    const detachedSenderDrains = [
      ...(this.#detachedSenderRetirements.get(workspace.attachmentId) ?? []),
    ];
    let workspaceDrain: Promise<void>;
    try {
      workspaceDrain = this.#retirement.retireWorkspace({
        workspaceId: workspace.workspaceId,
        attachmentId: workspace.attachmentId,
      });
    } catch (error) {
      this.#onCleanupError(
        { kind: "workspace", workspaceId: workspace.workspaceId },
        error,
      );
      workspaceDrain = Promise.resolve();
    }
    void Promise.all([workspaceDrain, ...detachedSenderDrains])
      .catch((error: unknown) => {
        this.#onCleanupError(
          { kind: "workspace", workspaceId: workspace.workspaceId },
          error,
        );
      })
      .finally(() => {
        if (
          this.#workspaceRetirements.get(workspace.attachmentId) === promise
        ) {
          this.#workspaceRetirements.delete(workspace.attachmentId);
        }
        resolve();
      });
    return promise;
  }
}
