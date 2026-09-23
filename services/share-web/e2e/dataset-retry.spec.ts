import { test, expect, chromium } from "@playwright/test";
import https from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createAppLaunchHandler } from "../src/appLaunch";
import { DatabaseSync } from "node:sqlite";
import { createDatasetAttempts } from "@dohc/app-backend-runtime/dataset-attempts";
import { generateDatasetFormFrontend } from "../../../apps/desktop/src/workspaces/datasetFormFrontend";

test("generated form retries one durable receipt submission after a lost reply and browser refresh", async () => {
  const viewer = "https://viewer.example.com", publicationId = "a".repeat(64);
  let active = true, lost = false, uploads = 0;
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE rows(id TEXT PRIMARY KEY,input_json TEXT NOT NULL); CREATE TABLE usage(bytes INTEGER); INSERT INTO usage VALUES(0)");
  const attempts = createDatasetAttempts({db, transaction<T>(run: () => T): T { db.exec("BEGIN"); try {const value=run();db.exec("COMMIT");return value;} catch(error){db.exec("ROLLBACK");throw error;} }, account(_scope,bytes) {db.prepare("UPDATE usage SET bytes=bytes+?").run(bytes);} });
  const scope = {workspaceId:"w",datasetId:"registrations",appId:publicationId,principalKey:"verified-friend",operationId:"register",revisionSha256:"b".repeat(64)};
  const receipt = {fileId:"file_abcdefghijklmnop",name:"receipt.pdf",contentType:"application/pdf",byteLength:4,sha256:createHash("sha256").update("%PDF").digest("hex")};
  const events: Array<{path: string; status: number; origin: string | null; cookie: boolean}> = [];
  const generated = generateDatasetFormFrontend({title:"Register",operation:"register",fields:[
    {fieldId:"name",name:"Name",type:"text",required:true,omitWhenEmpty:false},
    {fieldId:"receipt",name:"Receipt",type:"attachment",required:true,omitWhenEmpty:false},
  ]});
  const bytes = Buffer.from(generated["frontend.js"].replace("import './frontend.css';\n", ""));
  const file = {path:"bundle.js",sha256:createHash("sha256").update(bytes).digest("hex"),byteLength:bytes.length,contentType:"text/javascript; charset=utf-8"};
  const app = createAppLaunchHandler({config:{viewerOrigin:viewer,appDomain:"example.net"},relayUrl:"https://relay.example.org",
    resolveMaterial:async (_d,cookie)=>cookie?.includes("viewer=session")?{ok:true,capabilityToken:"private-server-capability",profileSecret:"private-profile",setCookie:null,currentCapability:async()=>"private-server-capability"}:{ok:false,status:404},
    fetchRelay:async request=>{
      if(!active)return new Response(null,{status:404});
      const path=new URL(request.url).pathname;
      if(path.endsWith("/backend/attempt")){const {authorityRevision,operation,...raw}=await request.json();if(authorityRevision!==1||operation!=="register")return new Response(null,{status:404});return Response.json(attempts.request(scope,raw,()=>{if(!active)throw Error();}));}
      if(path.endsWith("/backend/upload")){uploads++;return Response.json({file:receipt,replayed:uploads>1});}
      if(path.endsWith("/backend/invoke")){const body=await request.json(),prior=db.prepare("SELECT input_json FROM rows WHERE id=?").get(body.idempotencyKey);if(prior&&prior.input_json!==JSON.stringify(body.input))throw Error("Changed retry input");
        if(!prior)db.prepare("INSERT INTO rows VALUES(?,?)").run(body.idempotencyKey,JSON.stringify(body.input));
        if(!lost){lost=true;return new Response(null,{status:503});}
        return Response.json({result:{id:body.idempotencyKey},revision:1,replayed:!!prior});}
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
    const child=page.frameLocator("iframe");
    await child.getByLabel("Name *",{exact:true}).fill("Original friend");
    await child.getByLabel("Receipt *",{exact:true}).setInputFiles({name:"receipt.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF")});
    await child.getByRole("button",{name:"Submit",exact:true}).click();
    await expect(child.getByRole("status")).toContainText("may have been saved");
    const original=db.prepare("SELECT id,input_json FROM rows").get()!;
    expect(JSON.parse(String(original.input_json))).toEqual({values:{name:"Original friend",receipt:receipt.fileId}});
    await page.reload();
    await expect(child.getByLabel("Name *",{exact:true})).toHaveValue("Original friend");
    await expect(child.getByLabel("Name *",{exact:true})).toBeDisabled();
    await child.getByRole("button",{name:"Try again",exact:true}).click();
    await expect(child.getByRole("status")).toHaveText("Response received.");
    expect(db.prepare("SELECT id,input_json FROM rows").all()).toEqual([original]);expect(uploads).toBe(1);
    await page.reload();
    await child.getByRole("button",{name:"Try again",exact:true}).click();
    await expect(child.getByRole("status")).toHaveText("Response received.");
    expect(db.prepare("SELECT COUNT(*) AS n FROM rows").get()!.n).toBe(1);
    await child.getByRole("button",{name:"Submit another response",exact:true}).click();
    await expect(child.getByLabel("Name *",{exact:true})).toBeEnabled();
    expect(attempts.request(scope,{action:"get"},()=>{})).toEqual({attempt:null});
    const frame=page.frames().find(frame=>frame.url()==="about:srcdoc")!;
    expect(await frame.evaluate(()=>{try{return parent.sessionStorage.length;}catch{return "blocked";}})).toBe("blocked");
    active=false;await expect(page.getByRole("status")).toHaveText("This app session ended. Reopen the share link.",{timeout:20000});await expect(page.locator("iframe")).toHaveCount(0);
  } finally {await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();}
});
