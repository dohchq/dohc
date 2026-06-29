import { randomUUID } from "node:crypto";
import type { Actor } from "@dohc/workspace-contracts";
import type pg from "pg";
import { normalizeEmail } from "./email";
import type { SharedAtomDeps } from "./shared";

// Share lifecycle for the repositioned product (plan Phase E5 server lane):
// members/owners share ONE atom with an existing VERIFIED user by email;
// re-sharing the same atom+recipient updates capability in place (the
// pre-pivot backend's audience-upsert semantics) and is restricted to the original sharer
// or the workspace owner; revocation is a soft delete that the
// GET /shared/atoms/:atomId resolver honors immediately. Unknown AND
// unverified emails are the invitation flow (invites.ts), never a share row.

export type ShareCapability = "view" | "edit";

export type CreateShareRequest = {
  atomId?: string;
  atomPath?: string;
  recipientEmail?: string;
  capability?: ShareCapability;
};

export type ShareRow = {
  shareId: string;
  workspaceId: string;
  atomId: string;
  atomPath: string | null;
  recipientUserId: string;
  recipientEmail: string;
  capability: ShareCapability;
};

export type ShareRevocationDisconnectBacklogStats = {
  pendingCount: number;
  claimedCount: number;
  oldestPendingAgeSeconds: number | null;
  oldestClaimedAgeSeconds: number | null;
};

const SHARE_REVOCATION_RETRY_DELAY_SECONDS = 30;
const SHARE_REVOCATION_CLAIM_STALE_SECONDS = 5 * 60;
const SHARE_REVOCATION_DISCONNECT_TIMEOUT_MS = 2_000;
const SHARE_REVOCATION_WORKER_MAX_BATCH = 100;
const SHARE_REVOCATION_COMPLETED_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const POSTGRES_UTC_ISO_FORMAT = `YYYY-MM-DD"T"HH24:MI:SS.MS"Z"`;
const POSTGRES_UTC_ISO_NOW_SQL = `to_char(clock_timestamp() at time zone 'UTC', '${POSTGRES_UTC_ISO_FORMAT}')`;
const POSTGRES_UTC_ISO_YEAR_RE =
  "(?:[0-9]{3}[1-9]|[0-9]{2}[1-9][0-9]|[0-9][1-9][0-9]{2}|[1-9][0-9]{3})";
const POSTGRES_UTC_ISO_DATE_RE =
  `(?:(?:${POSTGRES_UTC_ISO_YEAR_RE}-(?:(?:01|03|05|07|08|10|12)-(?:0[1-9]|[12][0-9]|3[01])|(?:04|06|09|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8])))|(?:(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:0[48]|[2468][048]|[13579][26])00)-02-29))`;
const POSTGRES_UTC_ISO_TIME_RE = "(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}";
const POSTGRES_UTC_ISO_TEXT_RE = `^${POSTGRES_UTC_ISO_DATE_RE}T${POSTGRES_UTC_ISO_TIME_RE}Z$`;

