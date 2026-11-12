import type { Pool, PoolClient, QueryConfig } from "pg";

// An account's credential fence lives in Postgres beside Better Auth's tables
// (migration 0005). Its epoch increases in the transaction that changes or
// deletes the account's stored password. The relay reads it on every request a
// personal agent makes, and listens for changes so it can end running work at once.

export const CREDENTIAL_FENCE_CHANNEL = "dohc_credential_fence";
/** How long a dropped `LISTEN` connection waits before it connects again. */
export const CREDENTIAL_FENCE_RETRY_MS = 1_000;
/** How long a fence read waits for Postgres before it fails as unavailable. */
export const CREDENTIAL_FENCE_READ_TIMEOUT_MS = 5_000;

export interface CredentialFenceChange {
  userId: string;
  epoch: number;
  changedAtMs: number;
}

/** What consent needs, read in one statement so the epoch and the session check come from one snapshot. */
export interface ConsentCredentials {
  epoch: number;
  /** The session exists, is the account's, is unexpired, and began at or after the last fence change, both by this database's clock. */
  sessionCurrent: boolean;
}

export interface CredentialFenceListener {
  onChange(change: CredentialFenceChange): void;
  /** The channel dropped. Notifications may be missed until `onUp`. */
  onDown(): void;
  /** The channel is listening again. Read changes since the stored position before trusting it. */
  onUp(): void;
}

export interface CredentialFence {
  /** The account's epoch, by primary key; 0 before its first password change. Rejects while Postgres is down. */
  readEpoch(userId: string): Promise<number>;
  /** Null when the account doesn't exist. */
  readConsentCredentials(userId: string, sessionId: string): Promise<ConsentCredentials | null>;
  /** Every fence changed at or after the position, oldest first. */
  changedSince(positionMs: number): Promise<CredentialFenceChange[]>;
  listen(listener: CredentialFenceListener): { close(): Promise<void> };
}

function epochOf(value: unknown): number {
  const epoch = Number(value ?? 0);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("A credential fence epoch is out of range.");
  return epoch;
}

function parseChange(payload: string): CredentialFenceChange | null {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    const epoch = Number(value.epoch);
    const changedAtMs = Number(value.changedAtMs);
    if (typeof value.userId !== "string" || !Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(changedAtMs)) return null;
    return { userId: value.userId, epoch, changedAtMs };
  } catch {
    return null;
  }
}

/** The fence over Better Auth's Postgres. */
export function createPostgresCredentialFence(pool: Pool): CredentialFence {
  return {
    async readEpoch(userId) {
      // pg reads query_timeout from each query's config, but its QueryConfig type doesn't declare it.
      const query: QueryConfig & { query_timeout: number } = {
        text: "select epoch from dohc_credential_fences where user_id = $1", values: [userId], query_timeout: CREDENTIAL_FENCE_READ_TIMEOUT_MS };
      const result = await pool.query<{ epoch: string }>(query);
      return epochOf(result.rows[0]?.epoch);
    },

    async readConsentCredentials(userId, sessionId) {
      const result = await pool.query<{ epoch: string; session_current: boolean }>(
        `select coalesce(f.epoch, 0) as epoch,
           (s.id is not null and s."expiresAt" > now() and (f.changed_at is null or s.dohc_created_at >= f.changed_at)) as session_current
         from "user" u
         left join dohc_credential_fences f on f.user_id = u.id
         left join "session" s on s.id = $2 and s."userId" = u.id
         where u.id = $1`,
        [userId, sessionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { epoch: epochOf(row.epoch), sessionCurrent: row.session_current === true };
    },

    async changedSince(positionMs) {
      const result = await pool.query<{ user_id: string; epoch: string; changed_at_ms: string }>(
        `select user_id, epoch, floor(extract(epoch from changed_at) * 1000)::bigint as changed_at_ms
         from dohc_credential_fences where changed_at >= to_timestamp($1::double precision / 1000)
         order by changed_at`,
        [positionMs],
      );
      return result.rows.map(row => ({ userId: row.user_id, epoch: epochOf(row.epoch), changedAtMs: Number(row.changed_at_ms) }));
    },

    listen(listener) {
      let closed = false;
      let client: PoolClient | null = null;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const drop = () => {
        const dropped = client;
        client = null;
        dropped?.release(true);
        if (closed || retry) return;
        listener.onDown();
        retry = setTimeout(() => {
          retry = undefined;
          void connect();
        }, CREDENTIAL_FENCE_RETRY_MS);
      };
      const connect = async () => {
        let next: PoolClient | undefined;
        try {
          next = await pool.connect();
          if (closed) {
            next.release();
            return;
          }
          client = next;
          const held = next;
          const lost = () => {
            if (client === held) drop();
          };
          next.on("notification", (message) => {
            const change = message.channel === CREDENTIAL_FENCE_CHANNEL && message.payload ? parseChange(message.payload) : null;
            if (!change) return;
            try {
              listener.onChange(change);
            } catch {
              // A change the listener couldn't apply counts as a lost connection,
              // so the listener stops trusting the channel and catches up again.
              lost();
            }
          });
          next.on("error", lost);
          next.on("end", lost);
          await next.query(`listen ${CREDENTIAL_FENCE_CHANNEL}`);
          if (client === next) listener.onUp();
        } catch {
          // A client still held is released here once. One that a lost
          // connection or close() already let go is not released again.
          drop();
        }
      };
      void connect();
      return {
        async close() {
          closed = true;
          clearTimeout(retry);
          const held = client;
          client = null;
          if (held) {
            await held.query(`unlisten ${CREDENTIAL_FENCE_CHANNEL}`).catch(() => undefined);
            held.release();
          }
        },
      };
    },
  };
}
