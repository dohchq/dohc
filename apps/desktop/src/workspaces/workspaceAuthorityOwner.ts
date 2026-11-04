import { folderIdentityKey, type FolderIdentity } from "./workspaceRootIdentity";

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
  // Which folder a canonical root is on disk. Two spellings of one folder,
  // as Linux keeps for a folder that ignores capitals, then share one owner.
  // Without it, or when it returns null, the root's path is its key.
  rootIdentity?(canonicalRootPath: string): FolderIdentity | null;
  createState(binding: WorkspaceAuthorityBinding<Workspace>): State;
  disposeState?(
    state: State,
    binding: WorkspaceAuthorityBinding<Workspace>,
    workspaceAtDisposal: Readonly<Workspace>,
  ): void | Promise<void>;
}

interface AuthorityRecord<Workspace, State> {
  readonly binding: WorkspaceAuthorityBinding<Workspace>;
  readonly rootKeys: readonly string[];
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

// A root as the owner keys it: its canonical path, and the keys a record,
// reservation or cleanup block for that folder holds.
interface AuthorityRoot {
  readonly canonicalRootPath: string;
  readonly rootKeys: readonly string[];
}

interface PreparedWorkspaceBindingRegistration<Workspace, State> {
  readonly workspace: Workspace;
  readonly slot: AuthoritySlot<Workspace, State>;
  readonly root: AuthorityRoot;
  readonly reservation?: WorkspaceAuthorityReservation;
}

interface PreparedWorkspaceIdentity<Workspace, State> {
  readonly slot: AuthoritySlot<Workspace, State>;
  readonly root: AuthorityRoot;
}

interface WorkspaceAuthorityReservationState {
  readonly rootKeys: readonly string[];
  readonly settled: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  cleanup: Promise<void> | null;
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
  const recordsByRootKey = new Map<string, AuthorityRecord<Workspace, State>>();
  const blockedRootKeys = new Map<string, WorkspaceAuthorityReservation>();
  const reservationStates = new Map<
    WorkspaceAuthorityReservation,
    WorkspaceAuthorityReservationState
  >();
  let closing = false;
  let closeOperation: Promise<void> | null = null;

  function assertOpen(): void {
    if (closing) {
      throw new Error("dohc is closing. Open dohc again to continue.");
    }
  }

  // The path always keys a root, and so does its folder on disk when a fresh
  // stat knows it. A match on any key refuses, so neither another spelling nor
  // a stat that fails one time and works the next gets past a record or block.
  function rootKeys(canonicalRootPath: string): string[] {
    const identity = options.rootIdentity?.(canonicalRootPath) ?? null;
    const path = `path:${canonicalRootPath}`;
    return identity ? [path, `folder:${folderIdentityKey(identity)}`] : [path];
  }

  function authorityRoot(rootPath: string): AuthorityRoot {
    const canonicalRootPath = options.canonicalizeRoot(rootPath);
    return { canonicalRootPath, rootKeys: rootKeys(canonicalRootPath) };
  }

  function ownerOf(keys: readonly string[]): AuthorityRecord<Workspace, State> | undefined {
    return keys.map((key) => recordsByRootKey.get(key)).find((record) => record !== undefined);
  }

  function blockerOf(
    keys: readonly string[],
    allowed?: WorkspaceAuthorityReservation,
  ): WorkspaceAuthorityReservation | undefined {
    return keys
      .map((key) => blockedRootKeys.get(key))
      .find((reservation) => reservation !== undefined && reservation !== allowed);
  }

  function release<Holder>(holders: Map<string, Holder>, keys: readonly string[], holder: Holder): void {
    for (const key of keys) {
      if (holders.get(key) === holder) holders.delete(key);
    }
  }

