export type AppBackendAuth =
  | { kind: "link"; capabilityHash: string; profileTokenHash: string }
  | {
      kind: "named";
      workspaceId: string;
      userId: string;
      grantId?: string;
      /** The owner's agent making this change, as the owner's computer reports it. Provenance only. */
      agent?: { depth: number; agentId?: string };
    };
