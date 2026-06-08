import type { Actor, WorkspaceBackend } from "./backend";

export type WorkspaceBackendTestAdapter = {
  name: string;
  setup(): Promise<{
    backend: WorkspaceBackend;
    actor: Actor;
    otherActor: Actor;
  }>;
  teardown(): Promise<void>;
};
