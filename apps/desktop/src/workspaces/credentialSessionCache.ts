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
  private ready: Promise<void> | null = null;

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

  warm(load: () => Promise<Credentials | null>): Promise<void> {
    if (this.ready) return this.ready;
    return this.beginLoad(load).catch(() => undefined);
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
    this.ready = Promise.resolve();
    this.publish();
  }

  clear(): void {
    this.generation += 1;
    this.credentials = null;
    // A cleared cache is an explicit signed-out state. warm() must not reload
    // a credential file that logout is still removing or failed to remove.
    this.ready = Promise.resolve();
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
      () => undefined,
      () => {
        if (this.generation === generation && this.ready === ready) {
          this.ready = null;
        }
      },
    );
    this.ready = ready;
    return attempt;
  }

  private publish(): void {
    this.onChange(this.snapshot());
  }
}
