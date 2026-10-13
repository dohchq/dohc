import { APIError } from "better-auth/api";
import type { Pool } from "pg";
import {
  ACCOUNT_DELETION_KEY_HEADER, ACCOUNT_DELETION_PATH, accountDeletionKey,
  mintDeletionPreviewToken, matchesDeletionPreviewToken, verifiesDeletionPreviewToken, accountDeletionPreviewKey, ACCOUNT_DELETION_FRESH_AGE_MS,
  type AccountDeletionPreview, type AccountDeletionScope,
} from "@dohc/workspace-auth/accountDeletion";

export function createAccountDeletion(options: {pool: Pool; secret: string; serverOrigin: string; relayUrl: string | null; fetch?: typeof fetch}) {
  const {pool} = options, key = accountDeletionKey(options.secret), previewKey = accountDeletionPreviewKey(options.secret);
  const call = async (operation: "preview" | "purge", user: {id: string; email: string}): Promise<unknown> => {
    if (!options.relayUrl) throw new APIError("SERVICE_UNAVAILABLE", {code: "DELETION_UNAVAILABLE", message: "This server cannot delete accounts yet. Contact the server owner."});
    const response = await (options.fetch ?? fetch)(new URL(ACCOUNT_DELETION_PATH, options.relayUrl), {
      method: "POST", headers: {"content-type": "application/json", [ACCOUNT_DELETION_KEY_HEADER]: key},
      body: JSON.stringify({operation, userId: user.id, email: user.email}), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (!response.ok) throw new APIError("SERVICE_UNAVAILABLE", {code: "DELETION_PENDING", message: "Account deletion is waiting for the server. Try again later."});
    return response.json();
  };
  async function previewFor(user: {id: string; email: string}): Promise<AccountDeletionPreview> {
    const value = await call("preview", user);
    if (!value || typeof value !== "object") throw new Error("Invalid account deletion preview.");
    const scope = value as AccountDeletionScope;
    if (!Array.isArray(scope.workspaceIds) || scope.workspaceIds.some(id => typeof id !== "string") ||
        scope.workspaceCount !== scope.workspaceIds.length || ![scope.ownedShareCount, scope.heldGrantCount, scope.storedBytes].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid account deletion preview.");
    return {email: user.email, serverOrigin: options.serverOrigin, workspaceIds: [...scope.workspaceIds].sort(), workspaceCount: scope.workspaceCount,
      ownedShareCount: scope.ownedShareCount, heldGrantCount: scope.heldGrantCount, storedBytes: scope.storedBytes};
  }
  async function finish(user: {id: string; email: string}): Promise<void> {
    const result = await call("purge", user);
    if (!result || typeof result !== "object" || !("finished" in result) || result.finished !== true) throw new Error("Relay account deletion is unfinished.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query('DELETE FROM "verification" WHERE value=$1 OR lower(identifier)=lower($2)', [user.id, user.email]);
      await client.query('DELETE FROM "invitation" WHERE "inviterId"=$1 OR lower(email)=lower($2)', [user.id, user.email]);
      await client.query('DELETE FROM "deviceCode" WHERE "userId"=$1', [user.id]);
      const organizations = await client.query<{organizationId: string}>('SELECT o.id AS "organizationId" FROM "organization" o WHERE o.id IN (SELECT "organizationId" FROM "member" WHERE "userId"=$1) ORDER BY o.id FOR UPDATE', [user.id]);
      await client.query('DELETE FROM "user" WHERE id=$1', [user.id]);
      for (const row of organizations.rows) await client.query('DELETE FROM "organization" WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM "member" WHERE "organizationId"=$1)', [row.organizationId]);
      await client.query('DELETE FROM account_deletion_jobs WHERE user_id=$1', [user.id]);
      await client.query("COMMIT");
    } catch (error) {await client.query("ROLLBACK"); throw error;} finally {client.release();}
  }
  return {
    async preview(user: {id: string; email: string}): Promise<Record<string, unknown>> {
      const preview = await previewFor(user);
      return {...preview, signInMaxAgeMs: ACCOUNT_DELETION_FRESH_AGE_MS, previewToken: mintDeletionPreviewToken(previewKey, user.id, preview)};
    },
    async delete(user: {id: string; email: string}, token: string): Promise<Record<string, unknown>> {
      const changed = () => new APIError("CONFLICT", {code: "PREVIEW_CHANGED", message: "Account deletion changed or the preview expired. Review it again."});
      if (!verifiesDeletionPreviewToken(previewKey, token, user.id)) throw changed();
      const preview = await previewFor(user);
      if (!matchesDeletionPreviewToken(previewKey, token, user.id, preview)) throw changed();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const account = await client.query('SELECT email FROM "user" WHERE id=$1 FOR UPDATE', [user.id]);
        if (account.rows.length !== 1 || account.rows[0].email !== user.email) throw new APIError("UNAUTHORIZED");
        if (!verifiesDeletionPreviewToken(previewKey, token, user.id)) throw changed();
        await client.query('INSERT INTO account_deletion_jobs(user_id,email) VALUES($1,$2)', [user.id, user.email]);
        await client.query('DELETE FROM "session" WHERE "userId"=$1', [user.id]);
        await client.query('DELETE FROM "deviceCode" WHERE "userId"=$1', [user.id]);
        await client.query("COMMIT");
      } catch (error) {await client.query("ROLLBACK"); throw error;} finally {client.release();}
      try {await finish(user); return {finished: true};}
      catch {return {finished: false, pending: true};}
    },
    async resume(): Promise<void> {
      const jobs = await pool.query<{user_id: string; email: string}>('SELECT user_id,email FROM account_deletion_jobs ORDER BY created_at');
      for (const job of jobs.rows) {
        try {await finish({id: job.user_id, email: job.email});}
        catch {console.error("[workspace-api] Account deletion remains pending.");}
      }
    },
  };
}
