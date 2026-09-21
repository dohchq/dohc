import { test, expect, chromium } from "@playwright/test";
import https from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { actualFundraiserFixture, syntheticReceipt, viewerOrigin } from "./actualFundraiserFixture";

// This Windows browser proof uses PowerShell 7 to create its temporary TLS certificate.
test("actual fundraiser registers guests and organizers manage the same private database", async ({}, info) => {
  test.setTimeout(120_000);
  const f=await actualFundraiserFixture(),failures:string[]=[];
  const certificateScript=`$rsa=[System.Security.Cryptography.RSA]::Create(2048)
$req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=dohc-fundraiser-test',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('viewer.example.com');$san.AddDnsName('*.example.net')
$req.CertificateExtensions.Add($san.Build())
$cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddHours(1))
[Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''))
[Convert]::ToBase64String($cert.RawData)
$cert.Dispose();$rsa.Dispose()`;
  const [pfxText,certText]=execFileSync("pwsh.exe",["-NoProfile","-NonInteractive","-Command",certificateScript],{encoding:"utf8",windowsHide:true}).trim().split(/\r?\n/);
  const cert=new X509Certificate(Buffer.from(certText!,"base64"));
  const spki=createHash("sha256").update(cert.publicKey.export({type:"spki",format:"der"})).digest("base64");
  const server=https.createServer({pfx:Buffer.from(pfxText!,"base64"),passphrase:""},async(req,res)=>{
    try {
      if(req.headers.host==="viewer.example.com"&&req.url==="/fixture-open"){
        res.writeHead(200,{"content-type":"text/html","cache-control":"no-store"});
        res.end(`<!doctype html><button id="open">Open fundraiser</button><script>document.getElementById('open').onclick=async()=>{const exchange=await fetch('/api/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:'${f.secret}'})});const {session}=await exchange.json();const r=await fetch('/api/apps/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({discriminator:session,publicationId:'${f.publicationId}'})});const launch=await r.json();const form=document.createElement('form');form.method='POST';form.action=launch.action;const input=document.createElement('input');input.name='handoff';input.value=launch.handoff;form.append(input);document.body.append(form);form.submit();};</script>`);return;
      }
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(","):value);
      const result=await f.application.handle(new Request(`https://${req.headers.host}${req.url}`,{method:req.method,headers,...(req.method==="POST"?{body:Buffer.concat(chunks)}:{})}));
      res.writeHead(result.status,{...Object.fromEntries(result.headers),...(result.headers.has("set-cookie")?{"set-cookie":result.headers.getSetCookie()}:{})});res.end(Buffer.from(await result.arrayBuffer()));
    }catch(error){failures.push(String(error));res.writeHead(500);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("No listener");
  const browser=await chromium.launch({headless:true,args:[`--ignore-certificate-errors-spki-list=${spki}`,`--host-resolver-rules=MAP viewer.example.com 127.0.0.1:${address.port},MAP *.example.net 127.0.0.1:${address.port}`,"--no-proxy-server"]});
  try {
    const guestContext=await browser.newContext({viewport:{width:1280,height:1000}}),guest=await guestContext.newPage();
    guest.setDefaultTimeout(15_000);
    guest.on("pageerror",error=>failures.push(String(error)));
    await guest.goto(`${viewerOrigin}/fixture-open`);await guest.getByRole("button",{name:"Open fundraiser"}).click();
    await expect(guest).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    const publicApp=guest.frameLocator("iframe");
    await expect(publicApp.getByText(/36 of 36 player slots open/).first()).toBeVisible();
    await guest.screenshot({path:info.outputPath("fundraiser-public-desktop.png")});
    await publicApp.getByLabel("Your first and last name").fill("Synthetic Contact");
    await publicApp.getByLabel("Mobile number",{exact:true}).fill("09171234567");
    await publicApp.getByRole("checkbox",{name:/Session 1/}).check();
    await publicApp.getByRole("textbox",{name:"Player 1 name",exact:true}).fill("First Player");
    await publicApp.getByRole("button",{name:"Add spectator",exact:true}).click();
    await publicApp.getByRole("textbox",{name:"Spectator 1 name",exact:true}).fill("Watching Friend");
    await publicApp.getByRole("radio",{name:"GCash",exact:true}).check();
    await publicApp.getByLabel("Receipt",{exact:true}).setInputFiles({name:"synthetic-receipt.pdf",mimeType:"application/pdf",buffer:syntheticReceipt});
    await guest.setViewportSize({width:390,height:844});
    await guest.screenshot({path:info.outputPath("fundraiser-public-mobile.png")});
    const recoveryDownload=guest.waitForEvent("download");
    await publicApp.getByRole("button",{name:"Send registration",exact:true}).click();
    const recovery=await recoveryDownload;expect(recovery.suggestedFilename()).toBe("fundraiser-recovery.json");
    await recovery.saveAs(info.outputPath("synthetic-recovery.json"));
    const recoveryData=JSON.parse(await readFile(info.outputPath("synthetic-recovery.json"),"utf8"));
    expect(recoveryData.attempt.input.receiptSha256).toBe(createHash("sha256").update(syntheticReceipt).digest("hex"));
    await expect(publicApp.getByRole("heading",{name:"Registration received"})).toBeVisible();
    await expect(publicApp.locator(".confirmation").getByText("₱1,150",{exact:true})).toBeVisible();
    const token=await publicApp.locator("output.token").innerText();expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await publicApp.getByRole("button",{name:"Check status",exact:true}).click();
    await publicApp.getByRole("button",{name:"Check status",exact:true}).click();
    await expect(publicApp.getByText("Players: First Player",{exact:true})).toBeVisible();
    await publicApp.getByLabel("Private status token",{exact:true}).fill("Z".repeat(43));
    await publicApp.getByRole("button",{name:"Check status",exact:true}).click();
    await expect(publicApp.getByRole("alert")).toContainText("This status link is invalid.");
    await publicApp.getByRole("button",{name:"Organizer",exact:true}).click();
    await expect(publicApp.getByRole("alert")).toContainText("Organizer access is unavailable");
    expect(f.calls.some(call=>call.operation==="totals"&&!call.named&&call.status===404)).toBe(true);

    const organizerContext=await browser.newContext({viewport:{width:1280,height:1000},reducedMotion:"reduce"}),organizer=await organizerContext.newPage();
    organizer.setDefaultTimeout(15_000);
    organizer.on("pageerror",error=>failures.push(String(error)));
    await organizer.goto(`${viewerOrigin}/s/apps/w/${f.publicationId}`);
    await organizer.getByLabel("Email",{exact:true}).fill("organizer@example.test");
    await organizer.getByLabel("Password",{exact:true}).fill("synthetic-password");
    await organizer.getByRole("button",{name:"Sign in",exact:true}).click();
    await organizer.getByRole("button",{name:"Open app",exact:true}).click();
    await expect(organizer).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    const admin=organizer.frameLocator("iframe");
    await admin.getByRole("button",{name:"Organizer",exact:true}).click();
    await admin.getByRole("button",{name:"Synthetic Contact",exact:true}).click();
    const dialog=admin.getByRole("dialog");
    await dialog.getByRole("button",{name:"Show receipt",exact:true}).click();
    const receiptDownload=organizer.waitForEvent("download");
    await dialog.getByRole("button",{name:"Save receipt",exact:true}).click();
    const receipt=await receiptDownload;await receipt.saveAs(info.outputPath("downloaded-receipt.pdf"));
    expect(await readFile(info.outputPath("downloaded-receipt.pdf"))).toEqual(syntheticReceipt);
    await dialog.getByRole("button",{name:"Reject",exact:true}).click();
    await dialog.getByRole("button",{name:"Reject registration",exact:true}).click();
    await expect(dialog.getByText("Registration rejected. Its player slots are released.")).toBeVisible();
    expect((await f.ownerRead("listPublicSessions")).result[0].available).toBe(36);
    await dialog.getByRole("button",{name:"Restore to pending",exact:true}).click();
    await expect(dialog.getByText("Moved back to pending verification.")).toBeVisible();
    expect((await f.ownerRead("listPublicSessions")).result[0].available).toBe(35);
    await dialog.getByRole("button",{name:"Close",exact:true}).click();
    await expect(admin.getByRole("button",{name:"Synthetic Contact",exact:true})).toBeVisible();
    await organizer.screenshot({path:info.outputPath("fundraiser-organizer-desktop.png")});
    await admin.getByRole("button",{name:"Synthetic Contact",exact:true}).click();
    await dialog.getByRole("button",{name:"Verify payment",exact:true}).click();
    await expect(dialog.getByText("Payment verified.",{exact:true})).toBeVisible();
    expect((await f.ownerRead("listPublicSessions")).result[0].available).toBe(35);
    await dialog.getByRole("button",{name:"Close",exact:true}).click();
    await admin.getByRole("tab",{name:"Add entry",exact:true}).click();
    await admin.getByLabel("Full name",{exact:true}).fill("Venue Friend");
    await admin.getByRole("radio",{name:"Spectator",exact:true}).check();
    await admin.getByRole("tabpanel",{name:"Add entry",exact:true}).getByLabel("Session",{exact:true}).selectOption("both");
    await admin.getByRole("button",{name:"Save entry",exact:true}).click();
    await expect(admin.getByText(/Added Venue Friend as pay at venue/)).toBeVisible();
    const rows=await f.ownerRead("listRegistrations");
    expect(rows.result.records).toHaveLength(2);
    expect(rows.result.records.find((row:{fullName:string})=>row.fullName==="Venue Friend")).toMatchObject({source:"reclub",status:"pay_at_venue",total:300});
    await admin.getByRole("tab",{name:"Attendees",exact:true}).click();
    try { await expect(admin.getByRole("cell",{name:"Venue Friend",exact:true}).first()).toBeVisible(); }
    catch(error) { console.log("Organizer state",await admin.locator("body").innerText(),JSON.stringify(f.calls));throw error; }
    await organizer.setViewportSize({width:390,height:844});await organizer.emulateMedia({colorScheme:"dark"});
    await organizer.screenshot({path:info.outputPath("fundraiser-organizer-mobile-dark.png")});
    expect(await admin.locator("body").evaluate(body=>body.scrollWidth<=innerWidth)).toBe(true);
    expect((await f.ownerRead("attendees")).result.records).toHaveLength(4);
    const table=await f.ownerRead("tableRegistrations",{offset:0,limit:50,search:"Venue"});
    expect(table.result.rows).toHaveLength(1);
    expect(table.result.rows[0]).toMatchObject({fullName:"Venue Friend",status:"pay_at_venue",total:300});
    expect(f.compiler.recipe).toBe("dohc-closed-app-v2");expect(failures).toEqual([]);
    await info.attach("real-backend-operations",{body:JSON.stringify(f.calls,null,2),contentType:"application/json"});
  }finally{await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});
