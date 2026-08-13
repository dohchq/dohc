export type LocalDocumentSaveState = "saved" | "saving" | "error";

export type LocalDocumentSnapshot = {
  initialized: boolean;
  body: string;
  contentHash: string | null;
  dirty: boolean;
  saveState: LocalDocumentSaveState;
  revision: number;
  source: object | null;
};

type WorkspaceTextWriteResult =
  | { status: "written"; contentHash: string }
  | { status: "conflict"; currentContentHash: string | null };

export type LocalDocumentWriteResult =
  | { status: "skipped"; body: string; contentHash: string | null }
  | { status: "no-baseline"; body: string }
  | ({ body: string; expectedContentHash: string } & WorkspaceTextWriteResult);

const buffers = new Map<string, SharedLocalDocument>();

export function getSharedLocalDocument(key: string): SharedLocalDocument {
  let buffer = buffers.get(key);
  if (!buffer) {
    buffer = new SharedLocalDocument(key);
    buffers.set(key, buffer);
  }
  return buffer;
}

export function acquireSharedLocalDocument(key: string): {
  buffer: SharedLocalDocument;
  release: () => void;
} {
  const buffer = getSharedLocalDocument(key);
  return { buffer, release: buffer.retain() };
}

export function resetSharedLocalDocumentsForTests(): void {
  buffers.clear();
}

export class SharedLocalDocument {
  private initialized = false;
  private refs = 0;
  private listeners = new Set<() => void>();
  private pendingDraft: {
    source: object;
    materialize: () => string;
  } | null = null;
  private tail: Promise<void> = Promise.resolve();
  private writers = 0;
  private latestReadTicket = 0;
  private latestAcceptedReadTicket = 0;
  private releaseDirtyWhenUnused = false;
  private snapshot: LocalDocumentSnapshot = {
    initialized: false,
    body: "",
    contentHash: null,
    dirty: false,
    saveState: "saved",
    revision: 0,
    source: null,
  };

  constructor(private readonly key: string) {}