export async function createShare(
  deps: SharedAtomDeps | undefined,
  actor: Actor,
  readBody: () => Promise<CreateShareRequest>,
): Promise<{ ok: true; share: ShareRow }> {
  const pool = requirePool(deps);
  // Authz BEFORE the body is even parsed (security review P3 schema oracle):
  // a non-member gets the uniform 403 whatever they POST, instead of a 400
  // revealing how far their payload got through validation.
  await assertWorkspaceAccess(pool, actor);

  const { atomId, atomPath, recipientEmail, capability } = await readBody();
  if (capability !== "view" && capability !== "edit") {
    throw new Error('capability must be "view" or "edit"');
  }
  const email = normalizeEmail(recipientEmail);
  if (!email) {
    throw new Error("recipientEmail must be an email address");
  }
  if ((atomId === undefined) === (atomPath === undefined)) {
    throw new Error("exactly one of atomId or atomPath is required");
  }

  // The atom must be a LIVE row in the route's workspace whichever way the
  // caller names it (share links are keyed by atoms.id, see shared.ts).
  const atom = await pool.query<{ id: string; path: string }>(
    `select id, path from atoms
     where workspace_id = $1 and deleted_at is null
       and ${atomId !== undefined ? "id = $2" : "path = $2"}
     limit 1`,
    [actor.workspaceId, atomId ?? atomPath],
  );
  if (!atom.rows[0]) throw coded("not-found", "atom not found in this workspace");

  // Recipients are resolved server-side from the Better Auth user table, and
  // ONLY among VERIFIED accounts (security review P1): an attacker who signed
  // up with someone else's address but never proved control of the mailbox
  // must not receive shares meant for its true owner. Unverified and unknown
  // emails share ONE answer — the invitation flow — so the response is also
  // no verification oracle. The remaining 404 is an ACCEPTED member-gated
  // account-existence oracle (security review P3): only authenticated
  // workspace members reach it, and silently falling through to an invitation
  // would escalate an atom-scoped share request into full workspace
  // membership.
  const recipient = await pool.query<{ id: string; email: string }>(
    `select id, email from "user"
     where lower(email) = $1 and "emailVerified" = true limit 1`,
    [email],
  );
  if (!recipient.rows[0]) {
    throw coded("not-found", "no user with that email — invite them to the workspace instead");
  }

  // Capability-update authz BEFORE the upsert (ON CONFLICT cannot authz):
  // re-sharing an existing audience row is restricted to the workspace owner
  // or the original sharer, or any member could silently escalate another
  // sharer's view grant to edit (security review P2). The 403 deliberately
  // does not name the current capability.
  const existing = await pool.query<{ created_by: string | null; is_owner: boolean }>(
    `select s.created_by,
       exists(select 1 from workspaces w
         where w.workspace_id = s.workspace_id and w.owner_user_id = $4
           and w.deleted_at is null) as is_owner
     from shares s
     where s.workspace_id = $1 and s.target_kind = 'atom' and s.target_id = $2
       and s.recipient_user_id = $3 and s.deleted_at is null`,
    [actor.workspaceId, atom.rows[0].id, recipient.rows[0].id, actor.userId],
  );
  if (existing.rows[0] && existing.rows[0].created_by !== actor.userId && !existing.rows[0].is_owner) {
    throw coded("forbidden", "only the original sharer or the workspace owner may change this share");
  }

  // Audience upsert as ONE statement against the migration 0005 partial
  // unique index: concurrent create-share requests can no longer both insert
  // (security review P2 duplicate-row race) — the loser lands in DO UPDATE,
  // which moves capability on the SAME row and keeps the original created_by.
  const { rows } = await pool.query<DbShareRow>(
    `insert into shares (id, workspace_id, target_kind, target_id,
       recipient_user_id, recipient_email, capability, created_by)
     values ($1, $2, 'atom', $3, $4, $5, $6, $7)
     on conflict (workspace_id, target_kind, target_id, recipient_user_id)
       where deleted_at is null
     do update set capability = excluded.capability, updated_at = now()
       where shares.created_by = excluded.created_by
          or exists(select 1 from workspaces w
            where w.workspace_id = shares.workspace_id
              and w.owner_user_id = excluded.created_by
              and w.deleted_at is null)
     returning ${SHARE_RETURNING}`,
    [
      randomUUID(),
      actor.workspaceId,
      atom.rows[0].id,
      recipient.rows[0].id,
      recipient.rows[0].email,
      capability,
      actor.userId,
    ],
  );
  if (!rows[0]) {
    throw coded("forbidden", "only the original sharer or the workspace owner may change this share");
  }
  return { ok: true, share: { ...toShare(rows[0]), atomPath: atom.rows[0].path } };
}

// DELETE /shares/:shareId — soft delete by the sharer or the workspace owner.
// Fellow members get a 403; callers with NO relationship to the share's
// workspace get the same 404 as a missing id, so the response never confirms
// a foreign shareId exists (security review P3 cross-tenant oracle).
export type RevokeShareResult =
  | { ok: true; revoked: true }
  | { ok: true; revoked: true; disconnectDeferred: true };

