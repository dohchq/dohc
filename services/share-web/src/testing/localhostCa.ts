import "reflect-metadata";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as x509 from "@peculiar/x509";

export interface LocalhostCa {
  /** Absolute path of the CA certificate the trusting processes read. */
  caPath: string;
  ca: string;
  certificate: string;
  key: string;
}

export interface Validity { notBefore: Date; notAfter: Date }
export interface TestCa { certificate: x509.X509Certificate; keys: CryptoKeyPair }

const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

/** A test CA. Two CAs minted with one name differ only in their key. */
export async function mintTestCa(validity: Validity, name = "CN=dohc test CA"): Promise<TestCa> {
  x509.cryptoProvider.set(globalThis.crypto);
  const keys = await globalThis.crypto.subtle.generateKey(algorithm, false, ["sign", "verify"]);
  const certificate = await x509.X509CertificateGenerator.createSelfSigned({
    ...validity, signingAlgorithm: algorithm, serialNumber: "01", name, keys,
    extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true)],
  });
  return { certificate, keys };
}

export function mintTestKeys(): Promise<CryptoKeyPair> {
  return globalThis.crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
}

export async function exportTestKey(keys: CryptoKeyPair): Promise<string> {
  return x509.PemConverter.encode(await globalThis.crypto.subtle.exportKey("pkcs8", keys.privateKey), "PRIVATE KEY");
}

/** A server certificate `ca` signs for `keys`, naming one DNS name and one IP address. */
export async function signTestLeaf(ca: TestCa, keys: CryptoKeyPair, validity: Validity, serialNumber: string, names: { dns: string; ip: string }): Promise<string> {
  const certificate = await x509.X509CertificateGenerator.create({
    ...validity, signingAlgorithm: algorithm, serialNumber, issuer: ca.certificate.subject, subject: `CN=${names.dns}`,
    publicKey: keys.publicKey, signingKey: ca.keys.privateKey,
    extensions: [
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension([{ type: "dns", value: names.dns }, { type: "ip", value: names.ip }]),
    ],
  });
  return certificate.toString("pem");
}

// A test CA and a server certificate it signs for localhost and 127.0.0.1.
// rustls refuses a self-signed server certificate as its own trust anchor, so
// processes that verify TLS trust this CA instead. The CA file goes in the
// caller's directory, which owns and removes it.
export async function mintLocalhostCa(directory: string): Promise<LocalhostCa> {
  const day = 24 * 60 * 60 * 1000;
  const validity = { notBefore: new Date(Date.now() - day), notAfter: new Date(Date.now() + 7 * day) };
  const ca = await mintTestCa(validity);
  const keys = await mintTestKeys();
  const caPath = join(directory, "test-ca.pem");
  await writeFile(caPath, ca.certificate.toString("pem"), { flag: "wx" });
  return {
    caPath, ca: ca.certificate.toString("pem"),
    certificate: await signTestLeaf(ca, keys, validity, "02", { dns: "localhost", ip: "127.0.0.1" }),
    key: await exportTestKey(keys),
  };
}
