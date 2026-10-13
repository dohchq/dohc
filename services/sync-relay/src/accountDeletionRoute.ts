import {Client, type Pool} from "pg";
import { ACCOUNT_DELETION_ADMISSION_LOCK, ACCOUNT_DELETION_KEY_HEADER, accountDeletionIdentity } from "@dohc/workspace-auth/accountDeletion";
import { presentsSignUpInviteKey } from "@dohc/workspace-auth/signUp";
import { guardRelayResponses } from "./relayResponseStanding";
import { initializeAccountDeletion, fenceAccount, deletionScope, purgeAccountRows, completeDeletionPhase, type DeletionManifest } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";

export function createAccountDeletionRoute(options: {
  storage: StorageContext; key: string;
  invalidate(userId: string, manifest: DeletionManifest): void;
  deleteRuntime(userId: string, manifest: DeletionManifest): Promise<void>;
  afterPhase?(phase: "fenced" | "runtime" | "sql"): void;
}) {
  const {storage, key} = options;
  initializeAccountDeletion(storage, key);
  const running = new Map<string, Promise<void>>();
  const activated = new Set<string>();
  let generation = 0;
  function fence(userId: string, email: string) {
    const job = fenceAccount(storage, key, userId, email);
    const hash = accountDeletionIdentity(key,userId);
    if (job.manifest && !activated.has(hash)) {
      activated.add(hash); generation++; options.invalidate(userId, job.manifest);
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
        completeDeletionPhase(storage,key,userId,"runtime");
        options.afterPhase?.("runtime");
      }
      if (job.phase !== "sql") {
        purgeAccountRows(storage,userId,email,manifest);
        completeDeletionPhase(storage,key,userId,"sql");
        options.afterPhase?.("sql");
      }
      completeDeletionPhase(storage,key,userId,"finished");
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
  return {handle, fence, purge, generation: () => generation};
}

export async function admitAccountDeletionWork<T>(pool: Pool, deletions: Pick<ReturnType<typeof createAccountDeletionRoute>, "fence">, run: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock_shared($1)", [ACCOUNT_DELETION_ADMISSION_LOCK]);
    const jobs = await client.query<{user_id: string; email: string}>("SELECT user_id,email FROM account_deletion_jobs");
    for (const job of jobs.rows) deletions.fence(job.user_id,job.email);
    const result = await run();
    await client.query("COMMIT");
    return result;
  } catch (error) {await client.query("ROLLBACK"); throw error;} finally {client.release();}
}
export function accountDeletionAdmission(pool: Pool, deletions: Pick<ReturnType<typeof createAccountDeletionRoute>, "fence" | "generation">, handler: (request: Request) => Promise<Response>) {
  const refusal = () => Response.json({ok:false,error:"unavailable"},{status:503,headers:{"cache-control":"no-store"}});
  return async (request: Request): Promise<Response> => {
    const generation = await admitAccountDeletionWork(pool,deletions,async () => deletions.generation());
    const response = request.method === "GET" || request.method === "HEAD" ? await handler(request) : await admitAccountDeletionWork(pool,deletions,() => handler(request));
    return admitAccountDeletionWork(pool,deletions,async () => {
      if (generation !== deletions.generation()) {await response.body?.cancel(); return refusal();}
      if (!response.body) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            await admitAccountDeletionWork(pool,deletions,async () => {
              if (generation !== deletions.generation()) throw new Error("Account access changed.");
              if (chunk.done) controller.close(); else controller.enqueue(chunk.value);
            });
          } catch (error) {await reader.cancel().catch(() => undefined); controller.error(error);}
        },
        cancel(reason) {return reader.cancel(reason);},
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    });
  };
}

export async function watchAccountDeletionJobs(options: {
  connectionString: string;
  deletions: Pick<ReturnType<typeof createAccountDeletionRoute>, "fence">;
  unavailable(): void;
}) {
  const client = new Client({connectionString:options.connectionString,connectionTimeoutMillis:3000,query_timeout:5000});
  let closed = false;
  const fail = () => {if (!closed) options.unavailable();};
  client.on("error",fail); client.on("end",fail);
  try {
    await client.connect();
    const schema = String((await client.query("SELECT current_schema() AS schema")).rows[0].schema);
    client.on("notification",message => {
      try {
        const job: unknown = JSON.parse(message.payload ?? "null");
        if (!job || typeof job !== "object" || !("schema" in job) || job.schema !== schema) return;
        if (!("userId" in job) || typeof job.userId !== "string" || !("email" in job) || typeof job.email !== "string") throw new Error("Invalid deletion fence.");
        options.deletions.fence(job.userId,job.email);
      } catch {fail();}
    });
    await client.query("LISTEN dohc_account_deletion");
    const jobs = await client.query<{user_id:string;email:string}>("SELECT user_id,email FROM account_deletion_jobs");
    for (const job of jobs.rows) options.deletions.fence(job.user_id,job.email);
    return {async close() {closed=true;await client.end();}};
  } catch (error) {closed=true;await client.end();throw error;}
}