export async function revokeShare(
  deps: SharedAtomDeps | undefined,
  userId: string,
  shareId: string,
): Promise<RevokeShareResult> {
  const pool = requirePool(deps);
  const client = await pool.connect();
  let destroyClient = false;
  let disconnect:
    | {
        eventId: string;
        hocuspocusAdmin: SharedAtomDeps["hocuspocusAdmin"];
        workspaceId: string;
        userId: string;
      }
    | undefined;
  try {
    await client.query("begin");
    const { rows } = await client.query<{
      created_by: string | null;
      is_owner: boolean;
      is_member: boolean;
      recipient_user_id: string;
      workspace_id: string;
    }>(
      `select s.created_by, s.recipient_user_id, s.workspace_id,
         exists(select 1 from workspaces w
           where w.workspace_id = s.workspace_id and w.owner_user_id = $2
             and w.deleted_at is null) as is_owner,
         exists(select 1 from workspace_members m
           where m.workspace_id = s.workspace_id and m.user_id = $2
             and m.deleted_at is null) as is_member
       from shares s where s.id = $1 and s.deleted_at is null
       for update`,
      [shareId, userId],
    );
    if (!rows[0]) throw coded("not-found", "share not found");
    const isSharer = rows[0].created_by === userId;
    if (!rows[0].is_owner && !(isSharer && rows[0].is_member)) {
      // Members already see the share via listWorkspaceShares, so an honest
      // 403 leaks nothing to them; strangers must not learn the id is live.
      if (!rows[0].is_member) throw coded("not-found", "share not found");
      throw coded("forbidden", "only the sharer or the workspace owner may revoke");
    }
    const hocuspocusAdmin = deps?.hocuspocusAdmin;
    await client.query("update shares set deleted_at = now(), updated_at = now() where id = $1", [
      shareId,
    ]);
    disconnect = {
      eventId: randomUUID(),
      hocuspocusAdmin,
      workspaceId: rows[0].workspace_id,
      userId: rows[0].recipient_user_id,
    };
    await client.query(
      `insert into workspace_events (
         id, workspace_id, actor_user_id, kind, target_kind, target_id, payload
       ) values (
         $1,
         $2,
         $3,
         'share.revocation.disconnect_pending',
         'share',
         $4,
         jsonb_build_object(
           'retryAfter', ${POSTGRES_UTC_ISO_NOW_SQL},
           'recipientUserId', $5::text
         )
       )`,
      [
        disconnect.eventId,
        disconnect.workspaceId,
        userId,
        shareId,
        disconnect.userId,
      ],
    );
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
  if (!disconnect) throw new Error("share revocation disconnect target was not recorded");
  if (!disconnect.hocuspocusAdmin) {
    // The pending event above is the durable queue; deployments can start the
    // retry worker after Hocuspocus admin disconnect is configured. Ops should
    // alert on getShareRevocationDisconnectBacklogStats() count/age growth.
    return { ok: true, revoked: true, disconnectDeferred: true };
  }
  let claimId: string | undefined;
  try {
    claimId = await claimRevocationDisconnectEvent(pool, disconnect.eventId, disconnect.userId);
  } catch {
    return { ok: true, revoked: true, disconnectDeferred: true };
  }
  if (!claimId) return { ok: true, revoked: true, disconnectDeferred: true };
  try {
    await disconnectWorkspaceUserWithinLease(disconnect.hocuspocusAdmin, {
      workspaceId: disconnect.workspaceId,
      userId: disconnect.userId,
    });
  } catch {
    await requeueRevocationDisconnectEvent(pool, disconnect.eventId, claimId);
    return { ok: true, revoked: true, disconnectDeferred: true };
  }
  await completeRevocationDisconnectEvent(pool, disconnect.eventId, claimId);
  return { ok: true, revoked: true };
}

async function claimRevocationDisconnectEvent(
  pool: pg.Pool,
  eventId: string,
  recipientUserId: string,
): Promise<string | undefined> {
  const claimId = randomUUID();
  const { rowCount } = await pool.query(
    `update workspace_events
     set kind = 'share.revocation.disconnect_claimed',
         payload = case
           when jsonb_typeof(payload) = 'object' then
             payload || jsonb_build_object(
               'claimedAt', ${POSTGRES_UTC_ISO_NOW_SQL},
               'claimExpiresAt',
                 to_char(
                   (clock_timestamp() + $4::integer * interval '1 second') at time zone 'UTC',
                   '${POSTGRES_UTC_ISO_FORMAT}'
                 ),
               'claimId', $2::text,
               'recipientUserId', $3::text
             )
           else jsonb_build_object(
             'recipientUserId', $3::text,
             'claimedAt', ${POSTGRES_UTC_ISO_NOW_SQL},
             'claimExpiresAt',
               to_char(
                 (clock_timestamp() + $4::integer * interval '1 second') at time zone 'UTC',
                 '${POSTGRES_UTC_ISO_FORMAT}'
               ),
             'claimId', $2::text
           )
         end
     where id = $1
       and kind = 'share.revocation.disconnect_pending'
       and (
         payload->>'retryAfter' is null
         or payload->>'retryAfter' !~ '${POSTGRES_UTC_ISO_TEXT_RE}'
         or payload->>'retryAfter' <= ${POSTGRES_UTC_ISO_NOW_SQL}
       )`,
    [eventId, claimId, recipientUserId, SHARE_REVOCATION_CLAIM_STALE_SECONDS],
  );
  return rowCount ? claimId : undefined;
}

async function completeRevocationDisconnectEvent(
  pool: pg.Pool,
  eventId: string,
  claimId: string,
): Promise<void> {
  try {
    await pool.query(
      `update workspace_events
       set kind = 'share.revocation.disconnect_completed',
           payload = case
             when jsonb_typeof(payload) = 'object' then
               jsonb_set(payload, '{completedAt}', to_jsonb(${POSTGRES_UTC_ISO_NOW_SQL}), true)
             else jsonb_build_object('completedAt', ${POSTGRES_UTC_ISO_NOW_SQL})
           end
       where id = $1
         and kind = 'share.revocation.disconnect_claimed'
         and payload->>'claimId' = $2`,
      [eventId, claimId],
    );
  } catch {
    await pool
      .query(
        `delete from workspace_events
         where id = $1
           and kind = 'share.revocation.disconnect_claimed'
           and payload->>'claimId' = $2`,
        [eventId, claimId],
      )
      .catch(() => undefined);
    return;
  }
}

async function requeueRevocationDisconnectEvent(
  pool: pg.Pool,
  eventId: string,
  claimId: string,
): Promise<void> {
  await pool
    .query(
      `update workspace_events
       set kind = 'share.revocation.disconnect_pending',
           payload = case
             when jsonb_typeof(payload) = 'object' then
               payload || jsonb_build_object(
                 'retryAfter',
                 to_char(
                   (clock_timestamp() + $3::integer * interval '1 second') at time zone 'UTC',
                   '${POSTGRES_UTC_ISO_FORMAT}'
                 )
               )
             else jsonb_build_object(
               'retryAfter',
               to_char(
                 (clock_timestamp() + $3::integer * interval '1 second') at time zone 'UTC',
                 '${POSTGRES_UTC_ISO_FORMAT}'
               )
             )
           end
       where id = $1
         and kind = 'share.revocation.disconnect_claimed'
         and payload->>'claimId' = $2`,
      [eventId, claimId, SHARE_REVOCATION_RETRY_DELAY_SECONDS],
    )
    .catch(() => undefined);
}

export async function retryPendingShareRevocationDisconnects(
  deps: SharedAtomDeps | undefined,
  limit = 100,
): Promise<{ ok: true; attempted: number; disconnected: number; failed: number }> {
  const pool = requirePool(deps);
  await cleanupStaleShareRevocationDisconnectEvents(pool).catch(() => undefined);
  const hocuspocusAdmin = deps?.hocuspocusAdmin;
  if (!hocuspocusAdmin) {
    throw coded("failed-precondition", "Hocuspocus admin disconnect is not configured");
  }
  const numericLimit = Number(limit);
  const normalizedLimit = Number.isFinite(numericLimit) ? Math.trunc(numericLimit) : 100;
  const boundedLimit = Math.max(1, Math.min(normalizedLimit, SHARE_REVOCATION_WORKER_MAX_BATCH));
  let disconnected = 0;
  let failed = 0;
  const client = await pool.connect();
  let destroyClient = false;
  let attempted = 0;
  const claimed: Array<{
    eventId: string;
    claimId: string;
    workspaceId: string;
    userId: string;
  }> = [];
  try {
    await client.query("begin");
    const { rows } = await client.query<{
      id: string;
      workspace_id: string;
      target_id: string;
      payload: unknown;
    }>(
      `select workspace_events.id,
              workspace_events.workspace_id,
              workspace_events.target_id,
              workspace_events.payload
       from workspace_events
       join (
         select id,
                case
                  when payload->>'retryAfter' ~ $3 then payload->>'retryAfter'
                  else ${POSTGRES_UTC_ISO_NOW_SQL}
                end as sort_at,
                created_at
         from workspace_events
         where kind = 'share.revocation.disconnect_pending'
           and (
             payload->>'retryAfter' is null
             or payload->>'retryAfter' !~ $3
             or payload->>'retryAfter' <= ${POSTGRES_UTC_ISO_NOW_SQL}
           )
         union all
         select id,
                case
                  when payload->>'claimExpiresAt' ~ $3 then payload->>'claimExpiresAt'
                  else ${POSTGRES_UTC_ISO_NOW_SQL}
                end as sort_at,
                created_at
         from workspace_events
         where kind = 'share.revocation.disconnect_claimed'
           and payload->>'claimExpiresAt' is not null
           and (
             payload->>'claimExpiresAt' !~ $3
             or payload->>'claimExpiresAt' <= ${POSTGRES_UTC_ISO_NOW_SQL}
           )
         union all
         select id,
                case
                  when payload->>'claimedAt' ~ $3 then payload->>'claimedAt'
                  else to_char(created_at at time zone 'UTC', '${POSTGRES_UTC_ISO_FORMAT}')
                end as sort_at,
                created_at
         from workspace_events
         where kind = 'share.revocation.disconnect_claimed'
           and payload->>'claimExpiresAt' is null
           and (
             payload->>'claimedAt' is null
             or payload->>'claimedAt' !~ $3
             or payload->>'claimedAt' <=
               to_char(
                 (clock_timestamp() - $2::integer * interval '1 second') at time zone 'UTC',
                 '${POSTGRES_UTC_ISO_FORMAT}'
               )
           )
       ) as due_revocation_disconnects
         on due_revocation_disconnects.id = workspace_events.id
       order by due_revocation_disconnects.sort_at asc,
                due_revocation_disconnects.created_at asc
       limit $1
       for update of workspace_events skip locked`,
      [boundedLimit, SHARE_REVOCATION_CLAIM_STALE_SECONDS, POSTGRES_UTC_ISO_TEXT_RE],
    );
    attempted = rows.length;
    for (const row of rows) {
      const recipientUserIdFromShare = await readRevokedShareRecipientUserId(
        client,
        row.workspace_id,
        row.target_id,
      );
      const recipientUserIdFromPayload = readRecipientUserId(row.payload);
      if (
        !recipientUserIdFromShare ||
        (recipientUserIdFromPayload && recipientUserIdFromPayload !== recipientUserIdFromShare)
      ) {
        failed += 1;
        await client.query("delete from workspace_events where id = $1", [row.id]);
        continue;
      }
      const claimId = randomUUID();
      await client.query(
        `update workspace_events
         set kind = 'share.revocation.disconnect_claimed',
             payload = case
               when jsonb_typeof(payload) = 'object' then
                 payload || jsonb_build_object(
                   'recipientUserId', $3::text,
                   'claimedAt', ${POSTGRES_UTC_ISO_NOW_SQL},
                   'claimExpiresAt',
                     to_char(
                       (clock_timestamp() + $4::integer * interval '1 second') at time zone 'UTC',
                       '${POSTGRES_UTC_ISO_FORMAT}'
                     ),
                   'claimId', $2::text
                 )
               else jsonb_build_object(
                 'recipientUserId', $3::text,
                 'claimedAt', ${POSTGRES_UTC_ISO_NOW_SQL},
                 'claimExpiresAt',
                   to_char(
                     (clock_timestamp() + $4::integer * interval '1 second') at time zone 'UTC',
                     '${POSTGRES_UTC_ISO_FORMAT}'
                   ),
                 'claimId', $2::text
               )
             end
         where id = $1`,
        [row.id, claimId, recipientUserIdFromShare, SHARE_REVOCATION_CLAIM_STALE_SECONDS],
      );
      claimed.push({
        eventId: row.id,
        claimId,
        workspaceId: row.workspace_id,
        userId: recipientUserIdFromShare,
      });
    }
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      destroyClient = true;
    }
    throw error;
  } finally {
    client.release(destroyClient);
  }
  for (const row of claimed) {
    try {
      await disconnectWorkspaceUserWithinLease(hocuspocusAdmin, {
        workspaceId: row.workspaceId,
        userId: row.userId,
      });
    } catch {
      failed += 1;
      await requeueRevocationDisconnectEvent(pool, row.eventId, row.claimId);
      continue;
    }
    disconnected += 1;
    await completeRevocationDisconnectEvent(pool, row.eventId, row.claimId);
  }
  await cleanupStaleShareRevocationDisconnectEvents(pool).catch(() => undefined);
  return { ok: true, attempted, disconnected, failed };
}

