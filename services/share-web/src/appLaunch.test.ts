import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createAppLaunchHandler } from "./appLaunch";
import { parseAppLaunchConfig } from "./appLaunchConfig";
const config={viewerOrigin:'https://viewer.example.com',appDomain:'example.net'},publicationId='a'.repeat(64);
function fixture(hold:()=>Promise<void>=async()=>{}){let now=1000000,revision=1,active=true;const requests:Request[]=[];const bytes=Buffer.from("document.getElementById('root').textContent='App loaded';");const file={path:'bundle.js',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,contentType:'text/javascript; charset=utf-8'};
const handler=createAppLaunchHandler({config,relayUrl:'https://relay.example.org',nowMs:()=>now,resolveMaterial:async(_d,c)=>c==='viewer=session'?{ok:true,capabilityToken:'server-capability',profileSecret:'server-profile',setCookie:null}:{ok:false,status:404},fetchRelay:async r=>{requests.push(r);await hold();expect(r.headers.get('authorization')).toBe('LinkCapability server-capability');expect(r.headers.get('x-dohc-link-profile-secret')).toBe('server-profile');if(!active)return new Response(null,{status:404});const u=new URL(r.url);if(u.pathname.endsWith('/blobs/'+file.sha256))return u.search===`?authorityRevision=${revision}`?new Response(bytes,{headers:{'content-type':file.contentType}}):new Response(null,{status:404});return Response.json({publicationId,authorityRevision:revision,files:[file]});}});
const request=(url:string,body:string,headers:Record<string,string>={})=>new Request(url,{method:'POST',body,headers:{host:new URL(url).host,...headers}});
const issue=()=>handler.handle(request(config.viewerOrigin+'/api/apps/launch',JSON.stringify({discriminator:'abcdefghijkl',publicationId}),{origin:config.viewerOrigin,'content-type':'application/json',cookie:'viewer=session'}));
const redeem=(launch:{action:string;handoff:string})=>handler.handle(request(launch.action,new URLSearchParams({handoff:launch.handoff}).toString(),{origin:config.viewerOrigin,'content-type':'application/x-www-form-urlencoded'}));
return{handler,requests,request,issue,redeem,revoke(){active=false;},narrow(){revision++;},advance(ms:number){now+=ms;}};}
async function launch(f:ReturnType<typeof fixture>){const issued=await f.issue();expect(issued.status).toBe(200);const handoff=await issued.json();const response=await f.redeem(handoff);expect(response.status).toBe(200);const html=await response.text(),proof=/const proof="([A-Za-z0-9_-]{43})"/.exec(html)![1]!,cookie=response.headers.get('set-cookie')!.split(';')[0]!,origin=new URL(handoff.action).origin;const read=(path='/document',custom:Record<string,string>={})=>f.handler.handle(f.request(origin+path,'',{origin,cookie,'x-dohc-app-proof':proof,...custom}));return{handoff,response,html,proof,cookie,origin,read};}
it('requires separate registrable domains including private PSL suffixes',()=>{expect(parseAppLaunchConfig(config)).toEqual(config);for(const appDomain of ['com','example.com','apps.example.com','localhost','127.0.0.1','github.io','EXAMPLE.NET'])expect(()=>parseAppLaunchConfig({...config,appDomain})).toThrow();expect(()=>parseAppLaunchConfig({viewerOrigin:'https://a.github.io',appDomain:'b.github.io'})).not.toThrow();});
it('requires viewer cookies and exact origin',async()=>{const f=fixture();for(const custom of [{origin:'null',cookie:'viewer=session'},{origin:config.viewerOrigin,cookie:'bad'}] as Array<Record<string,string>>)expect((await f.handler.handle(f.request(config.viewerOrigin+'/api/apps/launch',JSON.stringify({discriminator:'abcdefghijkl',publicationId}),{...custom,'content-type':'application/json'}))).status).toBe(404);expect(f.requests).toHaveLength(0);});
it('rechecks relay and keeps credentials out of opaque document',async()=>{const f=fixture(),app=await launch(f);expect(app.response.headers.get('set-cookie')).toContain('Secure; HttpOnly; SameSite=Strict; Path=/');expect(app.html).toContain("frame.sandbox='allow-scripts allow-forms'");expect(app.html).not.toContain('server-capability');expect(app.html).not.toContain('server-profile');const doc=await app.read();expect(doc.status).toBe(200);const text=await doc.text();expect(text).toContain('App loaded');expect(text).not.toContain(app.proof);expect(text).not.toContain(app.cookie);expect(f.requests).toHaveLength(4);});
it('atomically consumes concurrent handoffs once',async()=>{const f=fixture(),handoff=await(await f.issue()).json();expect((await Promise.all([f.redeem(handoff),f.redeem(handoff)])).map(r=>r.status).sort()).toEqual([200,404]);});
it('accepts a valid one-use handoff from the viewer no-referrer form origin',async()=>{
  const f=fixture(),handoff=await(await f.issue()).json();
  const redeem=()=>f.handler.handle(f.request(handoff.action,new URLSearchParams({handoff:handoff.handoff}).toString(),{origin:'null','content-type':'application/x-www-form-urlencoded'}));
  expect((await redeem()).status).toBe(200);expect((await redeem()).status).toBe(404);
});
it('refuses hostile null-origin handoffs, unrelated origins, and missing Origin',async()=>{
  const f=fixture(),handoff=await(await f.issue()).json();
  const redeem=(body:string,headers:Record<string,string>={origin:'null'},action=handoff.action)=>f.handler.handle(f.request(action,body,{'content-type':'application/x-www-form-urlencoded',...headers}));
  const body=new URLSearchParams({handoff:handoff.handoff}).toString();
  for(const bad of ['',new URLSearchParams({handoff:'Z'.repeat(43)}).toString(),body+'&extra=yes'])expect((await redeem(bad)).status).toBe(404);
  for(const headers of [{origin:'https://unrelated.example.org'},{}] as Array<Record<string,string>>)expect((await redeem(body,headers)).status).toBe(404);
  const other=await(await f.issue()).json();expect((await redeem(body,{origin:'null'},other.action)).status).toBe(404);
  expect((await redeem(body)).status).toBe(200);
  const expired=await(await f.issue()).json();f.advance(30000);
  expect((await redeem(new URLSearchParams({handoff:expired.handoff}).toString(),{origin:'null'},expired.action)).status).toBe(404);
});
it('rechecks revoked and narrowed authority at redemption',async()=>{for(const change of ['revoke','narrow']as const){const f=fixture(),handoff=await(await f.issue()).json();f[change]();expect((await f.redeem(handoff)).status).toBe(404);}});
it('rechecks revocation on document and status requests',async()=>{const f=fixture(),app=await launch(f);f.revoke();expect((await app.read()).status).toBe(404);expect((await app.read('/status')).status).toBe(404);});
it('requires proof cookie host and exact non-null origin',async()=>{const f=fixture(),app=await launch(f);for(const custom of [{origin:'null'},{'x-dohc-app-proof':''},{cookie:app.cookie+'; '+app.cookie},{origin:config.viewerOrigin},{host:'wrong.example.net'}] as Array<Record<string,string>>)expect((await app.read('/document',custom)).status).toBe(404);});
it('refuses cross-launch credentials',async()=>{const f=fixture(),first=await launch(f),second=await launch(f);expect(first.origin).not.toBe(second.origin);expect((await second.read('/document',{cookie:first.cookie,'x-dohc-app-proof':first.proof})).status).toBe(404);});
it('expires handoffs and sessions',async()=>{const f=fixture(),handoff=await(await f.issue()).json();f.advance(30000);expect((await f.redeem(handoff)).status).toBe(404);const app=await launch(f);f.advance(600000);expect((await app.read()).status).toBe(404);});

