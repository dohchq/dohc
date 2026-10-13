import {Client, Pool} from "pg";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {afterEach, expect, it} from "vitest";
import {accountDeletionAdmission, createAccountDeletionRoute, watchAccountDeletionJobs} from "./accountDeletionRoute";
import {closeTestStorages, testStorage} from "./testing";
import type {StorageContext} from "./storage/context";
import {accountIsFenced} from "./storage/accountDeletion";
afterEach(closeTestStorages);
function deferred() {let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
it("releases admission connections while a read is parked, then suppresses a fenced response",async()=>{
  let transactions=0;
  const jobs:{user_id:string;email:string}[]=[];
  const pool={async connect(){return {async query(sql:string){if(sql==="BEGIN")transactions++;if(sql==="COMMIT"||sql==="ROLLBACK")transactions--;return {rows:sql.startsWith("SELECT user_id")?jobs:[]};},release(){}};}} as unknown as Pool;
  const storage=await testStorage() as StorageContext;
  const deletion=createAccountDeletionRoute({storage,key:"admission-test",invalidate(){},deleteRuntime:async()=>{}});
  const entered=deferred(),release=deferred();
  const handler=accountDeletionAdmission(pool,deletion,async()=>{entered.resolve();await release.promise;return Response.json({private:true});});
  const pending=handler(new Request("http://relay.test/read"));await entered.promise;
  expect(transactions).toBe(0);
  jobs.push({user_id:"deleted",email:"deleted@example.test"});release.resolve();
  const result=await pending;expect(result.status).toBe(503);expect(await result.json()).not.toHaveProperty("private");
  expect(accountIsFenced(storage,"deleted")).toBe(true);expect(transactions).toBe(0);
});
const connectionString=process.env.POSTGRES_URL??"postgres://dohc:dohc@localhost:54329/dohc";
const probe=new Client({connectionString,connectionTimeoutMillis:2000});let available=false;
try {await probe.connect();available=true;}catch(error){if(process.env.DOHC_REQUIRE_POSTGRES==="1")throw error;}finally{await probe.end();}
it.skipIf(!available)("fences relay background work from the committed Postgres job, without an API hop",async()=>{
  const admin=new Client({connectionString});await admin.connect();const schema="relay_deletion_"+randomUUID().replaceAll("-","");
  let watcher: Awaited<ReturnType<typeof watchAccountDeletionJobs>> | undefined;
  let client:Client|undefined;
  try {
    await admin.query('CREATE SCHEMA "'+schema+'"');client=new Client({connectionString,options:"-c search_path="+schema});await client.connect();
    for(const name of ["0001_better_auth.sql","0004_account_deletion.sql"])await client.query(await readFile(new URL("../../../packages/workspace-postgres/src/db/migrations/"+name,import.meta.url),"utf8"));
    const storage=await testStorage() as StorageContext,notified=deferred();
    storage.claimWorkspace({workspaceId:"owned",ownerUserId:"deleted",createdAtMs:1});
    const deletion=createAccountDeletionRoute({storage,key:"admission-test",invalidate(){notified.resolve();},deleteRuntime:async()=>{}});
    watcher=await watchAccountDeletionJobs({connectionString:connectionString+(connectionString.includes("?")?"&":"?")+"options="+encodeURIComponent("-c search_path="+schema),deletions:deletion,unavailable(){storage.invalidate();}});
    await client.query("BEGIN");await client.query("INSERT INTO account_deletion_jobs(user_id,email) VALUES('deleted','deleted@example.test')");
    expect(storage.workspaceIsOwnedBy("owned","deleted")).toBe(true);await client.query("COMMIT");await notified.promise;
    expect(storage.workspaceIsOwnedBy("owned","deleted")).toBe(false);
  }finally{await watcher?.close();await client?.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();}
});
