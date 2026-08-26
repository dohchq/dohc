export interface WorkspaceAuthorityBinding<Workspace> {
  readonly attachmentId: symbol;
  readonly workspaceId: string;
  readonly registeredRootPath: string;
  readonly canonicalRootPath: string;
  readonly workspace: Readonly<Workspace>;
}

export interface WorkspaceAuthorityLease<Workspace, State> {
  readonly binding: WorkspaceAuthorityBinding<Workspace>;
  readonly state: State;
  assertCurrent(): void;
  release(): void;
}

export interface WorkspaceAuthorityOwnerOptions<
  Workspace extends { workspaceId: string; rootPath: string },
  State,
> {
  findWorkspace(workspaceId: string): Workspace | null;
  canonicalizeRoot(rootPath: string): string;
  createState(binding: WorkspaceAuthorityBinding<Workspace>): State;
  disposeState?(state: State, binding: WorkspaceAuthorityBinding<Workspace>): void | Promise<void>;
}

interface AuthorityRecord<Workspace, State> {
  readonly binding: WorkspaceAuthorityBinding<Workspace>;
  readonly state: State;
  held: number;
  retired: boolean;
  disposalStarted: boolean;
  readonly drained: Promise<void>;
  readonly resolveDrained: () => void;
  readonly rejectDrained: (error: unknown) => void;
}

interface AuthoritySlot<Workspace, State> {
  current: AuthorityRecord<Workspace, State> | null;
}

function bindingMatchesWorkspace<Workspace extends { rootPath: string }>(
  binding: WorkspaceAuthorityBinding<Workspace>,
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

  function slotFor(workspaceId: string): AuthoritySlot<Workspace, State> {
    const existing = slots.get(workspaceId);
    if (existing) return existing;
    const created: AuthoritySlot<Workspace, State> = {
      current: null,
    };
    slots.set(workspaceId, created);
    return created;
  }

  function dispose(record: AuthorityRecord<Workspace, State>): void {
    if (!record.retired || record.held !== 0 || record.disposalStarted) return;
    record.disposalStarted = true;
    Promise.resolve()
      .then(() => options.disposeState?.(record.state, record.binding))
      .then(record.resolveDrained, record.rejectDrained);
  }

  function retire(record: AuthorityRecord<Workspace, State>): void {
    if (record.retired) return;
    record.retired = true;
    dispose(record);
  }

  function createRecord(workspace: Workspace): AuthorityRecord<Workspace, State> {
    const canonicalRootPath = options.canonicalizeRoot(workspace.rootPath);
    const rootOwner = recordsByCanonicalRoot.get(canonicalRootPath);
    if (rootOwner) {
      throw new Error(
        `This folder is already attached as workspace ${rootOwner.binding.workspaceId}.`,
      );
    }
    const binding = Object.freeze({
      attachmentId: Symbol(`workspace-attachment:${workspace.workspaceId}`),
      workspaceId: workspace.workspaceId,
      registeredRootPath: workspace.rootPath,
      canonicalRootPath,
      workspace: Object.freeze({ ...workspace }),
    }) as WorkspaceAuthorityBinding<Workspace>;
    let resolveDrained!: () => void;
    let rejectDrained!: (error: unknown) => void;
    const drained = new Promise<void>((resolve, reject) => {
      resolveDrained = resolve;
      rejectDrained = reject;
    });
    const record = {
      binding,
      state: undefined as State,
      held: 0,
      retired: false,
      disposalStarted: false,
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

  return {
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

    async retireBinding(
      binding: WorkspaceAuthorityBinding<Workspace>,
      removeBinding: () => void | Promise<void>,
    ): Promise<void> {
      const record = recordForBinding(binding);
      retire(record);
      await record.drained;
      await removeBinding();
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
      await Promise.all(drains);
      slots.clear();
      recordsByCanonicalRoot.clear();
    },
  };
}
