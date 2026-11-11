import { chromium, type Browser, type Frame } from "@playwright/test";
import https from "node:https";
import { testCertificate } from "./testCertificate";
import type { actualFundraiserFixture } from "./actualFundraiserFixture";

export async function publicLoadBrowser(fixture: Awaited<ReturnType<typeof actualFundraiserFixture>>) {
  const failures: string[] = [];
  const {tls, spki} = testCertificate("dohc-load-test", ["viewer.example.com", "*.example.net"]);
  const server = https.createServer(tls, async (request, response) => {
    try {
      if (request.headers.host === "viewer.example.com" && request.url === "/fixture-open") {
        response.writeHead(200, {"content-type": "text/html", "cache-control": "no-store"});
        response.end(`<!doctype html><button id="open">Open</button><script>document.getElementById('open').onclick=async()=>{
          const exchanged=await fetch('/api/exchange',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({secret:'${fixture.secret}'})});
          if(!exchanged.ok)throw Error('Exchange '+exchanged.status);const {session}=await exchanged.json();
          const launched=await fetch('/api/apps/launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({discriminator:session,publicationId:'${fixture.publicationId}'})});
          if(!launched.ok)throw Error('Launch '+launched.status);const launch=await launched.json();
          const form=document.createElement('form');form.method='POST';form.action=launch.action;const input=document.createElement('input');input.name='handoff';input.value=launch.handoff;
          form.append(input);document.body.append(form);form.submit();};</script>`);
        return;
      }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const result = await fixture.application.handle(new Request(`https://${request.headers.host}${request.url}`, {method: request.method, headers,
        ...(request.method === "POST" ? {body: Buffer.concat(chunks)} : {})}));
      response.writeHead(result.status, {...Object.fromEntries(result.headers), ...(result.headers.has("set-cookie") ? {"set-cookie": result.headers.getSetCookie()} : {})});
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {failures.push(String(error)); response.writeHead(500); response.end();}
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("Listener unavailable");
  let browser: Browser;
  try {
    browser = await chromium.launch({headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=MAP viewer.example.com 127.0.0.1:${address.port},MAP *.example.net 127.0.0.1:${address.port}`, "--no-proxy-server"]});
  } catch (error) {await stopServer(); throw error;}
  async function stopServer() {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));}
  return {browser, failures, async close() {await browser.close(); await stopServer();}};
}

export type BrokerReply = {ok: boolean; status?: number; error?: {code: string; message: string}; value?: any};
export async function loadRequest(frame: Frame, body: Record<string, unknown>): Promise<BrokerReply> {
  return frame.evaluate(body => (globalThis as unknown as {loadRequest(body: unknown): Promise<BrokerReply>}).loadRequest(body), body);
}
