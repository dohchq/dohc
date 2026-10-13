import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {Client, Pool} from "pg";
import {beforeAll, afterAll, afterEach, describe, expect, it} from "vitest";
import {createWorkspaceAuth} from "@dohc/workspace-auth/betterAuth";
import {accountDeletionKey, mintDeletionPreviewToken} from "@dohc/workspace-auth/accountDeletion";
import {createAccountDeletion} from "./accountDeletion";
const connectionString=process.env.POSTGRES_URL??"postgres://dohc:dohc@localhost:54329/dohc";
const probe=new Client({connectionString,connectionTimeoutMillis:2000});
let available=false;
try {await probe.connect();available=true;} catch(error) {if(process.env.DOHC_REQUIRE_POSTGRES==="1")throw error;} finally {await probe.end();}
const secret="account-deletion-test-secret-at-least-thirty-two-bytes",baseURL="http://localhost:1786",password="account-deletion-password";
describe.skipIf(!available)("account deletion against Postgres",()=>{
  const schema="account_deletion_"+randomUUID().replaceAll("-","");
  let pool:Pool,admin:Client;
  beforeAll(async()=>{
    admin=new Client({connectionString});await admin.connect();await admin.query('CREATE SCHEMA "'+schema+'"');
    pool=new Pool({connectionString,options:"-c search_path="+schema});
    for(const name of ["0001_better_auth.sql","0004_account_deletion.sql"]) await pool.query(await readFile(new URL("../../../packages/workspace-postgres/src/db/migrations/"+name,import.meta.url),"utf8"));
  });
  afterEach(async()=>{await pool.query('DELETE FROM "user"');await pool.query('DELETE FROM account_deletion_jobs');await pool.query('DELETE FROM "verification"');await pool.query('DELETE FROM "deviceCode"');});
  afterAll(async()=>{await pool?.end();await admin?.query('DROP SCHEMA "'+schema+'" CASCADE');await admin?.end();});
  async function fixture(){
    let scope={workspaceIds:["owned-workspace"],workspaceCount:1,ownedShareCount:2,heldGrantCount:3,storedBytes:123};
    let relayAvailable=true,finished=false,purgeCalls=0;
    const deletion=createAccountDeletion({pool,secret,serverOrigin:baseURL,relayUrl:"http://relay.test",fetch:async(_url,init)=>{
      const body=JSON.parse(String(init?.body)) as {operation:string};
      if(body.operation==="preview")return Response.json(scope);
      if(!relayAvailable)throw Error("relay unavailable");
      purgeCalls++;finished=true;return Response.json({finished:true});
    }});
    const sent:string[]=[];
    const auth=createWorkspaceAuth({pool,secret,baseURL,sendEmail:async message=>{sent.push(message.text);},accountDeletion:deletion});
    const email=randomUUID()+"@dohc.test";
    const account=await auth.api.signUpEmail({body:{email,password,name:"Delete me"}});
    const userId=account.user.id,token=account.token!;
    const post=(path:string,body:unknown={},credential=token)=>auth.handler(new Request(baseURL+"/api/auth"+path,{method:"POST",headers:{authorization:"Bearer "+credential,"content-type":"application/json"},body:JSON.stringify(body)}));
    const preview=async()=>{const response=await post("/account/deletion-preview");expect(response.status).toBe(200);return await response.json() as {previewToken:string;email:string;serverOrigin:string;workspaceIds:string[]};};
    return {deletion,auth,post,preview,userId,email,token,sent,get finished(){return finished;},get purgeCalls(){return purgeCalls;},changeScope(){scope={...scope,ownedShareCount:4};},disconnectRelay(){relayAvailable=false;},connectRelay(){relayAvailable=true;}};
  }
  it("previews the exact account and refuses link or app credentials",async()=>{
    const f=await fixture();expect(await f.preview()).toMatchObject({email:f.email,serverOrigin:baseURL,workspaceIds:["owned-workspace"],workspaceCount:1,ownedShareCount:2,heldGrantCount:3,storedBytes:123});
    expect((await f.post("/account/deletion-preview",{},"LinkCapability proof")).status).toBe(401);
    expect((await f.post("/account/delete",{previewToken:"proof"},"app-proof")).status).toBe(401);
  });
  it("requires Better Auth's fresh session",async()=>{
    const f=await fixture(),preview=await f.preview();
    await pool.query(`UPDATE "session" SET "createdAt"=now()-interval '2 days' WHERE "userId"=$1` ,[f.userId]);
    expect((await f.post("/account/delete",preview)).status).toBe(403);
    expect((await pool.query('SELECT * FROM account_deletion_jobs')).rows).toHaveLength(0);
  });
  it("refuses changed, expired, account-mismatched and tampered previews",async()=>{
    const f=await fixture(),preview=await f.preview();f.changeScope();
    expect((await f.post("/account/delete",preview)).status).toBe(409);
    const current=await f.preview();
    for(const previewToken of [current.previewToken+"x",mintDeletionPreviewToken(accountDeletionKey(secret),"another-account",{email:f.email,serverOrigin:baseURL,workspaceIds:["owned-workspace"],workspaceCount:1,ownedShareCount:4,heldGrantCount:3,storedBytes:123}),mintDeletionPreviewToken(accountDeletionKey(secret),f.userId,{email:f.email,serverOrigin:baseURL,workspaceIds:["owned-workspace"],workspaceCount:1,ownedShareCount:4,heldGrantCount:3,storedBytes:123},Date.now()-10*60_000)]) expect((await f.post("/account/delete",{previewToken})).status).toBe(409);
    expect(f.purgeCalls).toBe(0);
  });
  it("fences sessions, sign-in, password reset and device approval before relay completion, then resumes",async()=>{
    const f=await fixture(),preview=await f.preview();
    await pool.query(`INSERT INTO "deviceCode" (id,"deviceCode","userCode","userId","expiresAt",status) VALUES($1,$1,$1,$2,now()+interval '10 minutes','approved')` ,["approved-device",f.userId]);
    const device=await f.post("/device/code",{client_id:"desktop"});const codes=await device.json() as {user_code:string};expect(device.status).toBe(200);
    f.disconnectRelay();const response=await f.post("/account/delete",preview);
    expect(response.status).toBe(200);expect(await response.json()).toEqual({finished:false,pending:true});
    expect((await pool.query('SELECT * FROM "user" WHERE id=$1',[f.userId])).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM "session" WHERE "userId"=$1',[f.userId])).rows).toHaveLength(0);
    expect((await pool.query('SELECT * FROM "deviceCode" WHERE "userId"=$1',[f.userId])).rows).toHaveLength(0);
    expect((await f.post("/sign-in/email",{email:f.email,password},"invalid")).status).toBeGreaterThanOrEqual(400);
    const session=await f.auth.handler(new Request(baseURL+"/api/auth/get-session",{headers:{authorization:"Bearer "+f.token}}));expect(await session.json()).toBeNull();
    const messages=f.sent.length;await f.post("/request-password-reset",{email:f.email});expect(f.sent).toHaveLength(messages);
    expect((await f.post("/device/approve",{userCode:codes.user_code})).status).toBeGreaterThanOrEqual(400);
    await expect(pool.query(`INSERT INTO "session" (id,token,"expiresAt","createdAt","updatedAt","userId") VALUES('raced-session','raced-token',now()+interval '1 day',now(),now(),$1)` ,[f.userId])).rejects.toMatchObject({code:"42501"});
    f.connectRelay();await f.deletion.resume();expect(f.finished).toBe(true);
    for(const table of ["user","session","account","verification","invitation","deviceCode","account_deletion_jobs"]) {
      const rows=(await pool.query('SELECT * FROM "'+table+'"')).rows;
      expect(JSON.stringify(rows)).not.toContain(f.userId);expect(JSON.stringify(rows)).not.toContain(f.email);
    }
  });
  it("finishes synchronously when the relay acknowledges purge",async()=>{
    const f=await fixture(),preview=await f.preview();
    await f.auth.api.requestPasswordReset({body:{email:f.email}});
    const result=await f.post("/account/delete",preview);
    expect(result.status).toBe(200);expect(await result.json()).toEqual({finished:true});
    expect((await pool.query('SELECT * FROM "user" WHERE id=$1',[f.userId])).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM "verification" WHERE value=$1',[f.userId])).rows).toEqual([]);
    const closed=createWorkspaceAuth({pool,secret,baseURL,sendEmail:async()=>{},admitAccount:async email=>email===f.email?"admitted":"refused"});
    await expect(closed.api.signUpEmail({body:{email:"unapproved@example.test",password,name:"Unapproved"}})).rejects.toMatchObject({statusCode:403,body:{code:"SIGN_UP_CLOSED"}});
  });
});
