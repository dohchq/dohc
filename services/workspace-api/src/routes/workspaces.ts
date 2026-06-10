import type { Actor } from "@dohc/workspace-contracts";

export type CreateWorkspaceInput = {
  workspaceId: string;
  name: string;
  kind: "personal" | "shared";
};

export type CreateWorkspaceFn = (
  actor: Actor,
  input: CreateWorkspaceInput,
) => Promise<{ created: boolean }>;

// The desktop's local workspace UUID becomes the cloud workspace id verbatim.
const WORKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,199}$/;

// Validated BEFORE actor resolution so identity never derives from bad input.
export function parseCreateWorkspaceRequest(body: unknown): CreateWorkspaceInput {
  const { workspaceId, name, kind } = (body ?? {}) as Record<string, unknown>;
  if (typeof workspaceId !== "string" || !WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("workspaceId must match ^[a-z0-9][a-z0-9-]{0,199}$");
  }
  if (name !== undefined && typeof name !== "string") {
    throw new Error("name must be a string");
  }
  if (kind !== undefined && kind !== "personal" && kind !== "shared") {
    throw new Error('kind must be "personal" or "shared"');
  }
  return { workspaceId, name: name ?? workspaceId, kind: kind ?? "personal" };
}

export async function createWorkspace(
  create: CreateWorkspaceFn,
  actor: Actor,
  input: CreateWorkspaceInput,
) {
  const { created } = await create(actor, input);
  return { ok: true, created, workspaceId: input.workspaceId };
}
