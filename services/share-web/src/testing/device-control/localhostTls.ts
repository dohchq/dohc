import "reflect-metadata";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as x509 from "@peculiar/x509";

// A self-signed localhost certificate for test servers. The files are minted on
// first use and gitignored, so no private key is ever committed. Tests that
// hand the certificate path to child processes (NODE_EXTRA_CA_CERTS) or read it
// as a CA keep working because the paths are stable within the checkout.
const directory = fileURLToPath(new URL("./", import.meta.url));
export const localhostCertificatePath = join(directory, "localhost-cert.pem");
export const localhostKeyPath = join(directory, "localhost-key.pem");

function usable(): boolean {
  try {
    const certificate = new X509Certificate(readFileSync(localhostCertificatePath));
    const key = createPrivateKey(readFileSync(localhostKeyPath));
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

/** Returns the certificate and key paths, minting a fresh pair when none is valid. */
export async function ensureLocalhostTls(): Promise<{ certificate: string; key: string }> {
  if (!usable()) {
    const pems = await mint();
    // Write into a sibling temp dir and rename so concurrent test workers never read a partial file.
    const staging = mkdtempSync(join(dirname(localhostCertificatePath), "tls-"));
    try {
      await writeFile(join(staging, "cert.pem"), pems.certificate);
      await writeFile(join(staging, "key.pem"), pems.key);
      renameSync(join(staging, "cert.pem"), localhostCertificatePath);
      renameSync(join(staging, "key.pem"), localhostKeyPath);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  return { certificate: localhostCertificatePath, key: localhostKeyPath };
}
