import type { Pool } from "pg";
import { ACCOUNT_DELETION_KEY_HEADER, accountDeletionIdentity } from "@dohc/workspace-auth/accountDeletion";
import { presentsSignUpInviteKey } from "@dohc/workspace-auth/signUp";
import { guardRelayResponses } from "./relayResponseStanding";
import { initializeAccountDeletion, fenceAccount, deletionScope, purgeAccountRows, completeDeletionPhase, type DeletionManifest } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";

export function createAccountDeletionRoute(options: {
  storage: StorageContext; key: string; fenceKey: string;
  invalidate(userId: string, manifest: DeletionManifest): void;
  deleteRuntime(userId: string, manifest: DeletionManifest): Promise<void>;
  afterPhase?(phase: "fenced" | "runtime" | "sql"): void;
}) {
  const {storage, key, fenceKey} = options;
  initializeAccountDeletion(storage, fenceKey);
  const running = new Map<string, Promise<void>>();
  const activated = new Set<string>();
  function fence(userId: string, email: string) {
    const job = fenceAccount(storage, fenceKey, userId, email);
    const hash = accountDeletionIdentity(fenceKey,userId);
    if (job.manifest && !activated.has(hash)) {
      activated.add(hash); options.invalidate(userId, job.manifest);
    }
    return job;
  }
  async function purge(userId: string, email: string) {
    const identity = accountDeletionIdentity(key, userId), pending = running.get(identity);
    if (pending) return pending;
    const work = (async () => {
      const job = fence(userId, email);
      if (job.phase === "finished") return;
      const manifest = job.manifest!;
      options.afterPhase?.("fenced");
      if (job.phase === "fenced") {
        await options.deleteRuntime(userId, manifest);
        completeDeletionPhase(storage,fenceKey,userId,"runtime");
        options.afterPhase?.("runtime");
      }
      if (job.phase !== "sql") {
        purgeAccountRows(storage,userId,email,manifest);
        completeDeletionPhase(storage,fenceKey,userId,"sql");
        options.afterPhase?.("sql");
      }
      completeDeletionPhase(storage,fenceKey,userId,"finished");
    })();
    running.set(identity,work);
    try {await work;} finally {running.delete(identity);}
  }
  const handle = guardRelayResponses(storage, async request => {
    if (request.method !== "POST" || !presentsSignUpInviteKey(request.headers.get(ACCOUNT_DELETION_KEY_HEADER),key)) return Response.json({error: "not found"},{status:404});
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || !("userId" in body) || !("email" in body) || !("operation" in body) ||
        typeof body.userId !== "string" || !body.userId || body.userId.length > 1024 || typeof body.email !== "string" || body.email.length > 320) return Response.json({error:"invalid request"},{status:400});
    if (body.operation === "preview") return Response.json(deletionScope(storage,body.userId,body.email),{headers:{"cache-control":"no-store"}});
    if (body.operation !== "purge") return Response.json({error:"invalid operation"},{status:400});
    try {await purge(body.userId,body.email); return Response.json({finished:true},{headers:{"cache-control":"no-store"}});}
    catch {return Response.json({finished:false},{status:503,headers:{"cache-control":"no-store"}});}
  });
  return {handle, fence, purge};
}

export async function fencePendingAccountDeletions(pool: Pool, deletions: Pick<ReturnType<typeof createAccountDeletionRoute>, "fence">) {
  const jobs = await pool.query<{user_id: string; email: string}>("SELECT user_id,email FROM account_deletion_jobs");
  for (const job of jobs.rows) deletions.fence(job.user_id, job.email);
  return jobs.rows;
}
