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
  | ({ body: string; expectedContentHash: string } & WorkspaceTextWriteResult);

const buffers = new Map<string, SharedLocalDocument>();

export function localDocumentKey(
  workspaceId: string,
  path: string,
  reopenKey: number | undefined,
): string {
  return JSON.stringify([workspaceId, path, reopenKey ?? null]);
}

export function getSharedLocalDocument(key: string): SharedLocalDocument {
  let buffer = buffers.get(key);
  if (!buffer) {
    buffer = new SharedLocalDocument(key);
    buffers.set(key, buffer);
  }
  return buffer;
}

export function resetSharedLocalDocumentsForTests(): void {
  buffers.clear();
}

export class SharedLocalDocument {
  private initialized = false;
  private refs = 0;
  private listeners = new Set<() => void>();
  private tail: Promise<void> = Promise.resolve();
  private writers = 0;
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

  initialize(body: string, contentHash: string | null): void {
    if (this.initialized) return;
    this.initialized = true;
    this.replace({ body, contentHash }, null, false, "saved");
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
    force = false,
  ): boolean {
    if (!force && (this.snapshot.dirty || this.writers > 0)) return false;
    this.initialized = true;
    this.replace(
      { body, contentHash },
      source,
      false,
      force ? "error" : "saved",
    );
    return true;
  }

  markError(source: object): void {
    this.replace(
      { body: this.snapshot.body, contentHash: this.snapshot.contentHash },
      source,
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
    this.replace(
      { body: this.snapshot.body, contentHash: this.snapshot.contentHash },
      source,
      this.snapshot.dirty,
      "saving",
    );

    let resolveResult!: (result: LocalDocumentWriteResult) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<LocalDocumentWriteResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const run = async () => {
      const current = this.snapshot;
      if (!current.dirty || current.contentHash === null) {
        resolveResult({
          status: "skipped",
          body: current.body,
          contentHash: current.contentHash,
        });
        return;
      }
      const body = current.body;
      const expectedContentHash = current.contentHash;
      try {
        const written = await writer(body, expectedContentHash);
        if (written.status === "conflict") {
          this.markError(source);
          resolveResult({ ...written, body, expectedContentHash });
          return;
        }
        const newerDraft = this.snapshot.body !== body;
        this.replace(
          { body: this.snapshot.body, contentHash: written.contentHash },
          source,
          newerDraft,
          newerDraft ? "saving" : "saved",
        );
        resolveResult({ ...written, body, expectedContentHash });
      } catch (error) {
        this.markError(source);
        rejectResult(error);
      }
    };

    const queued = (runsNow ? run() : this.tail.then(run, run)).finally(() => {
      this.writers -= 1;
      this.deleteWhenUnused();
    });
    this.tail = queued.then(
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
    for (const listener of [...this.listeners]) listener();
  }

  private deleteWhenUnused(): void {
    if (this.refs !== 0 || this.writers !== 0) return;
    if (buffers.get(this.key) === this) buffers.delete(this.key);
  }
}
