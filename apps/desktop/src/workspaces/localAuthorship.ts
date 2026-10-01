import type { LocalPersonAuthor } from "./desktopRecordEdits";

export interface LocalAuthorship {
  /** The credential cache settled on this account, or on signed out (null). */
  credentialsSettled(accountId: string | null): void;
  /** Resolves once the first credential load has settled. */
  settled(): Promise<void>;
  /** The person now: the last settled account, or this installation. */
  personId(): string;
  /**
   * The person a request is made by. Read when the request arrives once an
   * account has settled; before the first one has, after it settles.
   */
  person(): Promise<LocalPersonAuthor>;
}

/**
 * This computer's person, as History credits it: the account the credential
 * cache last settled on, or this installation when signed out. A load in
 * progress keeps the last settled account, so an edit made while it runs is
 * not relabeled; only the very first load is waited for.
 */
export function createLocalAuthorship(options: {
  installationId(): string;
  /** Starts or joins the first credential load. Never rejects. */
  loadCredentials(): Promise<unknown>;
}): LocalAuthorship {
  let account: string | null = null;
  let settled = false;
  const personId = () => account ?? options.installationId();
  const personNow = (): LocalPersonAuthor => ({ kind: "human", humanId: personId() });
  return {
    credentialsSettled(accountId) {
      account = accountId;
      settled = true;
    },
    settled: async () => {
      if (!settled) await options.loadCredentials();
    },
    personId,
    person() {
      if (settled) return Promise.resolve(personNow());
      return options.loadCredentials().then(personNow);
    },
  };
}
