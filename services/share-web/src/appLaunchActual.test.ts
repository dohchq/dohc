import {it,expect} from 'vitest';
import {actualAppLaunchFixture} from '../e2e/actualAppLaunchFixture';
it('real relay checks grants, known profile blocks after reexchange, and withdrawal',async()=>{
  const f=actualAppLaunchFixture(Buffer.from("document.body.textContent='ok'"));
  try{
    const request=(path:string,body:unknown,cookie='')=>f.application.handle(new Request('https://viewer.example.com'+path,{method:'POST',headers:{host:'viewer.example.com',origin:'https://viewer.example.com','content-type':'application/json',cookie},body:JSON.stringify(body)}));
    const exchange=async(secret:string,previous='')=>{const e=await request('/api/exchange',{secret},previous);expect(e.status).toBe(200);return{value:await e.json(),cookie:e.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};};
    const issue=(session:{value:{session:string};cookie:string})=>request('/api/apps/launch',{discriminator:session.value.session,publicationId:f.publicationId},session.cookie);
    const good=await exchange(f.secret);expect((await issue(good)).status).toBe(200);
    const wrong=await exchange(f.wrongSecret);expect((await issue(wrong)).status).toBe(404);
    f.blockProfile();expect((await issue(good)).status).toBe(404);
    const refreshed=await exchange(f.secret,good.cookie);expect((await issue(refreshed)).status).toBe(404);
    f.withdraw();expect((await issue(refreshed)).status).toBe(404);
  }finally{f.close();}
});
