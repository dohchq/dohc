import { randomUUID } from "node:crypto";
import type { Actor } from "@dohc/workspace-contracts";
import type pg from "pg";
import { normalizeEmail } from "./email";
import { assertWorkspaceAccess } from "./shares";
import type { SharedAtomDeps } from "./shared";

const MAX_FRAGMENT_BODY_CHARS = 200_000;
const MAX_FRAGMENT_TEXT_CHARS = 500;

export type CreateDataFragmentRequest = {
  sourcePath?: string | null;
  title?: string | null;
  preview?: string | null;
  contentType?: string | null;
  body?: string;
  recipientEmail?: string;
};

export type DataFragmentSummary = {
  fragmentId: string;
  sourceWorkspaceId: string;
  sourcePath: string | null;
  title: string;
  preview: string;
  contentType: string;
  createdBy: string;
  createdAt: string;
  recipientEmail: string | null;
};

export type DataFragmentBody = DataFragmentSummary & {
  body: string;
};

export async function createDataFragment(
  deps: SharedAtomDeps | undefined,
  actor: Actor,
  readBody: () => Promise<CreateDataFragmentRequest>,
): Promise<{ ok: true; fragment: DataFragmentSummary }> {
  const pool = requirePool(deps);
  // Authz first, matching share creation: non-members never get schema/body
  // or recipient-discovery feedback from a workspace they cannot access.
  await assertWorkspaceAccess(pool, actor);

  const input = parseCreateInput(await readBody());
  const recipient = await resolveVerifiedRecipient(pool, input.recipientEmail);
  const fragmentId = randomUUID();

  const client = await pool.connect();
  try {
    await client.query("begin");
    const fragmentRows = await client.query<DbDataFragmentRow>(
      `insert into data_fragments
         (id, workspace_id, source_path, title, preview, content_type, body, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning ${FRAGMENT_RETURNING}`,
      [
        fragmentId,
        actor.workspaceId,
        input.sourcePath,
        input.title,
        input.preview,
        input.contentType,
        input.body,
        actor.userId,
      ],
    );
    await client.query(
      `insert into data_fragment_shares
         (id, fragment_id, workspace_id, recipient_user_id, recipient_email, created_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (fragment_id, recipient_user_id) where deleted_at is null
       do update set updated_at = now()
       returning id`,
      [
        randomUUID(),
        fragmentId,
        actor.workspaceId,
        recipient.id,
        recipient.email,
        actor.userId,
      ],
    );
    await client.query("commit");
    return {
      ok: true,
      fragment: toSummary(fragmentRows.rows[0], recipient.email),
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listIncomingDataFragments(
  deps: SharedAtomDeps | undefined,
  userId: string,
): Promise<{ ok: true; fragments: DataFragmentSummary[] }> {
  const pool = requirePool(deps);
  const { rows } = await pool.query<DbDataFragmentRow & { recipient_email: string }>(
    `select ${FRAGMENT_RETURNING_DF}, dfs.recipient_email
     from data_fragment_shares dfs
     join data_fragments df on df.id = dfs.fragment_id and df.deleted_at is null
     where dfs.recipient_user_id = $1 and dfs.deleted_at is null
     order by dfs.created_at desc, dfs.id desc
     limit 500`,
    [userId],
  );
  return {
    ok: true,
    fragments: rows.map((row) => toSummary(row, row.recipient_email)),
  };
}

export async function getDataFragment(
  deps: SharedAtomDeps | undefined,
  userId: string,
  fragmentId: string,
): Promise<{ ok: true; fragment: DataFragmentBody }> {
  const pool = requirePool(deps);
  const { rows } = await pool.query<DbDataFragmentRow & AccessFlags & { recipient_email: string | null }>(
    `select ${FRAGMENT_RETURNING_DF}, df.body,
       exists(select 1 from workspace_members m
         where m.workspace_id = df.workspace_id and m.user_id = $2
           and m.deleted_at is null) as is_member,
       exists(select 1 from workspaces w
         where w.workspace_id = df.workspace_id and w.owner_user_id = $2
           and w.deleted_at is null) as is_owner,
       exists(select 1 from data_fragment_shares dfs
         where dfs.fragment_id = df.id and dfs.recipient_user_id = $2
           and dfs.deleted_at is null) as is_recipient,
       (select dfs.recipient_email from data_fragment_shares dfs
         where dfs.fragment_id = df.id and dfs.recipient_user_id = $2
           and dfs.deleted_at is null
         order by dfs.created_at desc, dfs.id desc
         limit 1) as recipient_email
     from data_fragments df
     where df.id = $1 and df.deleted_at is null
     limit 1`,
    [fragmentId, userId],
  );
  const row = rows[0];
  if (!row) throw coded("not-found", "data fragment not found");
  if (!canRead(row, userId)) throw coded("forbidden", "no access to this data fragment");
  return {
    ok: true,
    fragment: { ...toSummary(row, row.recipient_email), body: row.body },
  };
}

export async function revokeDataFragment(
  deps: SharedAtomDeps | undefined,
  userId: string,
  fragmentId: string,
): Promise<{ ok: true; revoked: true }> {
  const pool = requirePool(deps);
  const { rows } = await pool.query<AccessFlags & {
    created_by: string;
    is_recipient: boolean;
  }>(
    `select df.created_by,
       exists(select 1 from workspace_members m
         where m.workspace_id = df.workspace_id and m.user_id = $2
           and m.deleted_at is null) as is_member,
       exists(select 1 from workspaces w
         where w.workspace_id = df.workspace_id and w.owner_user_id = $2
           and w.deleted_at is null) as is_owner,
       exists(select 1 from data_fragment_shares dfs
         where dfs.fragment_id = df.id and dfs.recipient_user_id = $2
           and dfs.deleted_at is null) as is_recipient
     from data_fragments df
     where df.id = $1 and df.deleted_at is null
     limit 1`,
    [fragmentId, userId],
  );
  const row = rows[0];
  if (!row) throw coded("not-found", "data fragment not found");
  if (row.created_by !== userId && !row.is_owner) {
    if (!row.is_member && !row.is_recipient) {
      throw coded("not-found", "data fragment not found");
    }
    throw coded("forbidden", "only the exporter or workspace owner may revoke");
  }
  await pool.query(
    `update data_fragments set deleted_at = now(), updated_at = now()
       where id = $1`,
    [fragmentId],
  );
  await pool.query(
    `update data_fragment_shares set deleted_at = now(), updated_at = now()
       where fragment_id = $1 and deleted_at is null`,
    [fragmentId],
  );
  return { ok: true, revoked: true };
}

type ParsedCreateInput = {
  sourcePath: string | null;
  title: string;
  preview: string;
  contentType: string;
  body: string;
  recipientEmail: string;
};

function parseCreateInput(input: CreateDataFragmentRequest): ParsedCreateInput {
  const body = typeof input.body === "string" ? input.body : "";
  if (body.trim().length === 0) throw coded("invalid-manifest", "body is required");
  if (body.length > MAX_FRAGMENT_BODY_CHARS) {
    throw coded("invalid-manifest", "data fragment is too large");
  }
  const recipientEmail = normalizeEmail(input.recipientEmail);
  if (!recipientEmail) throw coded("invalid-manifest", "recipientEmail must be an email address");
  const sourcePath = boundedOptional(input.sourcePath, "sourcePath", 1000);
  const contentType =
    boundedOptional(input.contentType, "contentType", 100) ?? "text/plain";
  const preview = derivePreview(
    boundedOptional(input.preview, "preview", MAX_FRAGMENT_TEXT_CHARS),
    body,
  );
  const title = deriveTitle(
    boundedOptional(input.title, "title", MAX_FRAGMENT_TEXT_CHARS),
    preview,
    sourcePath,
  );
  return { sourcePath, title, preview, contentType, body, recipientEmail };
}

function boundedOptional(
  value: string | null | undefined,
  label: string,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw coded("invalid-manifest", `${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw coded("invalid-manifest", `${label} is too long`);
  return trimmed;
}

function derivePreview(explicit: string | null, body: string): string {
  if (explicit) return explicit;
  const collapsed = body.replace(/\s+/g, " ").trim();
  return collapsed.length <= 160 ? collapsed : `${collapsed.slice(0, 157)}...`;
}

function deriveTitle(
  explicit: string | null,
  preview: string,
  sourcePath: string | null,
): string {
  if (explicit) return explicit;
  if (sourcePath) return `Data from ${sourcePath.split("/").at(-1) ?? sourcePath}`;
  return preview.length <= 60 ? preview : `${preview.slice(0, 57)}...`;
}

async function resolveVerifiedRecipient(pool: pg.Pool, email: string) {
  const { rows } = await pool.query<{ id: string; email: string }>(
    `select id, email from "user"
     where lower(email) = $1 and "emailVerified" = true limit 1`,
    [email],
  );
  if (!rows[0]) {
    throw coded("not-found", "no verified user with that email");
  }
  return rows[0];
}

function canRead(row: AccessFlags & { created_by: string }, userId: string) {
  return row.created_by === userId || row.is_member || row.is_owner || row.is_recipient;
}

const FRAGMENT_RETURNING =
  "id, workspace_id, source_path, title, preview, content_type, created_by, created_at";
const FRAGMENT_RETURNING_DF =
  "df.id, df.workspace_id, df.source_path, df.title, df.preview, df.content_type, df.created_by, df.created_at";

type DbDataFragmentRow = {
  id: string;
  workspace_id: string;
  source_path: string | null;
  title: string;
  preview: string;
  content_type: string;
  body: string;
  created_by: string;
  created_at: Date | string;
};

type AccessFlags = {
  is_member: boolean;
  is_owner: boolean;
  is_recipient: boolean;
};

function toSummary(
  row: Omit<DbDataFragmentRow, "body">,
  recipientEmail: string | null,
): DataFragmentSummary {
  return {
    fragmentId: row.id,
    sourceWorkspaceId: row.workspace_id,
    sourcePath: row.source_path,
    title: row.title,
    preview: row.preview,
    contentType: row.content_type,
    createdBy: row.created_by,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    recipientEmail,
  };
}

function requirePool(deps: SharedAtomDeps | undefined): pg.Pool {
  if (!deps?.pool) throw coded("not-found", "data fragments are not configured on this server");
  return deps.pool;
}

function coded(code: string, message: string) {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}