  retain(): () => void {
    if (!buffers.has(this.key)) buffers.set(this.key, this);
    this.releaseDirtyWhenUnused = false;
    this.refs += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs -= 1;
      this.deleteWhenUnused();
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LocalDocumentSnapshot => this.snapshot;

  getPendingDraftSource = (): object | null =>
    this.pendingDraft?.source ?? null;

  setPendingDraft(pending: {
    source: object;
    materialize: () => string;
  }): void {
    const wasPending = this.pendingDraft !== null;
    this.pendingDraft = pending;
    if (!wasPending) this.notify();
  }

  takePendingDraft(source: object): string | null {
    const pending = this.pendingDraft;
    if (!pending || pending.source !== source) return null;
    const text = pending.materialize();
    if (this.pendingDraft === pending) this.pendingDraft = null;
    this.notify();
    this.deleteWhenUnused();
    return text;
  }

  materializePendingDraft(): string | null {
    const pending = this.pendingDraft;
    if (!pending) return null;
    const text = pending.materialize();
    if (this.pendingDraft === pending) this.pendingDraft = null;
    const revision = this.snapshot.revision;
    this.publishDraft(text, pending.source);
    if (this.snapshot.revision === revision) this.notify();
    return text;
  }

  clearPendingDraft(source: object): void {
    if (this.pendingDraft?.source !== source) return;
    this.pendingDraft = null;
    this.notify();
    this.deleteWhenUnused();
  }

  releaseUnusedDraft(): void {
    if (this.refs !== 0) return;
    this.releaseDirtyWhenUnused = true;
    this.deleteWhenUnused();
  }

  retireCapturedDraft(source: object): void {
    if (this.writers !== 0) return;
    const ownsPendingDraft = this.pendingDraft?.source === source;
    const ownsDirtySnapshot =
      this.snapshot.dirty && this.snapshot.source === source;
    if (!ownsPendingDraft && !ownsDirtySnapshot) return;
    if (ownsPendingDraft) this.pendingDraft = null;
    if (ownsDirtySnapshot) {
      this.replace(
        { body: this.snapshot.body, contentHash: this.snapshot.contentHash },
        source,
        false,
        "error",
      );
    } else {
      this.notify();
    }
    this.deleteWhenUnused();
  }

  beginRead(): number {
    this.latestReadTicket += 1;
    return this.latestReadTicket;
  }

  initializeRead(
    body: string,
    contentHash: string | null,
    readTicket: number,
  ): boolean {
    if (readTicket < this.latestAcceptedReadTicket || this.initialized) {
      return false;
    }
    this.latestAcceptedReadTicket = readTicket;
    this.initialized = true;
    this.replace({ body, contentHash }, null, false, "saved");
    return true;
  }

  reset(body: string, contentHash: string | null, source: object): void {
    this.initialized = true;
    this.replace({ body, contentHash }, source, false, "saved");
  }

  publishDraft(body: string, source: object): void {
    this.initialized = true;
    this.replace(
      { body, contentHash: this.snapshot.contentHash },
      source,
      true,
      "saving",
    );
  }

  acceptRead(
    body: string,
    contentHash: string | null,
    source: object,
    force: boolean,
    readTicket: number,
  ): boolean {
    if (readTicket < this.latestAcceptedReadTicket) {
      return false;
    }
    this.latestAcceptedReadTicket = readTicket;
    const pendingDraft = this.pendingDraft;
    if (this.snapshot.dirty || this.writers > 0 || pendingDraft !== null) {
      const ownsDirtySnapshot =
        !this.snapshot.dirty || this.snapshot.source === source;
      const ownsPendingDraft =
        pendingDraft === null || pendingDraft.source === source;
      const ownsAllDrafts = ownsDirtySnapshot && ownsPendingDraft;
      const canReplaceOwnDraft =
        force && ownsAllDrafts && this.writers === 0;
      if (!canReplaceOwnDraft) {
        if (force && !ownsAllDrafts) this.markError();
        return false;
      }
      if (this.pendingDraft === pendingDraft) this.pendingDraft = null;
    }
    this.initialized = true;
    this.replace(
      { body, contentHash },
      source,
      false,
      "saved",
    );
    this.deleteWhenUnused();
    return true;
  }

  markError(): void {
    this.replace(
      { body: this.snapshot.body, contentHash: this.snapshot.contentHash },
      this.snapshot.source,
      this.snapshot.dirty,
      "error",
    );
  }

  async write(
    source: object,
    writer: (
      body: string,
      expectedContentHash: string,
    ) => Promise<WorkspaceTextWriteResult>,
  ): Promise<LocalDocumentWriteResult> {
    const runsNow = this.writers === 0;
    this.writers += 1;
    const run = async (): Promise<LocalDocumentWriteResult> => {
      const candidate = this.snapshot;
      if (!candidate.dirty) {
        return {
          status: "skipped",
          body: candidate.body,
          contentHash: candidate.contentHash,
        };
      }
      if (candidate.contentHash === null) {
        this.markError();
        return { status: "no-baseline", body: candidate.body };
      }
      this.replace(
        { body: candidate.body, contentHash: candidate.contentHash },
        source,
        true,
        "saving",
      );
      const body = candidate.body;
      const expectedContentHash = candidate.contentHash;
      try {
        const written = await writer(body, expectedContentHash);
        if (written.status === "conflict") {
          this.markError();
          return { ...written, body, expectedContentHash };
        }
        // A read that started before this write still carries the old body and
        // baseline. Keep it from replacing the just-written snapshot when its
        // response arrives later; the next read receives a newer ticket.
        this.latestReadTicket += 1;
        this.latestAcceptedReadTicket = this.latestReadTicket;
        const newerDraft = this.snapshot.body !== body;
        this.replace(
          { body: this.snapshot.body, contentHash: written.contentHash },
          newerDraft ? this.snapshot.source : source,
          newerDraft,
          newerDraft ? "saving" : "saved",
        );
        return { ...written, body, expectedContentHash };
      } catch (error: unknown) {
        this.markError();
        throw error;
      }
    };

    const scheduled = runsNow ? run() : this.tail.then(run, run);
    const result = scheduled.finally(() => {
      this.writers -= 1;
      this.deleteWhenUnused();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  settled(): Promise<void> {
    return this.tail;
  }

  private replace(
    value: { body: string; contentHash: string | null },
    source: object | null,
    dirty: boolean,
    saveState: LocalDocumentSaveState,
  ): void {
    const current = this.snapshot;
    if (
      current.initialized === this.initialized &&
      current.body === value.body &&
      current.contentHash === value.contentHash &&
      current.dirty === dirty &&
      current.saveState === saveState &&
      current.source === source
    ) {
      return;
    }
    this.snapshot = {
      initialized: this.initialized,
      ...value,
      dirty,
      saveState,
      revision: current.revision + 1,
      source,
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private deleteWhenUnused(): void {
    if (
      this.refs !== 0 ||
      this.writers !== 0 ||
      ((this.snapshot.dirty || this.pendingDraft !== null) &&
        !this.releaseDirtyWhenUnused)
    ) {
      return;
    }
    if (buffers.get(this.key) === this) buffers.delete(this.key);
  }
}