it('serves staged bytes once with fresh authority and one blob charge', async () => {
  const f = fixture(), app = await launch(f);
  expect((await app.read()).status).toBe(200);
  expect((await app.read()).status).toBe(404);
  expect(f.requests.filter(request => new URL(request.url).pathname.includes('/blobs/'))).toHaveLength(1);
});
it('evicts oldest ready stage instead of letting idle clients monopolize capacity', async () => {
  const f = fixture(), first = await launch(f), second = await launch(f);
  const handoff = await (await f.issue()).json();
  expect((await f.redeem(handoff)).status).toBe(200);
  expect((await first.read()).status).toBe(404);
  expect((await second.read()).status).toBe(200);
});
it('does not let full build admission reject a valid status check', async () => {
  let hold = async () => {};
  const f = fixture(() => hold()), app = await launch(f);
  let release!: () => void, admitted!: () => void, count = 0;
  const barrier = new Promise<void>(resolve => {release = resolve;});
  const allAdmitted = new Promise<void>(resolve => {admitted = resolve;});
  hold = async () => {if (++count === 5) admitted();await barrier;};
  const issues = Array.from({length: 4}, () => f.issue()), status = app.read('/status');
  await allAdmitted;release();
  expect((await status).status).toBe(204);await Promise.all(issues);
});
it('keeps transport failures distinct from revoked authority', async () => {
  let fail = false;
  const f = fixture(async () => {if (fail) throw Error('Relay unavailable');}), app = await launch(f);
  fail = true;expect((await app.read('/status')).status).toBe(503);
  fail = false;expect((await app.read('/status')).status).toBe(204);
  f.revoke();expect((await app.read('/status')).status).toBe(404);
});

