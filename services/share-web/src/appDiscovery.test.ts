import {expect,it} from "vitest";
import {actualAppLaunchFixture} from "../e2e/actualAppLaunchFixture";
import {createAppDiscovery} from "./appDiscovery";
import {serveFetchHandler} from "@dohc/service-http";

it("discovers real relay apps through the viewer's server session without exposing secrets",async()=>{
  const f=actualAppLaunchFixture(Buffer.from("document.body.textContent='poll'"));
  try {
    const exchange=async(secret:string)=>{
      const result=await f.application.handle(new Request("https://viewer.example.com/api/exchange",{method:"POST",headers:{host:"viewer.example.com","content-type":"application/json"},body:JSON.stringify({secret})}));
      return {session:(await result.json()).session,cookie:result.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ")};
    };
    const good=await exchange(f.secret), wrong=await exchange(f.wrongSecret);
    const discover=(session:{session:string;cookie:string},extra:HeadersInit={})=>f.application.handle(new Request(`https://viewer.example.com/api/apps?session=${session.session}`,{
      headers:{host:"viewer.example.com",cookie:session.cookie,"sec-fetch-site":"same-origin",...Object.fromEntries(new Headers(extra))}}));
    const response=await discover(good);expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({publications:[{publicationId:f.publicationId,name:"app"}],nextCursor:null});
    expect(await (await discover(wrong)).json()).toEqual({publications:[],nextCursor:null});
    expect((await discover(good,{origin:"null"})).status).toBe(404);
    expect((await discover(good,{"sec-fetch-site":"cross-site"})).status).toBe(404);
    expect((await discover({...good,cookie:wrong.cookie})).status).toBe(404);
    f.withdraw();expect(await (await discover(good)).json()).toEqual({publications:[],nextCursor:null});
  } finally {f.close();}
});

it("rejects private fields and stale viewer material after the relay response",async()=>{
  let count=0,extra=false;
  const material={ok:true as const,capabilityToken:"server-token",profileSecret:"server-profile",setCookie:null};
  const handler=createAppDiscovery({viewerOrigin:"https://viewer.example.com",relayUrl:"https://relay.example.org",
    resolveMaterial:async()=>{count++;return count===2?{...material,capabilityToken:"new-token"}:material;},
    fetchRelay:async request=>{expect(request.headers.has("cookie")).toBe(false);return Response.json({publications:[],nextCursor:null,...(extra?{owner:"private"}:{})});}});
  const request=()=>new Request("https://viewer.example.com/api/apps?session=abcdefghijkl",{headers:{host:"viewer.example.com",cookie:"viewer"}});
  expect((await handler(request())).status).toBe(404);
  count=0;extra=true;expect((await handler(request())).status).toBe(404);
});

it("returns an authenticated empty page when app hosting is disabled",async()=>{
  const f=actualAppLaunchFixture(Buffer.from("document.body.textContent='poll'"),{appHosting:false});
  try {
    const exchange=await f.application.handle(new Request("https://viewer.example.com/api/exchange",{method:"POST",headers:{host:"viewer.example.com","content-type":"application/json"},body:JSON.stringify({secret:f.secret})}));
    const {session}=await exchange.json();
    const cookie=exchange.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
    const discover=(suppliedCookie:string)=>f.application.handle(new Request(`https://viewer.example.com/api/apps?session=${session}`,{headers:{host:"viewer.example.com",cookie:suppliedCookie,"sec-fetch-site":"same-origin"}}));
    const response=await discover(cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({publications:[],nextCursor:null});
    expect((await discover("")).status).toBe(404);
  } finally {f.close();}
});

it("discovers apps through the production HTTP adapter behind an HTTPS viewer",async()=>{
  const f=actualAppLaunchFixture(Buffer.from("document.body.textContent='poll'"));
  const server=serveFetchHandler({handler:f.application.handle,maxBodyBytes:()=>4096,oversized:()=>new Response(null,{status:413}),failure:()=>new Response(null,{status:500}),prepareHeaders:headers=>headers.set("host","viewer.example.com")});
  try {
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const address=server.address();if(!address||typeof address==="string")throw Error("No fixture listener");
    const base=`http://127.0.0.1:${address.port}`;
    const exchange=await fetch(`${base}/api/exchange`,{method:"POST",headers:{host:"viewer.example.com","content-type":"application/json"},body:JSON.stringify({secret:f.secret})});
    expect(exchange.status).toBe(200);
    const {session}=await exchange.json();
    const cookie=exchange.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
    const response=await fetch(`${base}/api/apps?session=${session}`,{headers:{host:"viewer.example.com",cookie,origin:"https://viewer.example.com","sec-fetch-site":"same-origin"}});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({publications:[{publicationId:f.publicationId,name:"app"}],nextCursor:null});
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));f.close();}
});