  function createReservationState(keys: readonly string[]): WorkspaceAuthorityReservationState {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const settled = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void settled.catch(() => undefined);
    return { rootKeys: keys, settled, resolve, reject, cleanup: null };
  }

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
    root: AuthorityRoot = authorityRoot(workspace.rootPath),
    allowedReservation?: WorkspaceAuthorityReservation,
  ): AuthorityRecord<Workspace, State> {
    const { canonicalRootPath, rootKeys: keys } = root;
    const rootOwner = ownerOf(keys);
    if (rootOwner) {
      throw new Error(
        `This folder is already attached as workspace ${rootOwner.binding.workspaceId}.`,
      );
    }
    const blockedReservation = blockerOf(keys, allowedReservation);
    if (blockedReservation) {
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
      rootKeys: keys,
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
    for (const key of keys) recordsByRootKey.set(key, record);
    return record;
  }

  function currentRecord(workspaceId: string): AuthorityRecord<Workspace, State> {
    assertOpen();
    const workspace = options.findWorkspace(workspaceId);
    if (!workspace) throw new Error("This workspace is not open. Open it again.");
    const slot = slotFor(workspaceId);
    if (slot.registrationBlocked) {
      throw new Error(
        "This workspace was closed. Open it again.",
      );
    }
    const current = slot.current;
    if (current?.retired) {
      throw new Error("This workspace was closed. Open it again.");
    }
    if (current && !current.retired && bindingMatchesWorkspace(current.binding, workspace)) {
      return current;
    }
    if (current) {
      retire(current);
      throw new Error("This workspace changed while this ran. Try again.");
    }
    const created = createRecord(workspace);
    slot.current = created;
    return created;
  }

  function assertRecordCurrent(record: AuthorityRecord<Workspace, State>): void {
    const slot = slots.get(record.binding.workspaceId);
    const workspace = options.findWorkspace(record.binding.workspaceId);
    if (workspace && !bindingMatchesWorkspace(record.binding, workspace)) {
      throw new Error("This workspace changed while this ran. Try again.");
    }
    if (
      record.retired ||
      slot?.current !== record ||
      !workspace
    ) {
      throw new Error(closing
        ? "dohc is closing. Open dohc again to continue."
        : "This workspace was closed. Open it again.");
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
          throw new Error("This operation ended. Try again.");
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
    if (record && record.binding !== binding) {
      throw new Error("This workspace changed while this ran. Try again.");
    }
    if (!record) {
      throw new Error(closing
        ? "dohc is closing. Open dohc again to continue."
        : "This workspace was closed. Open it again.");
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
          throw new Error("This workspace was closed. Open it again.");
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
        "This workspace was closed. Open it again.",
      );
    }
    if (slot.current || options.findWorkspace(workspace.workspaceId)) {
      throw new Error(
        `Workspace ${workspace.workspaceId} is already registered.`,
      );
    }
    const root = authorityRoot(workspace.rootPath);
    const rootOwner = ownerOf(root.rootKeys);
    if (rootOwner) {
      throw new Error(
        `This folder is already attached as workspace ${rootOwner.binding.workspaceId}.`,
      );
    }
    const blockedReservation = blockerOf(root.rootKeys);
    if (blockedReservation) {
      throw new Error(
        `This folder is blocked by failed cleanup for workspace ${blockedReservation.workspaceId}.`,
      );
    }
    slot.registrationBlocked = true;
    return { slot, root };
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
    const { workspace, slot, root } = prepared;
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
        root,
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
      assertOpen();
      const prepared = prepareWorkspaceIdentity(workspace);
      const reservation = Object.freeze({
        reservationId: Symbol(`workspace-reservation:${workspace.workspaceId}`),
        workspaceId: workspace.workspaceId,
        registeredRootPath: workspace.rootPath,
        canonicalRootPath: prepared.root.canonicalRootPath,
      });
      prepared.slot.reservation = reservation;
      for (const key of prepared.root.rootKeys) blockedRootKeys.set(key, reservation);
      reservationStates.set(reservation, createReservationState(prepared.root.rootKeys));
      return reservation;
    },

    registerBinding(
      workspace: Workspace,
      registration: WorkspaceBindingRegistration,
    ): WorkspaceAuthorityBinding<Workspace> {
      assertOpen();
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
      assertOpen();
      const slot = slots.get(reservation.workspaceId);
      if (
        !slot ||
        slot.reservation !== reservation ||
        workspace.workspaceId !== reservation.workspaceId ||
        workspace.rootPath !== reservation.registeredRootPath
      ) {
        throw new Error("This workspace registration reservation is no longer current.");
      }
      const reservationState = reservationStates.get(reservation);
      if (!reservationState) {
        throw new Error("This workspace registration reservation cannot be settled.");
      }
      if (reservationState.cleanup) {
        throw new Error("This workspace registration reservation is being released.");
      }
      const binding = runRegistration(
        {
          workspace,
          slot,
          // The folder may have become known since the reservation, so read
          // its keys again and keep the reservation's own.
          root: {
            canonicalRootPath: reservation.canonicalRootPath,
            rootKeys: [...new Set([...reservationState.rootKeys, ...rootKeys(reservation.canonicalRootPath)])],
          },
          reservation,
        },
        registration,
        true,
      );
      slot.reservation = null;
      release(blockedRootKeys, reservationState.rootKeys, reservation);
      reservationState.resolve();
      reservationStates.delete(reservation);
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
      const reservationState = reservationStates.get(reservation);
      if (!reservationState) {
        throw new Error("This workspace registration reservation cannot be settled.");
      }
      if (reservationState.cleanup) {
        await reservationState.cleanup;
        return;
      }
      const cleanupOperation = Promise.resolve().then(async () => {
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
        release(blockedRootKeys, reservationState.rootKeys, reservation);
      });
      reservationState.cleanup = cleanupOperation;
      void cleanupOperation.then(
        () => {
          reservationState.resolve();
          if (reservationStates.get(reservation) === reservationState) {
            reservationStates.delete(reservation);
          }
        },
        (error: unknown) => {
          reservationState.reject(error);
          if (reservationStates.get(reservation) === reservationState) {
            reservationStates.delete(reservation);
          }
        },
      );
      await cleanupOperation;
    },

    acquire(workspaceId: string): WorkspaceAuthorityLease<Workspace, State> {
      return leaseRecord(currentRecord(workspaceId));
    },

    // A lookup only. Retirement drains held leases first, so a caller that
    // retires by id must not hold one of its own.
    currentBinding(workspaceId: string): WorkspaceAuthorityBinding<Workspace> {
      return currentRecord(workspaceId).binding;
    },

    attachmentRetirementSignal(workspaceId: string, attachmentId: symbol): AbortSignal {
      const record = slots.get(workspaceId)?.current;
      if (!record || record.retired || record.binding.attachmentId !== attachmentId) {
        throw new Error("This workspace was closed. Open it again.");
      }
      return record.retirement.signal;
    },

    // Whether work that outlives its lease still belongs to the attachment it
    // started on. A lookup only: it never creates or retires an attachment.
    isCurrentAttachment(workspaceId: string, attachmentId: symbol): boolean {
      const record = slots.get(workspaceId)?.current;
      if (record?.binding.attachmentId !== attachmentId) return false;
      try {
        assertRecordCurrent(record);
        return true;
      } catch {
        return false;
      }
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
        return Promise.resolve(work(operation)).finally(() => lease.release());
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
      // A step that fails leaves the workspace listed. The closed attachment
      // goes either way, so it can be opened or removed again at once.
      try {
        await retirement.finalize?.();
        // Another removal of this attachment may have failed, and the workspace
        // opened again since. Removing its row would strand that open one.
        const current = slots.get(binding.workspaceId)?.current;
        if (current && current !== record) {
          throw new Error("This workspace changed while this ran. Try again.");
        }
        await retirement.removeBinding();
      } finally {
        const slot = slots.get(binding.workspaceId);
        if (slot?.current === record) slot.current = null;
        release(recordsByRootKey, record.rootKeys, record);
      }
    },

    async invalidate(workspaceId: string): Promise<void> {
      const slot = slotFor(workspaceId);
      const current = slot.current;
      if (current) retire(current);
      if (!current) return;
      await current.drained;
      if (slot.current === current) slot.current = null;
      release(recordsByRootKey, current.rootKeys, current);
    },

    close(): Promise<void> {
      if (closeOperation) return closeOperation;
      closing = true;
      const drains: Promise<void>[] = [];
      for (const slot of slots.values()) {
        const current = slot.current;
        if (current) {
          retire(current);
          drains.push(current.drained);
        }
      }
      const ownedWork = [
        ...drains,
        ...[...reservationStates.values()].map((state) => state.settled),
      ];
      closeOperation = Promise.allSettled(ownedWork).then((results) => {
        const failed = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failed) throw failed.reason;
        slots.clear();
        recordsByRootKey.clear();
        blockedRootKeys.clear();
        reservationStates.clear();
      });
      return closeOperation;
    },
  };
}
