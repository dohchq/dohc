import https from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { createShareWebApplication } from "../../../../services/share-web/src/server";
import { desktopRoot } from "./desktopApp";

export const sharedDatasetViewerOrigin = "https://viewer.example.com";

/** Real HTTPS with a test-only certificate and browser-local DNS; no host settings change. */
export async function startSharedDatasetBrowser(input: { relayUrl: string; exchangeKey: string }) {
  const certificateScript = `$rsa=[System.Security.Cryptography.RSA]::Create(2048)
$req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=dohc-dataset-test',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddDnsName('viewer.example.com');$san.AddDnsName('*.example.net')
$req.CertificateExtensions.Add($san.Build())
$cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddHours(1))
[Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''))
[Convert]::ToBase64String($cert.RawData)
$cert.Dispose();$rsa.Dispose()`;
  const [pfxText, certText] = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", certificateScript], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/);
  const cert = new X509Certificate(Buffer.from(certText!, "base64"));
  const spki = createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const failures: string[] = [];
  const application = createShareWebApplication({ relayUrl: input.relayUrl, publicRelayUrl: input.relayUrl,
    relayExchangeKey: input.exchangeKey, publicHosts: new Set(["viewer.example.com"]),
    viewerAssetsDir: join(desktopRoot, "../../services/share-web/viewer/dist"),
    appLaunch: { viewerOrigin: sharedDatasetViewerOrigin, appDomain: "example.net" } });
  const server = https.createServer({ pfx: Buffer.from(pfxText!, "base64"), passphrase: "" }, async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const result = await application.handle(new Request(`https://${request.headers.host}${request.url}`, {
        method: request.method, headers, ...(["GET", "HEAD"].includes(request.method!) ? {} : { body: Buffer.concat(chunks) }),
      }));
      response.writeHead(result.status, { ...Object.fromEntries(result.headers), ...(result.headers.has("set-cookie") ? { "set-cookie": result.headers.getSetCookie() } : {}) });
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { failures.push(String(error)); response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("No TLS listener.");
  const closeServer = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  try {
    const browser = await chromium.launch({ headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`,
      `--host-resolver-rules=MAP viewer.example.com 127.0.0.1:${address.port},MAP *.example.net 127.0.0.1:${address.port}`, "--no-proxy-server"] });
    return { browser, failures, async close() { try { await browser.close(); } finally { await closeServer(); } } };
  } catch (error) { await closeServer(); throw error; }
}
