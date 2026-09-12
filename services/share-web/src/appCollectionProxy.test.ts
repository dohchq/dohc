import {it,expect} from 'vitest';
import {forwardAppCollection} from './appCollectionProxy';
const list={id:'one',op:'collection.list',limit:5};
function forward(body:unknown,fetchRelay:(request:Request)=>Promise<Response>,contentType='application/json'){
  return forwardAppCollection({request:new Request('https://app.example.net/collection',{method:'POST',headers:{'content-type':contentType,cookie:'app=cookie','x-dohc-app-proof':'proof'},body:JSON.stringify(body)}),relayUrl:'https://relay.example.org',publicationId:'a'.repeat(64),authorityRevision:7,capability:'cap',profileSecret:'profile',signal:new AbortController().signal,fetchRelay});
}
it('fixes relay destination and revision without forwarding browser credentials',async()=>{
  const response=await forward({...list,afterPath:'responses/a.md'},async request=>{
    expect(request.url).toBe('https://relay.example.org/sync/link/app-publications/'+ 'a'.repeat(64)+'/collection?authorityRevision=7&limit=5&afterPath=responses%2Fa.md');
    expect(Object.fromEntries(request.headers)).toEqual({authorization:'LinkCapability cap','x-dohc-link-profile-secret':'profile'});expect(request.redirect).toBe('manual');
    return Response.json({records:[],nextPath:null});
  });expect(response.status).toBe(200);
});
it('rejects invalid and oversized requests before relay access',async()=>{
  let calls=0;const relay=async()=>{calls++;return Response.json({records:[],nextPath:null});};
  for(const body of [{...list,url:'https://elsewhere.example/'},{...list,authorityRevision:1},{...list,limit:101},{...list,afterPath:'../private'}, {id:'one',op:'fetch'}])expect((await forward(body,relay)).status).toBe(400);
  expect((await forward({...list,extra:'x'.repeat(17000)},relay)).status).toBe(413);
  expect((await forward(list,relay,'text/plain')).status).toBe(400);expect(calls).toBe(0);
});
it('maps authentication refusals, preserves actionable statuses, and refuses redirects',async()=>{
  for(const status of [400,401,403,404,409,413,429,500])expect((await forward(list,async()=>new Response(null,{status}))).status).toBe(status===401||status===403?404:status===500?503:status);
  expect((await forward(list,async()=>new Response(null,{status:302,headers:{location:'https://elsewhere.example'}}))).status).toBe(503);
});
it('rejects malformed and oversized relay responses',async()=>{
  for(const value of [{records:[],nextPath:null,capability:'secret'},{records:[{path:'a',recordId:null,fields:{},private:'x'}],nextPath:null},{records:[],nextPath:4}])expect((await forward(list,async()=>Response.json(value))).status).toBe(503);
  expect((await forward(list,async()=>new Response('x'.repeat(1024*1024+1)))).status).toBe(503);
});
