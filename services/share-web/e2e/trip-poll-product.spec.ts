import {test,expect,chromium} from '@playwright/test';
import https from 'node:https';
import {createHash,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tripPollProductFixture} from './tripPollProductFixture';

test('production viewer discovers and launches compiled trip poll with real shared responses',async({},testInfo)=>{
  test.skip(process.platform!=='win32','This HTTPS certificate fixture uses PowerShell on Windows.');
  test.setTimeout(120000);
  const evidence=testInfo.outputPath('product-proof');mkdirSync(evidence,{recursive:true});
  const packageRoot=fileURLToPath(new URL('..',import.meta.url)),viewerAssetsDir=join(evidence,'viewer');
  execFileSync(process.execPath,[join(packageRoot,'node_modules/vite/bin/vite.js'),'build','--config','viewer/vite.config.ts','--outDir',viewerAssetsDir],{cwd:packageRoot,windowsHide:true,stdio:'pipe'});
  let fixture:Awaited<ReturnType<typeof tripPollProductFixture>>|undefined,server:ReturnType<typeof https.createServer>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const events:Array<{path:string;status:number;origin:string|null;contentType:string|null}>=[],errors:string[]=[];
  try{
  fixture=await tripPollProductFixture(evidence,viewerAssetsDir);
  const certificateScript=`$rsa=[System.Security.Cryptography.RSA]::Create(2048)
$req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=dohc-app-test',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('viewer.example.com');$san.AddDnsName('*.example.net')
$req.CertificateExtensions.Add($san.Build())
$cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddHours(1))
[Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''))
[Convert]::ToBase64String($cert.RawData)
$cert.Dispose();$rsa.Dispose()`;
  const [pfxText,certText]=execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',certificateScript],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/);
  const cert=new X509Certificate(Buffer.from(certText!,'base64')),spki=createHash('sha256').update(cert.publicKey.export({type:'spki',format:'der'})).digest('base64');
  server=https.createServer({pfx:Buffer.from(pfxText!,'base64'),passphrase:''},async(req,res)=>{
    try{
      const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const response=await fixture!.app.handle(new Request(`https://${req.headers.host}${req.url}`,{method:req.method!,headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})}));
      events.push({path:new URL(`https://${req.headers.host}${req.url}`).pathname,status:response.status,origin:headers.get('origin'),contentType:headers.get('content-type')});
      res.writeHead(response.status,{...Object.fromEntries(response.headers),...(response.headers.has('set-cookie')?{'set-cookie':response.headers.getSetCookie()}:{})});res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){errors.push(String(error));res.writeHead(500);res.end();}
  });
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('No server address');
  browser=await chromium.launch({headless:true,ignoreDefaultArgs:['--disable-features=ThirdPartyStoragePartitioning'],args:[`--ignore-certificate-errors-spki-list=${spki}`,`--host-resolver-rules=MAP viewer.example.com 127.0.0.1:${address.port},MAP *.example.net 127.0.0.1:${address.port}`,'--no-proxy-server']});
    const open=async(colorScheme:'light'|'dark',width:number,secret=fixture!.secret)=>{
      const context=await browser!.newContext({viewport:{width,height:900},colorScheme,reducedMotion:'reduce'}),page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
      await page.goto('https://viewer.example.com/s/#'+secret);
      await expect(page.getByRole('button',{name:'Open app',exact:true})).toBeVisible();
      await page.screenshot({path:evidence+'/p5-trip-viewer-discovery.png'});
      await page.getByRole('button',{name:'Open app',exact:true}).click();
      await expect(page).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
      const child=page.frameLocator('iframe');await expect(child.getByRole('heading',{name:'Where should we go?'})).toBeVisible();
      return{context,page,child};
    };
    const first=await open('light',1000);await expect(first.child.getByText('No responses yet. Send yours above.')).toBeVisible();
    await first.child.getByLabel('Name (optional)').fill('Ice');await first.child.getByLabel('Destination',{exact:true}).selectOption('Manila');
    await first.child.getByRole('button',{name:'Send response',exact:true}).click();await expect(first.child.getByText('Response saved.',{exact:true})).toBeVisible();
    await expect(first.child.getByRole('listitem')).toHaveCount(1);await expect(first.child.getByRole('listitem')).toHaveText('IceManila');
    await first.page.screenshot({path:evidence+'/p5-trip-product-light.png'});
    const second=await open('dark',390);await expect(second.child.getByRole('listitem')).toHaveCount(1);await expect(second.child.getByRole('listitem')).toHaveText('IceManila');
    await second.child.getByLabel('Name (optional)').fill('Alex');await second.child.getByRole('button',{name:'Send response',exact:true}).click();await expect(second.child.getByText('Response saved.',{exact:true})).toBeVisible();
    const principals=fixture.principalEvidence();expect(principals).toHaveLength(2);expect(new Set(principals.map(row=>row.principal_id)).size).toBe(2);expect(new Set(principals.map(row=>row.public_principal_id)).size).toBe(2);expect(principals.every(row=>row.grant_id==='g')).toBe(true);
    await first.child.getByRole('button',{name:'Refresh',exact:true}).click();await expect(first.child.getByRole('listitem')).toHaveCount(2);
    const separate=await open('light',1000,fixture.secondSecret);expect(fixture.secondPublicationId).not.toBe(fixture.artifact.publicationId);expect(new URL(separate.page.url()).host).not.toBe(new URL(first.page.url()).host);
    await separate.child.getByLabel('Name (optional)').fill('Sam');await separate.child.getByRole('button',{name:'Send response',exact:true}).click();await expect(separate.child.getByText('Response saved.',{exact:true})).toBeVisible();
    const allPrincipals=fixture.principalEvidence();expect(allPrincipals).toHaveLength(3);expect(new Set(allPrincipals.map(row=>row.principal_id)).size).toBe(3);expect(allPrincipals.filter(row=>row.grant_id==='g2')).toHaveLength(1);
    fixture.revokeSecond();await separate.child.getByRole('button',{name:'Refresh',exact:true}).click();await expect(separate.child.getByRole('alert')).toHaveText('This poll is unavailable. Ask its owner for a current link.');
    await first.child.getByRole('button',{name:'Refresh',exact:true}).click();await expect(first.child.getByRole('alert')).toHaveCount(0);await expect(first.child.getByRole('listitem')).toHaveCount(3);
    const frameLayout=await first.page.locator('iframe').evaluate(frame=>({top:frame.getBoundingClientRect().top,statusMargin:getComputedStyle(document.getElementById('status')!).margin,display:getComputedStyle(frame).display}));
    writeFileSync(join(evidence,'frame-layout.json'),JSON.stringify(frameLayout));expect(frameLayout.top).toBe(0);expect(frameLayout.display).toBe('block');
    expect(await second.child.locator('body').evaluate(body=>body.scrollWidth<=innerWidth)).toBe(true);
    await second.page.screenshot({path:evidence+'/p5-trip-product-dark-mobile.png'});
    fixture.withdraw();await second.child.getByRole('button',{name:'Refresh',exact:true}).click();await expect(second.child.getByRole('alert')).toHaveText('This poll is unavailable. Ask its owner for a current link.');
    await expect(first.page.getByRole('status')).toHaveText('This app session ended. Reopen the share link.',{timeout:20000});
    await expect(first.page.locator('iframe')).toHaveCount(0);
    const discovery=second.page.waitForResponse(response=>new URL(response.url()).pathname==='/api/apps');
    await second.page.goto('https://viewer.example.com/s/#'+fixture.secret);expect((await discovery).status()).toBe(200);await expect(second.page.getByText('No apps are available on this link. Ask the owner to publish one.')).toBeVisible();await expect(second.page.getByRole('button',{name:'Open app',exact:true})).toHaveCount(0);
    expect(events.some(event=>event.path==='/api/apps'&&event.status===200)).toBe(true);expect(events.some(event=>event.path==='/bootstrap'&&event.origin==='null'&&event.status===200)).toBe(true);expect(events.filter(event=>event.path==='/collection'&&event.status===200).length).toBeGreaterThanOrEqual(4);expect(errors).toEqual([]);
    writeFileSync(evidence+'/p5-trip-product-browser.json',JSON.stringify({ok:true,...fixture.artifact,browser:await browser.version(),serverPort:address.port,events,checks:['production viewer app discovery','actual compiled React trip poll','actual SQLite relay collection approval and writes','second independent browser context sees response','withdrawal refuses reads and ends session','withdrawn app absent from discovery','light desktop and dark mobile'],errors},null,2));
  }finally{
    try{writeFileSync(evidence+'/p5-trip-product-attempt.json',JSON.stringify({events,errors},null,2));}
    finally{try{await browser?.close();}finally{try{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server!.close(()=>resolve()));}}finally{fixture?.close();}}}
  }
});
