import type { Actor } from "@dohc/workspace-contracts";

export type WorkspaceEvent = {
  id: string;
  workspaceId: string;
  type: string;
  createdAt: number;
  payload?: unknown;
};

export type WorkspaceEventSource = {
  listEvents(actor: Actor): Promise<WorkspaceEvent[]>;
};

export async function listWorkspaceEvents(actor: Actor, source?: WorkspaceEventSource) {
  return {
    ok: true,
    events: source ? await source.listEvents(actor) : [],
  };
}
