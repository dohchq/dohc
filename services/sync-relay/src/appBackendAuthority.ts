export type AppBackendAuth =
  | { kind: "link"; capabilityHash: string; profileTokenHash: string }
  | { kind: "named"; workspaceId: string; userId: string; grantId?: string };
