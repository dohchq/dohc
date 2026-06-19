import { randomUUID } from "node:crypto";
import type {
  Actor,
  AssetKind,
  SaveAssetInput,
  WorkspaceFile,
} from "@dohc/workspace-contracts";
import { WorkspaceError, WorkspacePath } from "@dohc/workspace-contracts";
import type { PgQueryable } from "./workspaces";

export type AssetRow = {
  id: string;
  workspace_id: string;
  path: string;
  kind: AssetKind;
  media_type: string;
  size: number;
  sha256: string;
  object_key: string;
  revision: number;
  updated_at: Date;
};

export function assetRowToWorkspaceFile(row: AssetRow): WorkspaceFile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    kind: "asset",
    contentType: row.media_type,
    revision: String(row.revision),
    updatedAt: row.updated_at.getTime(),
  };
}

export async function listAssetFiles(
  db: PgQueryable,
  actor: Actor,
): Promise<WorkspaceFile[]> {
  const result = await db.query<AssetRow>(
    `
      select id, workspace_id, path, kind, media_type, size, sha256, object_key, revision, updated_at
      from assets
      where workspace_id = $1
        and deleted_at is null
      order by path asc
    `,
    [actor.workspaceId],
  );
  return result.rows.map(assetRowToWorkspaceFile);
}

export async function insertAsset(
  db: PgQueryable,
  actor: Actor,
  input: SaveAssetInput,
  stored: { objectKey: string; sha256: string; size: number },
) {
  WorkspacePath.parse(input.path);
  const assetId = randomUUID();
  try {
    const result = await db.query<AssetRow>(
      `
        insert into assets (
          id,
          workspace_id,
          path,
          kind,
          media_type,
          size,
          sha256,
          object_key,
          revision
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, 1)
        returning id, workspace_id, path, kind, media_type, size, sha256, object_key, revision, updated_at
      `,
      [
        assetId,
        actor.workspaceId,
        input.path,
        input.kind,
        input.mediaType,
        stored.size,
        stored.sha256,
        stored.objectKey,
      ],
    );
    return result.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkspaceError("conflict", "File path already exists");
    }
    throw error;
  }
}

// Create-only insertAsset has a sibling here: updateAsset swaps the stored
// blob of an EXISTING live asset under optimistic concurrency (mirrors
// updateAtom). Sync routes update-with-bytes here, never to insertAsset.
export async function updateAsset(
  db: PgQueryable,
  actor: Actor,
  input: {
    path: string;
    expectedRevision: string;
    mediaType: string;
    kind: AssetKind;
  },
  stored: { objectKey: string; sha256: string; size: number },
) {
  WorkspacePath.parse(input.path);
  const current = await db.query<AssetRow>(
    `
      select id, workspace_id, path, kind, media_type, size, sha256, object_key, revision, updated_at
      from assets
      where workspace_id = $1
        and path = $2
        and deleted_at is null
      for update
    `,
    [actor.workspaceId, input.path],
  );
  const row = current.rows[0];
  if (!row) throw new WorkspaceError("not_found", "Asset not found");
  if (String(row.revision) !== input.expectedRevision) {
    throw new WorkspaceError("conflict", "Expected revision is stale");
  }

  const nextRevision = row.revision + 1;
  const updated = await db.query<AssetRow>(
    `
      update assets
      set kind = $3,
          media_type = $4,
          size = $5,
          sha256 = $6,
          object_key = $7,
          revision = $8,
          updated_at = now()
      where id = $1
        and workspace_id = $2
      returning id, workspace_id, path, kind, media_type, size, sha256, object_key, revision, updated_at
    `,
    [
      row.id,
      actor.workspaceId,
      input.kind,
      input.mediaType,
      stored.size,
      stored.sha256,
      stored.objectKey,
      nextRevision,
    ],
  );
  return updated.rows[0];
}

export async function readAssetMetadata(
  db: PgQueryable,
  actor: Actor,
  path: string,
) {
  WorkspacePath.parse(path);
  const result = await db.query<AssetRow>(
    `
      select id, workspace_id, path, kind, media_type, size, sha256, object_key, revision, updated_at
      from assets
      where workspace_id = $1
        and path = $2
        and deleted_at is null
      limit 1
    `,
    [actor.workspaceId, path],
  );
  const row = result.rows[0];
  if (!row) throw new WorkspaceError("not_found", "Asset not found");
  return row;
}

export async function renameAsset(
  db: PgQueryable,
  actor: Actor,
  input: {
    fromPath: string;
    toPath: string;
    expectedRevision: string;
  },
) {
  WorkspacePath.parse(input.fromPath);
  WorkspacePath.parse(input.toPath);
  const current = await db.query<AssetRow>(
    `
      select id, workspace_id, path, kind, media_type, size, sha256, object_key, revision, updated_at
      from assets
      where workspace_id = $1
        and path = $2
        and deleted_at is null
      for update
    `,
    [actor.workspaceId, input.fromPath],
  );
  const row = current.rows[0];
  if (!row) throw new WorkspaceError("not_found", "Asset not found");
  if (String(row.revision) !== input.expectedRevision) {
    throw new WorkspaceError("conflict", "Expected revision is stale");
  }

  const nextRevision = row.revision + 1;
  try {
    const updated = await db.query<AssetRow>(
      `
        update assets
        set path = $3,
            revision = $4,
            updated_at = now()
        where id = $1
          and workspace_id = $2
        returning id, workspace_id, path, kind, media_type, size, sha256, object_key, revision, updated_at
      `,
      [row.id, actor.workspaceId, input.toPath, nextRevision],
    );
    return updated.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkspaceError("conflict", "File path already exists");
    }
    throw error;
  }
}

export async function softDeleteAsset(
  db: PgQueryable,
  actor: Actor,
  path: string,
  expectedRevision?: string,
) {
  WorkspacePath.parse(path);
  // Lock the live row so the revision check and delete are atomic; without it a
  // stale delete from one machine could erase another machine's newer content.
  const current = await db.query<Pick<AssetRow, "id" | "revision">>(
    `
      select id, revision
      from assets
      where workspace_id = $1
        and path = $2
        and deleted_at is null
      for update
    `,
    [actor.workspaceId, path],
  );
  const row = current.rows[0];
  if (!row) throw new WorkspaceError("not_found", "Asset not found");
  if (expectedRevision !== undefined && String(row.revision) !== expectedRevision) {
    throw new WorkspaceError("conflict", "Expected revision is stale");
  }
  await db.query(
    `update assets set deleted_at = now(), updated_at = now() where id = $1 and workspace_id = $2`,
    [row.id, actor.workspaceId],
  );
  return row.id;
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
