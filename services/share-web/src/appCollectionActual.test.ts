import {it,expect} from 'vitest';
import {actualAppLaunchFixture} from '../e2e/actualAppLaunchFixture';

it('uses actual approved collection authority for list, idempotent create, and withdrawal',async()=>{
  const f=actualAppLaunchFixture(Buffer.from("document.body.textContent='ok'"),true);
  try{
    const viewer='https://viewer.example.com';
    const post=(url:string,body:unknown,headers:Record<string,string>={})=>f.application.handle(new Request(url,{method:'POST',headers:{host:new URL(url).host,origin:new URL(url).origin,'content-type':'application/json',...headers},body:JSON.stringify(body)}));
    const exchanged=await post(viewer+'/api/exchange',{secret:f.secret});expect(exchanged.status).toBe(200);
    const {session}=await exchanged.json(),viewerCookie=exchanged.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    const issued=await post(viewer+'/api/apps/launch',{discriminator:session,publicationId:f.publicationId},{cookie:viewerCookie});expect(issued.status).toBe(200);
    const {action,handoff}=await issued.json();
    const bootstrap=await f.application.handle(new Request(action,{method:'POST',headers:{host:new URL(action).host,origin:viewer,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handoff}).toString()}));expect(bootstrap.status).toBe(200);
    const proof=/const proof="([A-Za-z0-9_-]{43})"/.exec(await bootstrap.text())![1]!,cookie=bootstrap.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),origin=new URL(action).origin;
    const call=(body:unknown,headers:Record<string,string>={})=>post(origin+'/collection',body,{cookie,'x-dohc-app-proof':proof,...headers});
    const list={id:'list',op:'collection.list',limit:10};
    expect(await(await call(list)).json()).toEqual({records:[],nextPath:null});
    const create={id:'create',op:'collection.create',idempotencyKey:'first',fields:{destination:'Tokyo'}};
    const accepted=await call(create);expect(accepted.status).toBe(200);const receipt=await accepted.json();expect(receipt.kind).toBe('accepted');
    expect(await(await call(create)).json()).toEqual(receipt);
    expect((await call({...create,fields:{destination:'Manila'}})).status).toBe(409);
    const page=await(await call(list)).json();expect(page.records).toHaveLength(1);expect(page.records[0].fields).toEqual({destination:'Tokyo'});
    expect((await call({...create,idempotencyKey:'bad',fields:{private:'secret'}})).status).toBe(400);
    expect((await call({...list,authorityRevision:2})).status).toBe(400);
    expect((await call(list,{origin:'null'})).status).toBe(404);
    expect((await call(list,{'x-dohc-app-proof':'Z'.repeat(43)})).status).toBe(404);
    f.withdraw();expect((await call(list)).status).toBe(404);expect((await call({...create,idempotencyKey:'after'})).status).toBe(404);
  }finally{f.close();}
});
