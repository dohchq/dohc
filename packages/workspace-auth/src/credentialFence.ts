import type { Pool, PoolClient } from "pg";

// An account's credential fence lives in Postgres beside Better Auth's tables
// (migration 0005). Its epoch increases in the transaction that changes the
// account's stored password. The relay reads it on every request a personal
// agent makes, and listens for changes so it can end running work at once.

export const CREDENTIAL_FENCE_CHANNEL = "dohc_credential_fence";
/** How long a dropped `LISTEN` connection waits before it connects again. */
export const CREDENTIAL_FENCE_RETRY_MS = 1_000;

export interface CredentialFenceChange {
  userId: string;
  epoch: number;
  changedAtMs: number;
}

/** What consent needs, read in one statement so all of it comes from one snapshot. */
export interface ConsentCredentials {
  /** The account's email-and-password hash; null when it has no password. */
  passwordHash: string | null;
  epoch: number;
  /** The session exists, is the account's, is unexpired, and began after the last fence change. */
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
  verifyPassword(passwordHash: string, password: string): Promise<boolean>;
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

/**
 * The fence over Better Auth's Postgres. `verifyPassword` is Better Auth's
 * own check (`(await auth.$context).password.verify`), so consent accepts
 * exactly the passwords sign-in accepts.
 */
export function createPostgresCredentialFence(pool: Pool, options: {
  verifyPassword(input: { hash: string; password: string }): Promise<boolean>;
}): CredentialFence {
  return {
    async readEpoch(userId) {
      const result = await pool.query<{ epoch: string }>("select epoch from dohc_credential_fences where user_id = $1", [userId]);
      return epochOf(result.rows[0]?.epoch);
    },

    async readConsentCredentials(userId, sessionId) {
      const result = await pool.query<{ password_hash: string | null; epoch: string; session_current: boolean }>(
        `select a."password" as password_hash,
           coalesce(f.epoch, 0) as epoch,
           (s.id is not null and s."expiresAt" > now() and (f.changed_at is null or s."createdAt" > f.changed_at)) as session_current
         from "user" u
         left join "account" a on a."userId" = u.id and a."providerId" = 'credential'
         left join dohc_credential_fences f on f.user_id = u.id
         left join "session" s on s.id = $2 and s."userId" = u.id
         where u.id = $1`,
        [userId, sessionId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { passwordHash: row.password_hash, epoch: epochOf(row.epoch), sessionCurrent: row.session_current === true };
    },

    async verifyPassword(passwordHash, password) {
      try {
        return await options.verifyPassword({ hash: passwordHash, password });
      } catch {
        return false;
      }
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
          next.on("notification", (message) => {
            const change = message.channel === CREDENTIAL_FENCE_CHANNEL && message.payload ? parseChange(message.payload) : null;
            if (change) listener.onChange(change);
          });
          const held = next;
          const lost = () => {
            if (client === held) drop();
          };
          next.on("error", lost);
          next.on("end", lost);
          await next.query(`listen ${CREDENTIAL_FENCE_CHANNEL}`);
          if (client === next) listener.onUp();
        } catch {
          if (next && client !== next) next.release(true);
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