export async function getShareRevocationDisconnectBacklogStats(
  deps: SharedAtomDeps | undefined,
): Promise<ShareRevocationDisconnectBacklogStats> {
  const pool = requirePool(deps);
  const { rows } = await pool.query<{
    pending_count: string | number | null;
    claimed_count: string | number | null;
    oldest_pending_age_seconds: string | number | null;
    oldest_claimed_age_seconds: string | number | null;
  }>(
    `select
       count(*) filter (
         where kind = 'share.revocation.disconnect_pending'
       ) as pending_count,
       count(*) filter (
         where kind = 'share.revocation.disconnect_claimed'
       ) as claimed_count,
       extract(epoch from (
         now() - min(created_at) filter (
           where kind = 'share.revocation.disconnect_pending'
         )
       )) as oldest_pending_age_seconds,
       extract(epoch from (
         now() - min(
           case
             when kind = 'share.revocation.disconnect_claimed'
              and payload->>'claimedAt' ~ '${POSTGRES_UTC_ISO_TEXT_RE}'
               then (payload->>'claimedAt')::timestamptz
             when kind = 'share.revocation.disconnect_claimed' then created_at
             else null
           end
         )
       )) as oldest_claimed_age_seconds
     from workspace_events
     where kind in (
       'share.revocation.disconnect_pending',
       'share.revocation.disconnect_claimed'
     )`,
  );
  const row = rows[0];
  return {
    pendingCount: numericStat(row?.pending_count, 0),
    claimedCount: numericStat(row?.claimed_count, 0),
    oldestPendingAgeSeconds: nullableNumericStat(row?.oldest_pending_age_seconds),
    oldestClaimedAgeSeconds: nullableNumericStat(row?.oldest_claimed_age_seconds),
  };
}

