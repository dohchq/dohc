// Cross-engine parity fixture generator (R08).
//
// Produces byte-exact fixtures using the SAME Node crypto primitives used by
// the frozen TypeScript oracle. The Rust `dohc-engine-crypto` crate decrypts
// these and — because AES-256-GCM is deterministic given key+IV+AAD+plaintext —
// re-encrypts with the SAME recorded IV and asserts the ciphertext+tag bytes
// match, proving cross-engine AEAD parity against a REAL TS-produced artifact
// (not the Rust engine's own output).
//
// Regenerate: `node crates/dohc-engine-crypto/tests/fixtures/generate.mjs`.
// The committed JSON is the checked-in oracle; this script documents its origin.

import { createCipheriv, scryptSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// --- secret AEAD parity (secretFileStore.ts encryptSecretText) -------------
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
// Same key + IV + plaintext but a DIFFERENT path — proves the AAD binds the
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

// --- key-envelope parity (secretKeyEnvelope.ts wrapWorkspaceDataKey) --------
const ENVELOPE_FORMAT = "dohc-key-envelope-v1";
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
function envAad(workspaceId) {
  return Buffer.from(`${ENVELOPE_FORMAT}\0${workspaceId}`, "utf8");
}
function wrapDataKey(dataKeyHex, passphrase, workspaceId, saltHex, ivHex) {
  const dataKey = Buffer.from(dataKeyHex, "hex");
  const salt = Buffer.from(saltHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const kek = scryptSync(passphrase, salt, 32, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(envAad(workspaceId));
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  const envelope = {
    format: ENVELOPE_FORMAT,
    saltBase64: salt.toString("base64"),
    scryptN: SCRYPT_N,
    scryptR: SCRYPT_R,
    scryptP: SCRYPT_P,
    ivBase64: iv.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
  };
  return JSON.stringify(envelope);
}

const passphrase = "correct horse battery staple";
const envWorkspaceId = "ws_envelope_01";
const envSaltHex = "0f0e0d0c0b0a09080706050403020100";
const envIvHex = "fedcba9876543210fedcba98";
const envelopeJson = wrapDataKey(
  dataKeyHex,
  passphrase,
  envWorkspaceId,
  envSaltHex,
  envIvHex,
);

writeFileSync(
  join(here, "ts_key_envelope.json"),
  `${JSON.stringify(
    {
      passphrase,
      workspaceId: envWorkspaceId,
      dataKeyHex,
      scryptN: SCRYPT_N,
      scryptR: SCRYPT_R,
      scryptP: SCRYPT_P,
      envelopeJson,
    },
    null,
    2,
  )}\n`,
);

console.log("wrote ts_secret_ciphertext.json + ts_key_envelope.json");
