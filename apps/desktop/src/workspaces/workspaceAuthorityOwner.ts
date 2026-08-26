export interface WorkspaceAuthorityBinding<Workspace> {
  readonly attachmentId: symbol;
  readonly workspaceId: string;
  readonly registeredRootPath: string;
  readonly canonicalRootPath: string;
}

export interface WorkspaceAuthorityReservation {
  readonly reservationId: symbol;
  readonly workspaceId: string;
  readonly registeredRootPath: string;
  readonly canonicalRootPath: string;
}

export interface WorkspaceAuthorityLease<Workspace, State> {
  readonly binding: WorkspaceAuthorityBinding<Workspace>;
  readonly state: State;
  assertCurrent(): void;
  release(): void;
}

export type PhysicalWorkspace<Workspace> = Readonly<
  Workspace & { readonly attachmentId: symbol; readonly rootPath: string }
>;

export interface WorkspaceAuthorityOperation<Workspace, State> {
  readonly workspace: PhysicalWorkspace<Workspace>;
  readonly state: State;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

export interface WorkspaceAuthorityOwnerOptions<
  Workspace extends { workspaceId: string; rootPath: string },
  State,
> {
  findWorkspace(workspaceId: string): Workspace | null;
  canonicalizeRoot(rootPath: string): string;
  createState(binding: WorkspaceAuthorityBinding<Workspace>): State;
  disposeState?(
    state: State,
    binding: WorkspaceAuthorityBinding<Workspace>,
    workspaceAtDisposal: Readonly<Workspace>,
  ): void | Promise<void>;
}

interface AuthorityRecord<Workspace, State> {
  readonly binding: WorkspaceAuthorityBinding<Workspace>;
  readonly initialWorkspace: Readonly<Workspace>;
  readonly state: State;
  held: number;
  retired: boolean;
  disposalStarted: boolean;
  readonly retirement: AbortController;
  readonly drained: Promise<void>;
  readonly resolveDrained: () => void;
  readonly rejectDrained: (error: unknown) => void;
}

interface AuthoritySlot<Workspace, State> {
  current: AuthorityRecord<Workspace, State> | null;
  registrationBlocked: boolean;
  reservation: WorkspaceAuthorityReservation | null;
}

interface WorkspaceBindingRegistration {
  persist(): void;
  rollback(): void;
}

interface WorkspaceBindingRetirement {
  finalize?(): void | Promise<void>;
  removeBinding(): void | Promise<void>;
}

interface PreparedWorkspaceBindingRegistration<Workspace, State> {
  readonly workspace: Workspace;
  readonly slot: AuthoritySlot<Workspace, State>;
  readonly canonicalRootPath: string;
  readonly reservation?: WorkspaceAuthorityReservation;
}

interface PreparedWorkspaceIdentity<Workspace, State> {
  readonly slot: AuthoritySlot<Workspace, State>;
  readonly canonicalRootPath: string;
}

function bindingMatchesWorkspace<Workspace extends { rootPath: string }>(
  binding: Pick<WorkspaceAuthorityBinding<Workspace>, "registeredRootPath">,
  workspace: Workspace,
): boolean {
  return binding.registeredRootPath === workspace.rootPath;
}

/**
 * Owns process-local state whose identity is one attached physical workspace.
 *
 * A workspace id is only a lookup key. Each attachment gets an unforgeable
 * binding with one canonical root. `invalidate` retires that binding even when
 * the same id and root are registered again, so old work cannot survive an
 * absent-to-identical transition.
 */
export function createWorkspaceAuthorityOwner<
  Workspace extends { workspaceId: string; rootPath: string },
  State,
>(options: WorkspaceAuthorityOwnerOptions<Workspace, State>) {
  const slots = new Map<string, AuthoritySlot<Workspace, State>>();
  const recordsByCanonicalRoot = new Map<string, AuthorityRecord<Workspace, State>>();
  const blockedCanonicalRoots = new Map<string, WorkspaceAuthorityReservation>();
  const pendingReservationCleanups = new Map<
    WorkspaceAuthorityReservation,
    Promise<void>
  >();

  function slotFor(workspaceId: string): AuthoritySlot<Workspace, State> {
    const existing = slots.get(workspaceId);
    if (existing) return existing;
    const created: AuthoritySlot<Workspace, State> = {
      current: null,
      registrationBlocked: false,
      reservation: null,
    };
    slots.set(workspaceId, created);
    return created;
  }

  function dispose(record: AuthorityRecord<Workspace, State>): void {
    if (!record.retired || record.held !== 0 || record.disposalStarted) return;
    record.disposalStarted = true;
    Promise.resolve()
      .then(() => {
        const current = options.findWorkspace(record.binding.workspaceId);
        const workspaceAtDisposal = Object.freeze({
          ...(current && bindingMatchesWorkspace(record.binding, current)
            ? current
            : record.initialWorkspace),
        }) as Readonly<Workspace>;
        return options.disposeState?.(
          record.state,
          record.binding,
          workspaceAtDisposal,
        );
      })
      .then(record.resolveDrained, record.rejectDrained);
  }

  function retire(record: AuthorityRecord<Workspace, State>): void {
    if (record.retired) return;
    record.retired = true;
    record.retirement.abort();
    dispose(record);
  }

  function createRecord(
    workspace: Workspace,
    canonicalRootPath = options.canonicalizeRoot(workspace.rootPath),
    allowedReservation?: WorkspaceAuthorityReservation,
  ): AuthorityRecord<Workspace, State> {
    const rootOwner = recordsByCanonicalRoot.get(canonicalRootPath);
    if (rootOwner) {
      throw new Error(
        `This folder is already attached as workspace ${rootOwner.binding.workspaceId}.`,
      );
    }
    const blockedReservation = blockedCanonicalRoots.get(canonicalRootPath);
    if (blockedReservation && blockedReservation !== allowedReservation) {
      throw new Error(
        `This folder is blocked by failed cleanup for workspace ${blockedReservation.workspaceId}.`,
      );
    }
    const binding = Object.freeze({
      attachmentId: Symbol(`workspace-attachment:${workspace.workspaceId}`),
      workspaceId: workspace.workspaceId,
      registeredRootPath: workspace.rootPath,
      canonicalRootPath,
    }) as WorkspaceAuthorityBinding<Workspace>;
    let resolveDrained!: () => void;
    let rejectDrained!: (error: unknown) => void;
    const drained = new Promise<void>((resolve, reject) => {
      resolveDrained = resolve;
      rejectDrained = reject;
    });
    const record = {
      binding,
      initialWorkspace: Object.freeze({ ...workspace }),
      state: undefined as State,
      held: 0,
      retired: false,
      disposalStarted: false,
      retirement: new AbortController(),
      drained,
      resolveDrained,
      rejectDrained,
    };
    record.state = options.createState(binding);
    recordsByCanonicalRoot.set(canonicalRootPath, record);
    return record;
  }

  function currentRecord(workspaceId: string): AuthorityRecord<Workspace, State> {
    const workspace = options.findWorkspace(workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    const slot = slotFor(workspaceId);
    if (slot.registrationBlocked) {
      throw new Error(
        "This workspace attachment is retiring or blocked by failed cleanup.",
      );
    }
    const current = slot.current;
    if (current?.retired) {
      throw new Error("This workspace attachment is retiring or blocked by failed cleanup.");
    }
    if (current && !current.retired && bindingMatchesWorkspace(current.binding, workspace)) {
      return current;
    }
    if (current) {
      retire(current);
      throw new Error("This workspace attachment changed before its old authority was cleaned up.");
    }
    const created = createRecord(workspace);
    slot.current = created;
    return created;
  }

  function assertRecordCurrent(record: AuthorityRecord<Workspace, State>): void {
    const slot = slots.get(record.binding.workspaceId);
    const workspace = options.findWorkspace(record.binding.workspaceId);
    if (
      record.retired ||
      slot?.current !== record ||
      !workspace ||
      !bindingMatchesWorkspace(record.binding, workspace)
    ) {
      throw new Error("This work belongs to a retired workspace authority.");
    }
  }

  function leaseRecord(
    record: AuthorityRecord<Workspace, State>,
  ): WorkspaceAuthorityLease<Workspace, State> {
    assertRecordCurrent(record);
    record.held += 1;
    let released = false;
    return Object.freeze({
      binding: record.binding,
      state: record.state,
      assertCurrent(): void {
        if (released) {
          throw new Error("This workspace authority lease was released.");
        }
        assertRecordCurrent(record);
      },
      release(): void {
        if (released) return;
        released = true;
        record.held -= 1;
        dispose(record);
      },
    });
  }

  function recordForBinding(
    binding: WorkspaceAuthorityBinding<Workspace>,
  ): AuthorityRecord<Workspace, State> {
    const record = slots.get(binding.workspaceId)?.current;
    if (!record || record.binding !== binding) {
      throw new Error("This work belongs to a retired workspace authority.");
    }
    return record;
  }

  function operationForLease(
    lease: WorkspaceAuthorityLease<Workspace, State>,
  ): WorkspaceAuthorityOperation<Workspace, State> {
    lease.assertCurrent();
    const record = recordForBinding(lease.binding);
    return Object.freeze({
      get workspace(): PhysicalWorkspace<Workspace> {
        lease.assertCurrent();
        const workspace = options.findWorkspace(lease.binding.workspaceId);
        if (!workspace || !bindingMatchesWorkspace(lease.binding, workspace)) {
          throw new Error("This work belongs to a retired workspace authority.");
        }
        return Object.freeze({
          ...workspace,
          rootPath: lease.binding.canonicalRootPath,
          attachmentId: lease.binding.attachmentId,
        }) as PhysicalWorkspace<Workspace>;
      },
      state: lease.state,
      signal: record.retirement.signal,
      assertCurrent: () => lease.assertCurrent(),
    });
  }

  function prepareWorkspaceIdentity(
    workspace: { workspaceId: string; rootPath: string },
  ): PreparedWorkspaceIdentity<Workspace, State> {
    const slot = slotFor(workspace.workspaceId);
    if (slot.registrationBlocked || slot.current?.retired) {
      throw new Error(
        "This workspace attachment is retiring or blocked by failed cleanup.",
      );
    }
    if (slot.current || options.findWorkspace(workspace.workspaceId)) {
      throw new Error(
        `Workspace ${workspace.workspaceId} is already registered.`,
      );
    }
    const canonicalRootPath = options.canonicalizeRoot(workspace.rootPath);
    const rootOwner = recordsByCanonicalRoot.get(canonicalRootPath);
    if (rootOwner) {
      throw new Error(
        `This folder is already attached as workspace ${rootOwner.binding.workspaceId}.`,
      );
    }
    const blockedReservation = blockedCanonicalRoots.get(canonicalRootPath);
    if (blockedReservation) {
      throw new Error(
        `This folder is blocked by failed cleanup for workspace ${blockedReservation.workspaceId}.`,
      );
    }
    slot.registrationBlocked = true;
    return { slot, canonicalRootPath };
  }

  function prepareRegistration(
    workspace: Workspace,
  ): PreparedWorkspaceBindingRegistration<Workspace, State> {
    return { workspace, ...prepareWorkspaceIdentity(workspace) };
  }

  function runRegistration(
    prepared: PreparedWorkspaceBindingRegistration<Workspace, State>,
    registration: WorkspaceBindingRegistration,
    retainBlockOnFailure: boolean,
  ): WorkspaceAuthorityBinding<Workspace> {
    const { workspace, slot, canonicalRootPath } = prepared;
    try {
      registration.persist();
      const persisted = options.findWorkspace(workspace.workspaceId);
      if (
        !persisted ||
        !bindingMatchesWorkspace(
          { registeredRootPath: workspace.rootPath },
          persisted,
        )
      ) {
        throw new Error(
          "Workspace registration did not persist the requested binding.",
        );
      }
      const created = createRecord(
        persisted,
        canonicalRootPath,
        prepared.reservation,
      );
      slot.current = created;
      slot.registrationBlocked = false;
      return created.binding;
    } catch (error) {
      let rollbackSucceeded = false;
      try {
        registration.rollback();
        if (options.findWorkspace(workspace.workspaceId)) {
          throw new Error(
            "Workspace registration rollback left the registry binding in place.",
          );
        }
        rollbackSucceeded = true;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Workspace registration failed and could not be rolled back.",
        );
      } finally {
        if (!retainBlockOnFailure && rollbackSucceeded) {
          slot.registrationBlocked = false;
        }
      }
      throw error;
    }
  }

  return {
    workspaceIds(): string[] {
      return [...slots.entries()]
        .filter(
          ([, slot]) =>
            !slot.registrationBlocked &&
            slot.current !== null &&
            !slot.current.retired,
        )
        .map(([workspaceId]) => workspaceId);
    },

    reserveBinding(
      workspace: { workspaceId: string; rootPath: string },
    ): WorkspaceAuthorityReservation {
      const prepared = prepareWorkspaceIdentity(workspace);
      const reservation = Object.freeze({
        reservationId: Symbol(`workspace-reservation:${workspace.workspaceId}`),
        workspaceId: workspace.workspaceId,
        registeredRootPath: workspace.rootPath,
        canonicalRootPath: prepared.canonicalRootPath,
      });
      prepared.slot.reservation = reservation;
      blockedCanonicalRoots.set(prepared.canonicalRootPath, reservation);
      return reservation;
    },

    registerBinding(
      workspace: Workspace,
      registration: WorkspaceBindingRegistration,
    ): WorkspaceAuthorityBinding<Workspace> {
      return runRegistration(
        prepareRegistration(workspace),
        registration,
        false,
      );
    },

    registerReservedBinding(
      reservation: WorkspaceAuthorityReservation,
      workspace: Workspace,
      registration: WorkspaceBindingRegistration,
    ): WorkspaceAuthorityBinding<Workspace> {
      const slot = slots.get(reservation.workspaceId);
      if (
        !slot ||
        slot.reservation !== reservation ||
        workspace.workspaceId !== reservation.workspaceId ||
        workspace.rootPath !== reservation.registeredRootPath
      ) {
        throw new Error("This workspace registration reservation is no longer current.");
      }
      const binding = runRegistration(
        {
          workspace,
          slot,
          canonicalRootPath: reservation.canonicalRootPath,
          reservation,
        },
        registration,
        true,
      );
      slot.reservation = null;
      if (
        blockedCanonicalRoots.get(reservation.canonicalRootPath) === reservation
      ) {
        blockedCanonicalRoots.delete(reservation.canonicalRootPath);
      }
      return binding;
    },

    async releaseReservation(
      reservation: WorkspaceAuthorityReservation,
      cleanup: () => void | Promise<void>,
    ): Promise<void> {
      const slot = slots.get(reservation.workspaceId);
      if (!slot || slot.reservation !== reservation) {
        throw new Error("This workspace registration reservation is no longer current.");
      }
      const cleanupOperation = (async () => {
        if (options.findWorkspace(reservation.workspaceId)) {
          throw new Error(
            "Workspace registration cleanup cannot run while its registry binding remains.",
          );
        }
        await cleanup();
        if (options.findWorkspace(reservation.workspaceId)) {
          throw new Error(
            "Workspace registration cleanup raced with a new registry binding.",
          );
        }
        slot.reservation = null;
        slot.registrationBlocked = false;
        if (
          blockedCanonicalRoots.get(reservation.canonicalRootPath) === reservation
        ) {
          blockedCanonicalRoots.delete(reservation.canonicalRootPath);
        }
      })();
      pendingReservationCleanups.set(reservation, cleanupOperation);
      try {
        await cleanupOperation;
      } finally {
        if (pendingReservationCleanups.get(reservation) === cleanupOperation) {
          pendingReservationCleanups.delete(reservation);
        }
      }
    },

    acquire(workspaceId: string): WorkspaceAuthorityLease<Workspace, State> {
      return leaseRecord(currentRecord(workspaceId));
    },

    acquireBinding(
      binding: WorkspaceAuthorityBinding<Workspace>,
    ): WorkspaceAuthorityLease<Workspace, State> {
      return leaseRecord(recordForBinding(binding));
    },

    withAuthority<Result>(
      workspaceId: string,
      work: (lease: WorkspaceAuthorityLease<Workspace, State>) => Result | Promise<Result>,
    ): Promise<Result> {
      const lease = this.acquire(workspaceId);
      try {
        return Promise.resolve(work(lease)).finally(() => lease.release());
      } catch (error) {
        lease.release();
        return Promise.reject(error);
      }
    },

    withBinding<Result>(
      binding: WorkspaceAuthorityBinding<Workspace>,
      work: (lease: WorkspaceAuthorityLease<Workspace, State>) => Result | Promise<Result>,
    ): Promise<Result> {
      const lease = this.acquireBinding(binding);
      try {
        return Promise.resolve(work(lease)).finally(() => lease.release());
      } catch (error) {
        lease.release();
        return Promise.reject(error);
      }
    },

    withOperation<Result>(
      workspaceId: string,
      work: (
        operation: WorkspaceAuthorityOperation<Workspace, State>,
      ) => Result | Promise<Result>,
    ): Promise<Result> {
      const lease = this.acquire(workspaceId);
      try {
        const operation = operationForLease(lease);
        return Promise.resolve(work(operation))
          .then((result) => {
            operation.assertCurrent();
            return result;
          })
          .finally(() => lease.release());
      } catch (error) {
        lease.release();
        return Promise.reject(error);
      }
    },

    async retireBinding(
      binding: WorkspaceAuthorityBinding<Workspace>,
      retirement: WorkspaceBindingRetirement,
    ): Promise<void> {
      const record = recordForBinding(binding);
      retire(record);
      await record.drained;
      await retirement.finalize?.();
      await retirement.removeBinding();
      const slot = slots.get(binding.workspaceId);
      if (slot?.current === record) slot.current = null;
      if (recordsByCanonicalRoot.get(binding.canonicalRootPath) === record) {
        recordsByCanonicalRoot.delete(binding.canonicalRootPath);
      }
    },

    async invalidate(workspaceId: string): Promise<void> {
      const slot = slotFor(workspaceId);
      const current = slot.current;
      if (current) retire(current);
      if (!current) return;
      await current.drained;
      if (slot.current === current) slot.current = null;
      if (recordsByCanonicalRoot.get(current.binding.canonicalRootPath) === current) {
        recordsByCanonicalRoot.delete(current.binding.canonicalRootPath);
      }
    },

    async close(): Promise<void> {
      const drains: Promise<void>[] = [];
      for (const slot of slots.values()) {
        const current = slot.current;
        if (current) {
          retire(current);
          drains.push(current.drained);
        }
      }
      await Promise.all([
        ...drains,
        ...pendingReservationCleanups.values(),
      ]);
      slots.clear();
      recordsByCanonicalRoot.clear();
      blockedCanonicalRoots.clear();
    },
  };
}
