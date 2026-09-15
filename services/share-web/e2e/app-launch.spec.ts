import { test, expect, chromium } from "@playwright/test";
import https from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createAppLaunchHandler } from "../src/appLaunch";

test("real HTTPS top-level handoff keeps app authority outside its opaque child", async () => {
  const viewer = "https://viewer.example.com", publicationId = "a".repeat(64);
  let active = true;
  const events: Array<{path: string; status: number; origin: string | null; cookie: boolean}> = [];
  const bytes = Buffer.from(`document.getElementById('root').textContent='App loaded';fetch('https://external.example.org/allowed',{method:'POST',body:'permitted'}).then(r=>r.text()).then(t=>document.body.dataset.external=t);`);
  const file = {path:"bundle.js",sha256:createHash("sha256").update(bytes).digest("hex"),byteLength:bytes.length,contentType:"text/javascript; charset=utf-8"};
  const app = createAppLaunchHandler({config:{viewerOrigin:viewer,appDomain:"example.net"},relayUrl:"https://relay.example.org",
    resolveMaterial:async (_d,cookie)=>cookie?.includes("viewer=session")?{ok:true,capabilityToken:"private-server-capability",profileSecret:"private-profile",setCookie:null}:{ok:false,status:404},
    fetchRelay:async request=>{
      if(!active)return new Response(null,{status:404});
      return new URL(request.url).pathname.includes("/blobs/")?new Response(bytes,{headers:{"content-type":file.contentType}}):Response.json({publicationId,authorityRevision:1,files:[file]});
    }});
  const certificateScript = `$rsa=[System.Security.Cryptography.RSA]::Create(2048)
$req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=dohc-app-test',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('viewer.example.com');$san.AddDnsName('*.example.net');$san.AddDnsName('external.example.org')
$req.CertificateExtensions.Add($san.Build())
$cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddHours(1))
[Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''))
[Convert]::ToBase64String($cert.RawData)
$cert.Dispose();$rsa.Dispose()`;
  const [pfxText,certText] = execFileSync("pwsh.exe",["-NoProfile","-NonInteractive","-Command",certificateScript],{encoding:"utf8",windowsHide:true}).trim().split(/\r?\n/);
  const cert = new X509Certificate(Buffer.from(certText!,"base64"));
  const spki = createHash("sha256").update(cert.publicKey.export({type:"spki",format:"der"})).digest("base64");
  const server = https.createServer({pfx:Buffer.from(pfxText!,"base64"),passphrase:""},async(req,res)=>{
    const host=req.headers.host!,path=req.url!;
    if(host==="external.example.org"){res.writeHead(200,{"access-control-allow-origin":"*"});res.end("received");return;}
    if(host==="viewer.example.com"&&path==="/"){
      res.writeHead(200,{"content-type":"text/html","set-cookie":"viewer=session; Secure; HttpOnly; SameSite=Strict; Path=/"});
      res.end(`<!doctype html><button id="open">Open app</button><script>document.getElementById('open').onclick=async()=>{const r=await fetch('/api/apps/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({discriminator:'abcdefghijkl',publicationId:'${publicationId}'})});const launch=await r.json();const f=document.createElement('form');f.method='POST';f.action=launch.action;const i=document.createElement('input');i.type='hidden';i.name='handoff';i.value=launch.handoff;f.append(i);document.body.append(f);f.submit();};</script>`);return;
    }
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(","):value);
    const request=new Request(`https://${host}${path}`,{method:req.method!,headers,...(req.method==="POST"?{body:Buffer.concat(chunks)}:{})});
    const response=await app.handle(request);events.push({path,status:response.status,origin:headers.get("origin"),cookie:headers.has("cookie")});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("No address");
  const browser=await chromium.launch({headless:true,ignoreDefaultArgs:["--disable-features=ThirdPartyStoragePartitioning"],args:[`--ignore-certificate-errors-spki-list=${spki}`,`--host-resolver-rules=MAP viewer.example.com 127.0.0.1:${address.port},MAP *.example.net 127.0.0.1:${address.port},MAP external.example.org 127.0.0.1:${address.port}`,"--no-proxy-server"]});
  try{
    const context=await browser.newContext(),page=await context.newPage();await page.goto(viewer);await page.getByRole("button",{name:"Open app"}).click();
    await expect(page).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    const child=page.frameLocator("iframe");await expect(child.locator("#root")).toHaveText("App loaded");await expect(child.locator("body")).toHaveAttribute("data-external","received");
    expect(await page.evaluate(()=>document.cookie)).toBe("");
    const frame=page.frames().find(f=>f.url()==="about:srcdoc")!;
    const checks=await frame.evaluate(async origin=>{
      const blocked:Record<string,boolean>={};for(const[name,fn]of Object.entries({parent:()=>parent.document,cookie:()=>document.cookie,storage:()=>localStorage.length})){try{fn();blocked[name]=false;}catch{blocked[name]=true;}}
      try{await fetch(origin+"/document",{method:"POST",credentials:"include"});}catch{}
      return blocked;
    },new URL(page.url()).origin);
    expect(checks).toEqual({parent:true,cookie:true,storage:true});
    await expect.poll(()=>events.some(e=>e.path==="/document"&&e.origin==="null"&&e.status===404)).toBe(true);
    expect(events.some(e=>e.path==="/document"&&e.status===200&&e.cookie)).toBe(true);
    active=false;await expect(page.getByRole("status")).toHaveText("This app session ended. Reopen the share link.",{timeout:20000});await expect(page.locator("iframe")).toHaveCount(0);
  } finally {await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
