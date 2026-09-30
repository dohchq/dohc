export interface CredentialSessionSnapshot<Credentials> {
  credentials: Credentials | null;
  generation: number;
}

export type CredentialSessionRead<Credentials> =
  | { current: true; credentials: Credentials | null }
  | { current: false };

export class CredentialSessionCache<Credentials> {
  private credentials: Credentials | null = null;
  private generation = 0;
  // The current load, resolving to why it failed, or null.
  private ready: Promise<{ error: unknown } | null> | null = null;

  constructor(
    private readonly onChange: (
      snapshot: CredentialSessionSnapshot<Credentials>,
    ) => void = () => undefined,
  ) {}

  snapshot(): CredentialSessionSnapshot<Credentials> {
    return {
      credentials: this.credentials,
      generation: this.generation,
    };
  }

  /**
   * Loads once, or waits on the load already running. Resolves to why that
   * load failed, so a caller can tell an unreadable store from a sign-out;
   * null once a later load, set, or clear has replaced it.
   */
  warm(load: () => Promise<Credentials | null>): Promise<{ error: unknown } | null> {
    if (this.ready) return this.ready;
    this.beginLoad(load).catch(() => undefined);
    return this.ready!;
  }

  refresh(load: () => Promise<Credentials | null>): Promise<void> {
    return this.beginLoad(load);
  }

  async adoptCurrent(
    load: () => Promise<Credentials | null>,
  ): Promise<CredentialSessionRead<Credentials>> {
    const generation = this.generation;
    const credentials = await load();
    if (this.generation !== generation) return { current: false };
    if (credentials === null) {
      this.clear();
    } else {
      this.set(credentials);
    }
    return { current: true, credentials };
  }

  set(credentials: Credentials): void {
    this.generation += 1;
    this.credentials = credentials;
    this.ready = Promise.resolve(null);
    this.publish();
  }

  clear(): void {
    this.generation += 1;
    this.credentials = null;
    // A cleared cache is an explicit signed-out state. warm() must not reload
    // a credential file that logout is still removing or failed to remove.
    this.ready = Promise.resolve(null);
    this.publish();
  }

  private beginLoad(load: () => Promise<Credentials | null>): Promise<void> {
    const generation = this.generation + 1;
    this.generation = generation;
    // Reserve the generation before the read and expose no old authority while
    // an explicit refresh decides which account is current.
    this.credentials = null;
    this.publish();

    const attempt = (async () => {
      const credentials = await load();
      if (this.generation !== generation) return;
      this.credentials = credentials;
      this.publish();
    })();
    const ready = attempt.then(
      () => null,
      (error: unknown) => {
        if (this.generation !== generation) return null;
        if (this.ready === ready) this.ready = null;
        return { error };
      },
    );
    this.ready = ready;
    return attempt;
  }

  private publish(): void {
    this.onChange(this.snapshot());
  }
}
