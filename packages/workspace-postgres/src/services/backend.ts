import type pg from "pg";
import type {
  Actor,
  CreateAtomInput,
  SaveAssetInput,
  WorkspaceBackend,
  WriteAtomInput,
} from "@dohc/workspace-contracts";
import { WorkspaceError } from "@dohc/workspace-contracts";
import {
  atomRowToWorkspaceFile,
  insertAtom,
  listAtomFiles,
  readAtomText,
  softDeleteAtom,
  updateAtom,
} from "../repositories/atoms";
import { insertWorkspaceEvent } from "../repositories/events";
import {
  hasWorkspaceMembership,
  type PgQueryable,
} from "../repositories/workspaces";
import { assertWorkspaceMember } from "../policy/authorize";

export function createPostgresWorkspaceBackend(
  pool: pg.Pool,
): WorkspaceBackend {
  async function assertAuthorized(db: PgQueryable, actor: Actor) {
    await assertWorkspaceMember({
      actor,
      workspaceId: actor.workspaceId,
      hasMembership: (userId, workspaceId) =>
        hasWorkspaceMembership(db, userId, workspaceId),
    });
  }

  return {
    async listFiles(actor) {
      await assertAuthorized(pool, actor);
      return listAtomFiles(pool, actor);
    },
    async readText(actor, path) {
      await assertAuthorized(pool, actor);
      return readAtomText(pool, actor, path);
    },
    async createAtom(actor, input: CreateAtomInput) {
      return withTransaction(pool, async (client) => {
        await assertAuthorized(client, actor);
        const row = await insertAtom(client, actor, input);
        await insertWorkspaceEvent(client, {
          actor,
          kind: "atom_created",
          targetKind: "atom",
          targetId: row.id,
          payload: { path: input.path, revision: row.revision },
        });
        return atomRowToWorkspaceFile(row);
      });
    },
    async writeAtom(actor, input: WriteAtomInput) {
      return withTransaction(pool, async (client) => {
        await assertAuthorized(client, actor);
        const row = await updateAtom(client, actor, input);
        await insertWorkspaceEvent(client, {
          actor,
          kind: "atom_updated",
          targetKind: "atom",
          targetId: row.id,
          payload: { path: input.path, revision: row.revision },
        });
        return atomRowToWorkspaceFile(row);
      });
    },
    async saveAsset(_actor, _input: SaveAssetInput) {
      throw new WorkspaceError(
        "unsupported_media_type",
        "Asset storage is implemented in Phase 6",
      );
    },
    async deleteFile(actor, path) {
      await withTransaction(pool, async (client) => {
        await assertAuthorized(client, actor);
        const atomId = await softDeleteAtom(client, actor, path);
        await insertWorkspaceEvent(client, {
          actor,
          kind: "file_deleted",
          targetKind: "atom",
          targetId: atomId,
          payload: { path },
        });
      });
    },
  };
}

async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
