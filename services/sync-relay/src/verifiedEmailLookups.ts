import type { Pool } from "pg";

export function createVerifiedEmailLookups(pool: Pick<Pool, "query">) {
  return {
    async lookupAccountEmail(userId: string): Promise<{email: string; verified: boolean} | null> {
      const result = await pool.query<{email: string; verified: boolean}>(
        'SELECT email, "emailVerified" AS verified FROM "user" WHERE id = $1 LIMIT 1', [userId]);
      return result.rows[0] ?? null;
    },
    async resolveUserIdByEmail(email: string): Promise<string | null> {
      const result = await pool.query<{ id: string }>(
        'SELECT id FROM "user" WHERE lower(email) = lower($1) AND "emailVerified" = true LIMIT 1',
        [email],
      );
      return result.rows[0]?.id ?? null;
    },
    async lookupVerifiedUserEmail(userId: string): Promise<string | null> {
      const result = await pool.query<{ email: string }>(
        'SELECT email FROM "user" WHERE id = $1 AND "emailVerified" = true LIMIT 1',
        [userId],
      );
      return result.rows[0]?.email ?? null;
    },
  };
}
