import {it,expect,vi} from 'vitest';
import {MessageChannel as NodeMessageChannel, type MessagePort as NodeMessagePort} from 'node:worker_threads';
import {once} from 'node:events';
import {attachAppCollectionBroker} from '@dohc/app-browser/broker';

function harness(send:(body:unknown,signal:AbortSignal)=>Promise<Response> = async body=>Response.json(body)) {
  vi.stubGlobal('MessageChannel',NodeMessageChannel);
  const frame=new EventTarget();let port!:NodeMessagePort;
  Object.assign(frame,{contentWindow:{postMessage(message:unknown,target:string,ports:NodeMessagePort[]){expect(message).toEqual({kind:'dohc-app-channel',version:1});expect(target).toBe('*');expect(ports).toHaveLength(1);port=ports[0]!;}}});
  const lifetime=new AbortController();attachAppCollectionBroker(frame as HTMLIFrameElement,send,lifetime.signal);frame.dispatchEvent(new Event('load'));
  const request=(body:unknown)=>{const response=once(port,'message');port.postMessage(body);return response.then(([value])=>value);};
  return {frame,port,lifetime,request,close(){lifetime.abort();vi.unstubAllGlobals();}};
}
it('forwards collection list/create and returns data without session material',async()=>{
  const calls:unknown[]=[];const f=harness(async body=>{calls.push(body);return Response.json({records:[],nextPath:null});});
  try{expect(await f.request({id:'list',op:'collection.list',limit:50})).toEqual({id:'list',ok:true,value:{records:[],nextPath:null}});
    expect((await f.request({id:'create',op:'collection.create',idempotencyKey:'vote',fields:{destination:'Tokyo'}})).ok).toBe(true);
    expect(await f.request({id:'fetch',op:'fetch',url:'https://private'})).toEqual({id:'fetch',ok:false,status:400});
    expect(await f.request({id:'extra',op:'collection.list',limit:1,authorityRevision:99})).toEqual({id:'extra',ok:false,status:400});expect(calls).toHaveLength(2);
  }finally{f.close();}
});
it('forwards backend operations, uploads, and file reads while rejecting supplied authority',async()=>{
  const calls:unknown[]=[];const f=harness(async body=>{calls.push(body);return Response.json({result:null});});
  try{
    const invoke={id:'invoke',op:'backend.invoke',operation:'register',idempotencyKey:'attempt-1',input:{}};
    const upload={id:'upload',op:'backend.upload',idempotencyKey:'upload-1',name:'receipt.pdf',contentType:'application/pdf',bytesBase64:'JVBERg=='};
    const file={id:'file',op:'backend.file',fileId:'file_0123456789abcdef',operation:'receipt.read',input:{}};
    for(const body of [invoke,upload,file])expect((await f.request(body)).ok).toBe(true);
    for(const body of [{...invoke,caller:{kind:'owner'}},{...upload,path:'private'},{...file,authorityRevision:1}])expect((await f.request(body)).status).toBe(400);
    expect(calls).toEqual([invoke,upload,file]);
  }finally{f.close();}
});
it('uses bounded file budgets without widening operation replies',async()=>{
  const f=harness(async()=>Response.json({bytesBase64:'A'.repeat(2*1024*1024)}));
  try{
    expect((await f.request({id:'file',op:'backend.file',fileId:'file_0123456789abcdef',operation:'receipt.read',input:{}})).ok).toBe(true);
    expect((await f.request({id:'invoke',op:'backend.invoke',operation:'read',idempotencyKey:'read-1',input:{}})).status).toBe(503);
    expect((await f.request({id:'large',op:'backend.invoke',operation:'read',idempotencyKey:'read-1',input:'x'.repeat(128*1024)})).status).toBe(413);
    expect((await f.request({id:'upload',op:'backend.upload',idempotencyKey:'upload-1',name:'file',contentType:'application/pdf',bytesBase64:'A'.repeat(2*1024*1024)})).ok).toBe(true);
    expect((await f.request({id:'oversize',op:'backend.upload',idempotencyKey:'upload-2',name:'file',contentType:'application/pdf',bytesBase64:'A'.repeat(8*1024*1024)})).status).toBe(413);
  }finally{f.close();}
});
it('charges backend uploads against the same request tokens as collection operations',async()=>{
  const f=harness();
  try{
    for(let index=0;index<12;index++)expect((await f.request({id:'u'+index,op:'backend.upload',idempotencyKey:'upload-'+index,name:'file',contentType:'application/pdf',bytesBase64:'JVBERg=='})).ok).toBe(true);
    expect((await f.request({id:'list',op:'collection.list',limit:1})).status).toBe(429);
    expect((await f.request({id:'invoke',op:'backend.invoke',operation:'register',idempotencyKey:'attempt-1',input:{}})).status).toBe(429);
  }finally{f.close();}
});
it('bounds requests, pending messages and repeated request ids',async()=>{
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const f=harness(async()=>{await held;return Response.json({});});
  try{
    expect(await f.request({id:'large',op:'collection.create',idempotencyKey:'vote',fields:{text:'x'.repeat(17000)}})).toEqual({id:'large',ok:false,status:413});
    f.port.postMessage({id:'held',op:'collection.list',limit:1});
    expect(await f.request({id:'held',op:'collection.list',limit:1})).toEqual({id:'held',ok:false,status:429});
    for(const id of ['b','c','d'])f.port.postMessage({id,op:'collection.list',limit:1});
    expect(await f.request({id:'overflow',op:'collection.list',limit:1})).toEqual({id:'overflow',ok:false,status:429});
  }finally{f.close();release();}
});
it.each(['frame','session'])('closes the channel and cancels pending responses on stale %s',async kind=>{
  let admitted!:()=>void,release!:()=>void,signal!:AbortSignal;const ready=new Promise<void>(resolve=>{admitted=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const f=harness(async(_body,current)=>{signal=current;admitted();await hold;return Response.json({private:'must not arrive'});});
  try{f.port.postMessage({id:'pending',op:'collection.list',limit:1});await ready;const closed=once(f.port,'close');
    if(kind==='frame')f.frame.dispatchEvent(new Event('load'));else f.lifetime.abort();
    expect(signal.aborted).toBe(true);await closed;release();
  }finally{f.close();release();}
});
it('passes authority refusal and conflict while hiding arbitrary upstream errors',async()=>{
  const statuses=[404,409,500];const f=harness(async()=>new Response(null,{status:statuses.shift()!}));
  try{for(const [id,status]of [['revoked',404],['conflict',409],['offline',503]]as const)expect(await f.request({id,op:'collection.list',limit:1})).toEqual({id,ok:false,status});}
  finally{f.close();}
});
it('bounds reply bytes and cancels unread error bodies',async()=>{
  let cancelled=false;const responses=[new Response('x'.repeat(1024*1024+1)),new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:404})];
  const f=harness(async()=>responses.shift()!);
  try{expect(await f.request({id:'large',op:'collection.list',limit:1})).toEqual({id:'large',ok:false,status:503});expect(await f.request({id:'error',op:'collection.list',limit:1})).toEqual({id:'error',ok:false,status:404});expect(cancelled).toBe(true);}
  finally{f.close();}
});
