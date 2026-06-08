import { randomUUID } from "node:crypto";
import type {
  Actor,
  AtomKind,
  CreateAtomInput,
  WorkspaceFile,
  WriteAtomInput,
} from "@dohc/workspace-contracts";
import { WorkspaceError, WorkspacePath } from "@dohc/workspace-contracts";
import type { PgQueryable } from "./workspaces";

type AtomRow = {
  id: string;
  workspace_id: string;
  path: string;
  kind: AtomKind;
  body: string;
  revision: number;
  updated_at: Date;
};

function contentTypeForAtomKind(kind: AtomKind) {
  switch (kind) {
    case "csv":
      return "text/csv";
    case "json":
      return "application/json";
    case "html":
      return "text/html";
    case "text":
      return "text/plain";
    case "app-source":
      return "text/plain";
    case "markdown":
      return "text/markdown";
  }
}

export function atomRowToWorkspaceFile(row: AtomRow): WorkspaceFile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    kind: "atom",
    contentType: contentTypeForAtomKind(row.kind),
    revision: String(row.revision),
    updatedAt: row.updated_at.getTime(),
  };
}

export async function listAtomFiles(
  db: PgQueryable,
  actor: Actor,
): Promise<WorkspaceFile[]> {
  const result = await db.query<AtomRow>(
    `
      select id, workspace_id, path, kind, body, revision, updated_at
      from atoms
      where workspace_id = $1
        and deleted_at is null
      order by path asc
    `,
    [actor.workspaceId],
  );
  return result.rows.map(atomRowToWorkspaceFile);
}

export async function readAtomText(
  db: PgQueryable,
  actor: Actor,
  path: string,
) {
  WorkspacePath.parse(path);
  const result = await db.query<Pick<AtomRow, "body" | "revision">>(
    `
      select body, revision
      from atoms
      where workspace_id = $1
        and path = $2
        and deleted_at is null
      limit 1
    `,
    [actor.workspaceId, path],
  );
  const row = result.rows[0];
  if (!row) throw new WorkspaceError("not_found", "Atom not found");
  return { body: row.body, revision: String(row.revision) };
}

export async function insertAtom(
  db: PgQueryable,
  actor: Actor,
  input: CreateAtomInput,
) {
  WorkspacePath.parse(input.path);
  const atomId = randomUUID();
  try {
    const result = await db.query<AtomRow>(
      `
        insert into atoms (id, workspace_id, path, kind, body, revision)
        values ($1, $2, $3, $4, $5, 1)
        returning id, workspace_id, path, kind, body, revision, updated_at
      `,
      [atomId, actor.workspaceId, input.path, input.kind, input.body],
    );
    await insertAtomRevision(db, {
      actor,
      atomId,
      revision: 1,
      body: input.body,
    });
    return result.rows[0];
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new WorkspaceError("conflict", "File path already exists");
    }
    throw error;
  }
}

export async function updateAtom(
  db: PgQueryable,
  actor: Actor,
  input: WriteAtomInput,
) {
  WorkspacePath.parse(input.path);
  const current = await db.query<AtomRow>(
    `
      select id, workspace_id, path, kind, body, revision, updated_at
      from atoms
      where workspace_id = $1
        and path = $2
        and deleted_at is null
      for update
    `,
    [actor.workspaceId, input.path],
  );
  const row = current.rows[0];
  if (!row) throw new WorkspaceError("not_found", "Atom not found");
  if (String(row.revision) !== input.expectedRevision) {
    throw new WorkspaceError("conflict", "Expected revision is stale");
  }

  const nextRevision = row.revision + 1;
  const updated = await db.query<AtomRow>(
    `
      update atoms
      set body = $3,
          revision = $4,
          updated_at = now()
      where id = $1
        and workspace_id = $2
      returning id, workspace_id, path, kind, body, revision, updated_at
    `,
    [row.id, actor.workspaceId, input.body, nextRevision],
  );
  await insertAtomRevision(db, {
    actor,
    atomId: row.id,
    revision: nextRevision,
    body: input.body,
  });
  return updated.rows[0];
}

export async function softDeleteAtom(
  db: PgQueryable,
  actor: Actor,
  path: string,
) {
  WorkspacePath.parse(path);
  const result = await db.query<Pick<AtomRow, "id">>(
    `
      update atoms
      set deleted_at = now(),
          updated_at = now()
      where workspace_id = $1
        and path = $2
        and deleted_at is null
      returning id
    `,
    [actor.workspaceId, path],
  );
  const row = result.rows[0];
  if (!row) throw new WorkspaceError("not_found", "Atom not found");
  return row.id;
}

async function insertAtomRevision(
  db: PgQueryable,
  args: {
    actor: Actor;
    atomId: string;
    revision: number;
    body: string;
  },
) {
  await db.query(
    `
      insert into atom_revisions (
        id,
        workspace_id,
        atom_id,
        revision,
        body,
        actor_user_id
      )
      values ($1, $2, $3, $4, $5, $6)
    `,
    [
      randomUUID(),
      args.actor.workspaceId,
      args.atomId,
      args.revision,
      args.body,
      args.actor.userId,
    ],
  );
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
