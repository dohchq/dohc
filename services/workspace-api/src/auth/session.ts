import type { Actor } from "@dohc/workspace-contracts";

export type ResolveActor = (request: Request, workspaceId: string) => Actor | Promise<Actor>;

export async function resolveSessionActor(_request: Request, _workspaceId: string): Promise<Actor> {
  throw new Error("workspace API requires a server-side actor resolver");
}
