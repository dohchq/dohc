import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {Client, Pool} from "pg";
import {beforeAll, afterAll, afterEach, describe, expect, it, vi} from "vitest";
import {CLIENT_IP_HEADER, createWorkspaceAuth} from "@dohc/workspace-auth/betterAuth";
import {accountDeletionPreviewKey, mintDeletionPreviewToken} from "@dohc/workspace-auth/accountDeletion";
import {createAccountDeletion} from "./accountDeletion";
const connectionString=process.env.POSTGRES_URL??"postgres://dohc:dohc@localhost:54329/dohc";
const probe=new Client({connectionString,connectionTimeoutMillis:2000});
let available=false;
try {await probe.connect();available=true;} catch(error) {if(process.env.DOHC_REQUIRE_POSTGRES==="1")throw error;} finally {await probe.end();}
const secret="account-deletion-test-secret-at-least-thirty-two-bytes",baseURL="http://localhost:1786",password="account-deletion-password";
describe.skipIf(!available)("account deletion against Postgres",()=>{
  const schema="account_deletion_"+randomUUID().replaceAll("-","");
  let pool:Pool,admin:Client,fixtureNumber=0;
  beforeAll(async()=>{
    admin=new Client({connectionString});await admin.connect();await admin.query('CREATE SCHEMA "'+schema+'"');
    pool=new Pool({connectionString,options:"-c search_path="+schema});
    for(const name of ["0001_better_auth.sql","0004_account_deletion.sql"]) await pool.query(await readFile(new URL("../../../packages/workspace-postgres/src/db/migrations/"+name,import.meta.url),"utf8"));
  });
  afterEach(async()=>{await pool.query('DELETE FROM "user"');await pool.query('DELETE FROM account_deletion_jobs');await pool.query('DELETE FROM "verification"');await pool.query('DELETE FROM "deviceCode"');await pool.query('DELETE FROM "organization"');});
  afterAll(async()=>{await pool?.end();await admin?.query('DROP SCHEMA "'+schema+'" CASCADE');await admin?.end();});
  async function fixture(){
    let scope={workspaceIds:["owned-workspace"],workspaceCount:1,ownedShareCount:2,heldGrantCount:3,storedBytes:123};
    let relayAvailable=true,finished=false,purgeCalls=0,previewCalls=0;
    const deletion=createAccountDeletion({pool,secret,serverOrigin:baseURL,relayUrl:"http://relay.test",fetch:async(_url,init)=>{
      const body=JSON.parse(String(init?.body)) as {operation:string};
      if(body.operation==="preview"){previewCalls++;return Response.json(scope);}
      if(!relayAvailable)throw Error("relay unavailable");
      purgeCalls++;finished=true;return Response.json({finished:true});
    }});
    const sent:string[]=[];
    const auth=createWorkspaceAuth({pool,secret,baseURL,sendEmail:async message=>{sent.push(message.text);},accountDeletion:deletion});
    const email=randomUUID()+"@dohc.test",clientIp="192.0.2."+(++fixtureNumber);
    const account=await auth.api.signUpEmail({body:{email,password,name:"Delete me"}});
    const userId=account.user.id,token=account.token!;
    const post=(path:string,body:unknown={},credential=token)=>auth.handler(new Request(baseURL+"/api/auth"+path,{method:"POST",headers:{authorization:"Bearer "+credential,"content-type":"application/json",[CLIENT_IP_HEADER]:clientIp},body:JSON.stringify(body)}));
    const claim=(userCode:string)=>auth.handler(new Request(baseURL+"/api/auth/device?user_code="+encodeURIComponent(userCode),{headers:{authorization:"Bearer "+token,[CLIENT_IP_HEADER]:clientIp}}));
    const preview=async()=>{const response=await post("/account/deletion-preview");expect(response.status).toBe(200);return await response.json() as {previewToken:string;email:string;serverOrigin:string;workspaceIds:string[]};};
    return {deletion,auth,post,claim,preview,userId,email,token,sent,get finished(){return finished;},get purgeCalls(){return purgeCalls;},get previewCalls(){return previewCalls;},syncBytes(){scope={...scope,storedBytes:999};},changeScope(){scope={...scope,ownedShareCount:4};},disconnectRelay(){relayAvailable=false;},connectRelay(){relayAvailable=true;}};
  }
  it("previews the exact account and refuses link or app credentials",async()=>{
    const f=await fixture();expect(await f.preview()).toMatchObject({email:f.email,serverOrigin:baseURL,workspaceIds:["owned-workspace"],workspaceCount:1,ownedShareCount:2,heldGrantCount:3,storedBytes:123,passwordRequired:true});
    expect((await f.post("/account/deletion-preview",{},"LinkCapability proof")).status).toBe(401);
    expect((await f.post("/account/delete",{previewToken:"proof"},"app-proof")).status).toBe(401);
  });
  it("accepts the correct password with an old session",async()=>{
    const f=await fixture(),preview=await f.preview();
    await pool.query(`UPDATE "session" SET "createdAt"=now()-interval '16 minutes' WHERE "userId"=$1` ,[f.userId]);
    expect((await f.post("/account/delete",{...preview,password})).status).toBe(200);
    expect(f.finished).toBe(true);
    expect((await pool.query('SELECT * FROM account_deletion_jobs')).rows).toHaveLength(0);
  });
  it.each([undefined, "", null, "wrong-password"])("refuses password %j without recording deletion or revoking sessions",async suppliedPassword=>{
    const f=await fixture(),preview=await f.preview();
    const response=await f.post("/account/delete",{...preview,password:suppliedPassword});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({code:suppliedPassword==="wrong-password"?"INVALID_PASSWORD":"PASSWORD_REQUIRED"});
    expect((await pool.query('SELECT * FROM account_deletion_jobs')).rows).toHaveLength(0);
    expect((await pool.query('SELECT * FROM "session" WHERE "userId"=$1',[f.userId])).rows).toHaveLength(1);
    expect(f.purgeCalls).toBe(0);
  });
  it("requires the password for a session minted through approval by an old session",async()=>{
    const f=await fixture();
    await pool.query(`UPDATE "session" SET "createdAt"=now()-interval '1 day' WHERE "userId"=$1`,[f.userId]);
    const device=await f.auth.api.deviceCode({body:{client_id:"desktop"}});
    expect((await f.claim(device.user_code)).status).toBe(200);
    expect((await f.post("/device/approve",{userCode:device.user_code})).status).toBe(200);
    const token=await f.auth.api.deviceToken({body:{grant_type:"urn:ietf:params:oauth:grant-type:device_code",device_code:device.device_code,client_id:"desktop"}});
    const previewResponse=await f.post("/account/deletion-preview",{},token.access_token);
    expect(previewResponse.status).toBe(200);
    const preview=await previewResponse.json() as {previewToken:string};
    for(const suppliedPassword of [undefined,"wrong-password"]) expect((await f.post("/account/delete",{...preview,password:suppliedPassword},token.access_token)).status).toBe(400);
    expect((await pool.query('SELECT * FROM account_deletion_jobs')).rows).toHaveLength(0);
    expect(f.purgeCalls).toBe(0);
    expect((await f.post("/account/delete",{...preview,password},token.access_token)).status).toBe(200);
    expect(f.finished).toBe(true);
  });
  it("rate limits wrong passwords through Better Auth's sign-in attempt rule",async()=>{
    const f=await fixture(),preview=await f.preview();
    for(let attempt=0;attempt<10;attempt++) expect((await f.post("/account/delete",{...preview,password:"wrong-password"})).status).toBe(400);
    const limited=await f.post("/account/delete",{...preview,password});
    expect(limited.status).toBe(429);
    expect(limited.headers.get("x-retry-after")).toBeTruthy();
    expect((await pool.query('SELECT * FROM account_deletion_jobs')).rows).toHaveLength(0);
    expect(f.purgeCalls).toBe(0);
  });
  it("refuses changed, expired, account-mismatched and tampered previews",async()=>{
    const f=await fixture(),preview=await f.preview();f.changeScope();
    expect((await f.post("/account/delete",{...preview,password})).status).toBe(409);
    const current=await f.preview();
    for(const previewToken of [current.previewToken+"x",mintDeletionPreviewToken(accountDeletionPreviewKey(secret),"another-account",{email:f.email,serverOrigin:baseURL,workspaceIds:["owned-workspace"],workspaceCount:1,ownedShareCount:4,heldGrantCount:3,storedBytes:123}),mintDeletionPreviewToken(accountDeletionPreviewKey(secret),f.userId,{email:f.email,serverOrigin:baseURL,workspaceIds:["owned-workspace"],workspaceCount:1,ownedShareCount:4,heldGrantCount:3,storedBytes:123},Date.now()-10*60_000)]) expect((await f.post("/account/delete",{previewToken,password})).status).toBe(409);
    expect(f.purgeCalls).toBe(0);
  });
  it("fences sessions, sign-in, password reset and device approval before relay completion, then resumes",async()=>{
    const f=await fixture(),preview=await f.preview();
    await pool.query(`INSERT INTO "deviceCode" (id,"deviceCode","userCode","userId","expiresAt",status) VALUES($1,$1,$1,$2,now()+interval '10 minutes','approved')` ,["approved-device",f.userId]);
    const device=await f.post("/device/code",{client_id:"desktop"});const codes=await device.json() as {user_code:string};expect(device.status).toBe(200);
    expect((await f.claim(codes.user_code)).status).toBe(200);
    f.disconnectRelay();const response=await f.post("/account/delete",{...preview,password});
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
  it("removes organizations left with no members and keeps organizations with another member",async()=>{
    const f=await fixture(),preview=await f.preview();
    const other=await f.auth.api.signUpEmail({body:{email:"other@example.test",password,name:"Other"}});
    await pool.query('INSERT INTO "organization"(id,name,slug,"createdAt",logo,metadata) VALUES($1,$2,$1,now(),$2,$2),($3,$3,$3,now(),NULL,NULL)',["only-deleted",f.email,"shared"]);
    await pool.query(`INSERT INTO "member"(id,"organizationId","userId",role,"createdAt") VALUES('one','only-deleted',$1,'owner',now()),('two','shared',$1,'owner',now()),('three','shared',$2,'member',now())`,[f.userId,other.user.id]);
    expect((await f.post("/account/delete",{...preview,password})).status).toBe(200);
    expect((await pool.query('SELECT id FROM "organization" ORDER BY id')).rows).toEqual([{id:"shared"}]);
  });
  it("finishes synchronously when the relay acknowledges purge",async()=>{
    const f=await fixture(),preview=await f.preview();
    await f.auth.api.requestPasswordReset({body:{email:f.email}});
    f.syncBytes();
    const result=await f.post("/account/delete",{...preview,password});
    expect(result.status).toBe(200);expect(await result.json()).toEqual({finished:true});
    expect((await pool.query('SELECT * FROM "user" WHERE id=$1',[f.userId])).rows).toEqual([]);
    expect((await pool.query('SELECT * FROM "verification" WHERE value=$1',[f.userId])).rows).toEqual([]);
    const closed=createWorkspaceAuth({pool,secret,baseURL,sendEmail:async()=>{},admitAccount:async email=>email===f.email?"admitted":"refused"});
    await expect(closed.api.signUpEmail({body:{email:"unapproved@example.test",password,name:"Unapproved"}})).rejects.toMatchObject({statusCode:403,body:{code:"SIGN_UP_CLOSED"}});
  });
});

it("rejects invalid tokens before taking a connection or calling the relay",async()=>{
  const connect=vi.fn(async()=>{throw Error("must not connect");}),relay=vi.fn(),confirmPassword=vi.fn();
  const deletion=createAccountDeletion({pool:{connect} as unknown as Pool,secret,serverOrigin:baseURL,relayUrl:"http://relay.test",fetch:relay});
  const scope={email:"person@example.test",serverOrigin:baseURL,workspaceIds:[],workspaceCount:0,ownedShareCount:0,heldGrantCount:0,storedBytes:0};
  const key=accountDeletionPreviewKey(secret);
  for(const token of ["invalid",mintDeletionPreviewToken(key,"other",scope),mintDeletionPreviewToken(key,"person",scope,Date.now()-600_000)]) {
    await expect(deletion.delete({id:"person",email:scope.email},token,confirmPassword)).rejects.toMatchObject({statusCode:409});
  }
  expect(connect).not.toHaveBeenCalled();expect(relay).not.toHaveBeenCalled();expect(confirmPassword).not.toHaveBeenCalled();
});
it("calls the relay preview without holding an account lock",async()=>{
  let locked=false;
  const client={async query(sql:string){if(sql.includes("FOR UPDATE")){locked=true;return {rows:[{email:"person@example.test"}]};}if(sql==="COMMIT"||sql==="ROLLBACK")locked=false;return {rows:[]};},release(){}};
  const pool={connect:async()=>client} as unknown as Pool;
  const scope={email:"person@example.test",serverOrigin:baseURL,workspaceIds:[],workspaceCount:0,ownedShareCount:0,heldGrantCount:0,storedBytes:0};
  const deletion=createAccountDeletion({pool,secret,serverOrigin:baseURL,relayUrl:"http://relay.test",fetch:async(_url,init)=>{
    expect(locked).toBe(false);const body=JSON.parse(String(init?.body)) as {operation:string};
    return Response.json(body.operation==="preview"?scope:{finished:true});
  }});
  expect(await deletion.delete({id:"person",email:scope.email},mintDeletionPreviewToken(accountDeletionPreviewKey(secret),"person",scope),async()=>{expect(locked).toBe(false);})).toEqual({finished:true});
});

it("confirms the password after checking the preview and before recording deletion",async()=>{
  const connect=vi.fn(),confirmPassword=vi.fn(async()=>{throw Error("wrong password");});
  const scope={email:"person@example.test",serverOrigin:baseURL,workspaceIds:[],workspaceCount:0,ownedShareCount:0,heldGrantCount:0,storedBytes:0};
  const relay=vi.fn(async()=>Response.json(scope));
  const deletion=createAccountDeletion({pool:{connect} as unknown as Pool,secret,serverOrigin:baseURL,relayUrl:"http://relay.test",fetch:relay});
  const token=mintDeletionPreviewToken(accountDeletionPreviewKey(secret),"person",scope);
  await expect(deletion.delete({id:"person",email:scope.email},token,confirmPassword)).rejects.toThrow("wrong password");
  expect(relay).toHaveBeenCalledOnce();expect(confirmPassword).toHaveBeenCalledOnce();expect(connect).not.toHaveBeenCalled();
  confirmPassword.mockClear();
  relay.mockResolvedValueOnce(Response.json({...scope,heldGrantCount:1}));
  await expect(deletion.delete({id:"person",email:scope.email},token,confirmPassword)).rejects.toMatchObject({statusCode:409});
  expect(confirmPassword).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();
});
