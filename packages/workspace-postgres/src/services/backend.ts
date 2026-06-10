import type pg from "pg";
import type {
  Actor,
  CreateAtomInput,
  RenameFileInput,
  WorkspaceBackend,
  WriteAtomInput,
} from "@dohc/workspace-contracts";
import { composeRenamedPath, WorkspaceError } from "@dohc/workspace-contracts";
import { createLocalBlobStore, type BlobStore } from "../blobStore";
import {
  assetRowToWorkspaceFile,
  insertAsset,
  listAssetFiles,
  readAssetMetadata,
  renameAsset,
  softDeleteAsset,
} from "../repositories/assets";
import {
  atomRowToWorkspaceFile,
  insertAtom,
  listAtomFiles,
  readAtomMetadata,
  readAtomText,
  renameAtom,
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
  options: { blobStore?: BlobStore } = {},
): WorkspaceBackend {
  const blobStore = options.blobStore ?? createLocalBlobStore();

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
      const [atoms, assets] = await Promise.all([
        listAtomFiles(pool, actor),
        listAssetFiles(pool, actor),
      ]);
      return [...atoms, ...assets].sort((a, b) => a.path.localeCompare(b.path));
    },
    async readText(actor, path) {
      await assertAuthorized(pool, actor);
      return readAtomText(pool, actor, path);
    },
    async getFileMetadata(actor, path) {
      await assertAuthorized(pool, actor);
      try {
        return atomRowToWorkspaceFile(await readAtomMetadata(pool, actor, path));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      try {
        return assetRowToWorkspaceFile(await readAssetMetadata(pool, actor, path));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async readAsset(actor, path) {
      await assertAuthorized(pool, actor);
      const row = await readAssetMetadata(pool, actor, path);
      return {
        mediaType: row.media_type,
        kind: row.kind,
        bytes: await blobStore.get(row.object_key),
        revision: String(row.revision),
      };
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
    async saveAsset(actor, input) {
      return withTransaction(pool, async (client) => {
        await assertAuthorized(client, actor);
        const stored = await blobStore.put(input.bytes);
        const row = await insertAsset(client, actor, input, stored);
        await insertWorkspaceEvent(client, {
          actor,
          kind: "asset_saved",
          targetKind: "asset",
          targetId: row.id,
          payload: {
            path: input.path,
            mediaType: input.mediaType,
            size: stored.size,
            sha256: stored.sha256,
            revision: row.revision,
          },
        });
        return assetRowToWorkspaceFile(row);
      });
    },
    async renameFile(actor, input: RenameFileInput) {
      return withTransaction(pool, async (client) => {
        await assertAuthorized(client, actor);
        const toPath = composeRenamedPath(input.fromPath, input.toName);
        const renamed = await renameAnyFile(client, actor, {
          ...input,
          toPath,
        });
        await insertWorkspaceEvent(client, {
          actor,
          kind: "file_renamed",
          targetKind: renamed.kind,
          targetId: renamed.id,
          payload: {
            fromPath: input.fromPath,
            toPath,
            revision: renamed.revision,
          },
        });
        return renamed;
      });
    },
    async deleteFile(actor, path) {
      await withTransaction(pool, async (client) => {
        await assertAuthorized(client, actor);
        const deleted = await softDeleteAnyFile(client, actor, path);
        await insertWorkspaceEvent(client, {
          actor,
          kind: "file_deleted",
          targetKind: deleted.kind,
          targetId: deleted.id,
          payload: { path },
        });
      });
    },
  };
}

async function renameAnyFile(
  db: PgQueryable,
  actor: Actor,
  input: RenameFileInput & { toPath: string },
) {
  try {
    return atomRowToWorkspaceFile(await renameAtom(db, actor, input));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return assetRowToWorkspaceFile(await renameAsset(db, actor, input));
}

async function softDeleteAnyFile(db: PgQueryable, actor: Actor, path: string) {
  try {
    return { kind: "atom" as const, id: await softDeleteAtom(db, actor, path) };
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return { kind: "asset" as const, id: await softDeleteAsset(db, actor, path) };
}

function isNotFound(error: unknown) {
  return error instanceof WorkspaceError && error.code === "not_found";
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