function numericStat(value: string | number | null | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumericStat(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function cleanupStaleShareRevocationDisconnectEvents(pool: pg.Pool): Promise<void> {
  await pool.query(
    `delete from workspace_events
      where id in (
        select id
        from workspace_events
        where kind = 'share.revocation.disconnect_completed'
          and nullif(payload->>'completedAt', '') is not null
          and payload->>'completedAt' ~ $3
          and nullif(payload->>'completedAt', '') <
            to_char(
              (now() - $1::integer * interval '1 second') at time zone 'UTC',
              $4
            )
        limit $2
      )`,
    [
      SHARE_REVOCATION_COMPLETED_RETENTION_SECONDS,
      SHARE_REVOCATION_WORKER_MAX_BATCH,
      POSTGRES_UTC_ISO_TEXT_RE,
      POSTGRES_UTC_ISO_FORMAT,
    ],
  );
}

async function disconnectWorkspaceUserWithinLease(
  hocuspocusAdmin: SharedAtomDeps["hocuspocusAdmin"],
  input: { workspaceId: string; userId: string },
): Promise<void> {
  if (!hocuspocusAdmin) {
    throw new Error("Hocuspocus admin disconnect is not configured");
  }
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const disconnect = hocuspocusAdmin.disconnectWorkspaceUser({
    ...input,
    signal: controller.signal,
  });
  disconnect.catch(() => undefined);
  try {
    await Promise.race([
      disconnect,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => {
            controller.abort(new Error("Hocuspocus admin disconnect timed out"));
            reject(new Error("Hocuspocus admin disconnect timed out"));
          },
          SHARE_REVOCATION_DISCONNECT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readRevokedShareRecipientUserId(
  client: pg.PoolClient,
  workspaceId: string,
  shareId: string,
): Promise<string | undefined> {
  const { rows } = await client.query<{ recipient_user_id: string }>(
    `select recipient_user_id
     from shares
     where workspace_id = $1 and id = $2 and deleted_at is not null
     limit 1`,
    [workspaceId, shareId],
  );
  return rows[0]?.recipient_user_id || undefined;
}

// GET /workspaces/:workspaceId/shares — live shares, members/owners only.
export async function listWorkspaceShares(
  deps: SharedAtomDeps | undefined,
  actor: Actor,
): Promise<{ ok: true; shares: ShareRow[] }> {
  const pool = requirePool(deps);
  await assertWorkspaceAccess(pool, actor);
  const { rows } = await pool.query<DbShareRow>(
    `select ${SHARE_RETURNING_S}, a.path as atom_path
     from shares s left join atoms a on a.id = s.target_id and a.deleted_at is null
     where s.workspace_id = $1 and s.target_kind = 'atom' and s.deleted_at is null
     order by s.created_at asc, s.id asc`,
    [actor.workspaceId],
  );
  return { ok: true, shares: rows.map(toShare) };
}

// GET /me/shares — atoms shared WITH the session user ("shared with me");
// shares onto deleted atoms are hidden, like the shared-link resolver.
export async function listMyShares(
  deps: SharedAtomDeps | undefined,
  userId: string,
): Promise<{ ok: true; shares: ShareRow[] }> {
  const pool = requirePool(deps);
  const { rows } = await pool.query<DbShareRow>(
    `select ${SHARE_RETURNING_S}, a.path as atom_path
     from shares s join atoms a on a.id = s.target_id and a.deleted_at is null
     where s.recipient_user_id = $1 and s.target_kind = 'atom' and s.deleted_at is null
     order by s.created_at asc, s.id asc`,
    [userId],
  );
  return { ok: true, shares: rows.map(toShare) };
}

// Same member-or-owner predicate the shared-link resolver uses; route access
// for the share/invite surfaces is resolved directly against Postgres.
export async function assertWorkspaceAccess(pool: pg.Pool, actor: Actor): Promise<void> {
  const { rows } = await pool.query<{ ok: boolean }>(
    `select exists(select 1 from workspace_members m
        where m.workspace_id = $1 and m.user_id = $2 and m.deleted_at is null)
      or exists(select 1 from workspaces w
        where w.workspace_id = $1 and w.owner_user_id = $2 and w.deleted_at is null)
      as ok`,
    [actor.workspaceId, actor.userId],
  );
  if (!rows[0]?.ok) throw coded("forbidden", "not a member of this workspace");
}

const SHARE_RETURNING =
  "id, workspace_id, target_id, recipient_user_id, recipient_email, capability";
const SHARE_RETURNING_S =
  "s.id, s.workspace_id, s.target_id, s.recipient_user_id, s.recipient_email, s.capability";

type DbShareRow = {
  id: string;
  workspace_id: string;
  target_id: string;
  recipient_user_id: string;
  recipient_email: string | null;
  capability: ShareCapability;
  atom_path?: string | null;
};

function toShare(row: DbShareRow): ShareRow {
  return {
    shareId: row.id,
    workspaceId: row.workspace_id,
    atomId: row.target_id,
    atomPath: row.atom_path ?? null,
    recipientUserId: row.recipient_user_id,
    recipientEmail: row.recipient_email ?? "",
    capability: row.capability,
  };
}

function readRecipientUserId(payload: unknown): string | undefined {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
    if (typeof value !== "string" && (!value || typeof value !== "object")) {
      return undefined;
    }
  }
  if (typeof value === "string") return undefined;
  if (!value || typeof value !== "object") return undefined;
  const recipientUserId = (value as { recipientUserId?: unknown }).recipientUserId;
  return typeof recipientUserId === "string" && recipientUserId ? recipientUserId : undefined;
}

function requirePool(deps: SharedAtomDeps | undefined): pg.Pool {
  if (!deps?.pool) throw coded("not-found", "sharing is not configured on this server");
  return deps.pool;
}

function coded(code: string, message: string) {
  const error = new Error(message);
  (error as Error & { code?: string }).code = code;
  return error;
}
