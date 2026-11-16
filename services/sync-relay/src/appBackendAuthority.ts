export type AppBackendAuth =
  | { kind: "link"; capabilityHash: string; profileTokenHash: string }
  | {
      kind: "named";
      workspaceId: string;
      userId: string;
      grantId?: string;
      /** The owner's agent making this change, as the owner's computer reports it. Provenance only. */
      agent?: { depth: number; agentId?: string };
      /** A phone launch's binding, which the owner's authority checks at admission, before each commit, and inside it. */
      launch?: PhoneAppLaunchGuard;
    };

/** What a phone launch is bound to, checked again while its request works. */
export interface PhoneAppLaunchGuard {
  /** Reads only relay storage, so it runs inside a commit. Throws not-found once the launch's reach has ended. */
  authorizeOperation(): void;
  /**
   * The sign-in too, read from the session table, then everything `authorizeOperation` checks. Awaited after a
   * write's operation runs and before its commit, and before any answer leaves the relay.
   */
  recheck(): Promise<void>;
}
