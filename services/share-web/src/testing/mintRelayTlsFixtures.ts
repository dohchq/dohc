// Writes the synthetic TLS fixtures the native relay transport's tests read.
// Run from the checkout root:
//   pnpm --filter @dohc/share-web exec tsx src/testing/mintRelayTlsFixtures.ts
// The CA and its key are test-only and are discarded once the leaves are
// signed. The leaves' key is published with them on purpose; nothing trusts it
// outside these tests.
import { mkdir, writeFile } from "node:fs/promises";
import { exportTestKey, mintTestCa, mintTestKeys, signTestLeaf } from "./localhostCa";

const directory = new URL("../../../../crates/dohc-engine-sync-http/tests/fixtures/tls/", import.meta.url);
const validity = { notBefore: new Date("2025-01-01T00:00:00Z"), notAfter: new Date("2125-01-01T00:00:00Z") };
const name = "CN=dohc relay transport test CA";
const ca = await mintTestCa(validity, name);
// The same name with another key, so only the signature tells the CAs apart.
const impostor = await mintTestCa(validity, name);
const keys = await mintTestKeys();
const files = {
  "relay-test-ca.pem": ca.certificate.toString("pem"),
  "relay-test-leaf.pem": await signTestLeaf(ca, keys, validity, "02", { dns: "localhost", ip: "127.0.0.1" }),
  "relay-test-wrong-host-leaf.pem": await signTestLeaf(ca, keys, validity, "03", { dns: "relay.invalid", ip: "127.0.0.2" }),
  "relay-test-impostor-leaf.pem": await signTestLeaf(impostor, keys, validity, "04", { dns: "localhost", ip: "127.0.0.1" }),
  "relay-test-leaf-key.pem": await exportTestKey(keys),
};
await mkdir(directory, { recursive: true });
for (const [file, pem] of Object.entries(files)) await writeFile(new URL(file, directory), pem.endsWith("\n") ? pem : `${pem}\n`);
