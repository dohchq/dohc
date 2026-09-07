// Cross-engine parity fixture generator.
//
// Produces byte-exact fixtures using the same Node crypto primitives used by
// the frozen TypeScript oracle. The Rust `dohc-engine-crypto` crate decrypts
// these and — because AES-256-GCM is deterministic given key+IV+AAD+plaintext —
// re-encrypts with the same recorded IV and asserts the ciphertext+tag bytes
// match, proving cross-engine AEAD parity against a REAL TS-produced artifact
// (not the Rust engine's own output).
//
// Regenerate: `node crates/dohc-engine-crypto/tests/fixtures/generate.mjs`.
// The committed JSON is the checked-in oracle; this script documents its origin.

import { createCipheriv } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// --- secret AEAD parity (encryptSecretText) --------------------------------
const SECRET_AAD_PREFIX = "dohc-secret-v1";
function secretAad(workspaceId, path) {
  return Buffer.from(`${SECRET_AAD_PREFIX}\0${workspaceId}\0${path}`, "utf8");
}
function encryptSecret(keyHex, workspaceId, path, ivHex, text) {
  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(secretAad(workspaceId, path));
  const plaintext = Buffer.from(text, "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ivBase64: iv.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    byteLength: plaintext.length,
  };
}

// Fixed key + IVs so the fixture is deterministic and reviewable.
const dataKeyHex =
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const workspaceId = "ws_parity_01";
const pathA = ".env";
const pathB = "config/.env.local";
const plaintext = "API_KEY=sk-live-parity-\u{1f510}\nDB_URL=postgres://localhost/dohc\n";
const ivHex = "aa11bb22cc33dd44ee55ff66"; // 12 bytes

const entryA = {
  label: "secret-aead-path-a",
  dataKeyHex,
  workspaceId,
  path: pathA,
  ivHex,
  plaintext,
  ...encryptSecret(dataKeyHex, workspaceId, pathA, ivHex, plaintext),
};
// Same key + IV + plaintext but a different path — proves the AAD binds the
// path: the tag differs, and decrypting entryA's ciphertext under pathB's AAD
// must fail closed on the Rust side.
const entryB = {
  label: "secret-aead-path-b",
  dataKeyHex,
  workspaceId,
  path: pathB,
  ivHex,
  plaintext,
  ...encryptSecret(dataKeyHex, workspaceId, pathB, ivHex, plaintext),
};
// Empty plaintext edge (0-byte file): GCM still emits a 16-byte tag.
const emptyIvHex = "112233445566778899aabbcc";
const entryEmpty = {
  label: "secret-aead-empty",
  dataKeyHex,
  workspaceId,
  path: pathA,
  ivHex: emptyIvHex,
  plaintext: "",
  ...encryptSecret(dataKeyHex, workspaceId, pathA, emptyIvHex, ""),
};

writeFileSync(
  join(here, "ts_secret_ciphertext.json"),
  `${JSON.stringify({ entries: [entryA, entryB, entryEmpty] }, null, 2)}\n`,
);

console.log("wrote ts_secret_ciphertext.json");
