import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A short-lived self-signed certificate for test hosts, and the SPKI pin Chromium accepts it by.
 * Windows makes it with PowerShell, other hosts with OpenSSL.
 */
export function testCertificate(commonName: string, dnsNames: readonly string[]): { tls: https.ServerOptions; spki: string } {
  const pin = (cert: X509Certificate) => createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("base64");
  if (process.platform !== "win32") {
    // Files, not /dev/stdin and /dev/stdout: on Linux a child's stdio is a socket, which those can't open.
    const dir = mkdtempSync(join(tmpdir(), "dohc-share-web-cert-"));
    try {
      const [config, keyPath, certPath] = [join(dir, "req.cnf"), join(dir, "key.pem"), join(dir, "cert.pem")];
      writeFileSync(config, `[req]\ndistinguished_name=dn\nx509_extensions=leaf\nprompt=no\n[dn]\nCN=${commonName}\n` +
        `[leaf]\nsubjectAltName=${dnsNames.map(name => `DNS:${name}`).join(",")}\n`);
      execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-config", config, "-keyout", keyPath, "-out", certPath], { stdio: ["ignore", "pipe", "pipe"] });
      const certPem = readFileSync(certPath, "utf8");
      return { tls: { key: readFileSync(keyPath, "utf8"), cert: certPem }, spki: pin(new X509Certificate(certPem)) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const script = `$rsa=[System.Security.Cryptography.RSA]::Create(2048)
$req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=${commonName}',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
$san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
${dnsNames.map(name => `$san.AddDnsName('${name}')`).join(";")}
$req.CertificateExtensions.Add($san.Build())
$cert=$req.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5),[DateTimeOffset]::UtcNow.AddHours(1))
[Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''))
[Convert]::ToBase64String($cert.RawData)
$cert.Dispose();$rsa.Dispose()`;
  const [pfxText, certText] = execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/);
  return { tls: { pfx: Buffer.from(pfxText!, "base64"), passphrase: "" }, spki: pin(new X509Certificate(Buffer.from(certText!, "base64"))) };
}