it('retains staged bytes through transient authorization checks but only delivers once', async () => {
  let fail = false;
  const f = fixture(async () => {if (fail) throw Error('Temporary relay failure');}), app = await launch(f);
  fail = true;expect((await app.read()).status).toBe(503);
  fail = false;expect((await app.read()).status).toBe(200);
  expect((await app.read()).status).toBe(404);
  expect(f.requests.filter(request => new URL(request.url).pathname.includes('/blobs/'))).toHaveLength(1);
});
it('preserves staged bytes after invalid proof and expires abandoned stages', async () => {
  const f = fixture(), app = await launch(f);
  expect((await app.read('/document', {'x-dohc-app-proof': 'Z'.repeat(43)})).status).toBe(404);
  expect((await app.read()).status).toBe(200);
  const expired = await launch(f);f.advance(30000);
  expect((await expired.read()).status).toBe(404);
});
it('keeps collection rate exhaustion independent from document and status',async()=>{
  const f=fixture(),app=await launch(f);
  const request=()=>f.handler.handle(f.request(app.origin+'/collection',JSON.stringify({id:'list',op:'collection.list',limit:1}),{origin:app.origin,cookie:app.cookie,'x-dohc-app-proof':app.proof,'content-type':'application/json'}));
  const before=f.requests.length;for(let i=0;i<13;i++)await request();expect(f.requests.length-before).toBe(12);
  expect((await app.read('/status')).status).toBe(204);expect((await app.read()).status).toBe(200);
});
it('keeps full collection admission independent from document builds and status',async()=>{
  let hold=async()=>{};
  const f=fixture(()=>hold()),apps=[await launch(f),await launch(f)];
  let release!:()=>void,admitted!:()=>void,count=0;const barrier=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{admitted=resolve;});
  hold=async()=>{if(++count===16)admitted();await barrier;};
  const request=(app:typeof apps[number])=>f.handler.handle(f.request(app.origin+'/collection',JSON.stringify({id:'list',op:'collection.list',limit:1}),{origin:app.origin,cookie:app.cookie,'x-dohc-app-proof':app.proof,'content-type':'application/json'}));
  const calls=Array.from({length:16},(_,i)=>request(apps[i%2]!));await ready;
  expect((await request(apps[0]!)).status).toBe(503);
  hold=async()=>{};expect((await apps[1]!.read()).status).toBe(200);expect((await apps[0]!.read('/status')).status).toBe(204);
  const issued=await f.issue();expect(issued.status).toBe(200);expect((await f.redeem(await issued.json())).status).toBe(200);
  release();await Promise.all(calls);
});
