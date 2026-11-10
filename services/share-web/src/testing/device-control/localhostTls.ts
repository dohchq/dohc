import "reflect-metadata";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as x509 from "@peculiar/x509";

const directory = fileURLToPath(new URL("./", import.meta.url));

function usable(certificatePath: string, keyPath: string): boolean {
  try {
    const certificate = new X509Certificate(readFileSync(certificatePath));
    const key = createPrivateKey(readFileSync(keyPath));
    return certificate.checkPrivateKey(key) && Date.parse(certificate.validTo) > Date.now() + 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

async function mint(): Promise<{ certificate: string; key: string }> {
  const { subtle } = globalThis.crypto;
  x509.cryptoProvider.set(globalThis.crypto);
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
  const keys = await subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Date.now().toString(16),
    name: "CN=localhost",
    notBefore: new Date(),
    notAfter: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
    signingAlgorithm: algorithm,
    keys,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: "dns", value: "localhost" }, { type: "ip", value: "127.0.0.1" }])],
  });
  const pkcs8 = await subtle.exportKey("pkcs8", keys.privateKey);
  return { certificate: certificate.toString("pem"), key: x509.PemConverter.encode(pkcs8, "PRIVATE KEY") };
}

/** Returns stable paths to the first complete localhost TLS pair. */
export async function ensureLocalhostTls(root = directory): Promise<{ certificate: string; key: string }> {
  const published = join(root, "tls-localhost");
  const certificate = join(published, "cert.pem"), key = join(published, "key.pem");
  if (!usable(certificate, key)) {
    const pems = await mint();
    const staging = mkdtempSync(join(root, "tls-"));
    try {
      await writeFile(join(staging, "cert.pem"), pems.certificate);
      await writeFile(join(staging, "key.pem"), pems.key);
      // A nonempty directory cannot be replaced. All workers use the first
      // complete pair, including children given its NODE_EXTRA_CA_CERTS path.
      try { renameSync(staging, published); }
      catch (error) { if (!usable(certificate, key)) throw error; }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { certificate, key };
}
