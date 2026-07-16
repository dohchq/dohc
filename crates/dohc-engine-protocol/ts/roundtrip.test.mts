// TypeScript half of the cross-language round-trip proof. Consumes the same
// fixtures file as tests/fixtures.rs, the ts-rs generated types, and the
// schemars-generated JSON Schema + limits.
//
// Run from the crate root: node --test ts/
// (Node >= 22.18 runs .mts directly via type stripping; no dependencies.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Validator,
  canonicalJson,
  checkBounds,
  type SchemaObject,
  type WireLimitsJson,
} from "./schemaValidator.mts";
import type { Envelope } from "../generated/ts/Envelope";

const crateRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(join(crateRoot, "generated/engine-protocol.schema.json"), "utf8"),
) as SchemaObject;
const limitsDocument = JSON.parse(
  readFileSync(join(crateRoot, "generated/limits.json"), "utf8"),
) as { protocolVersion: number; maxWireInteger: number; limits: WireLimitsJson };
const fixtures = JSON.parse(
  readFileSync(join(crateRoot, "fixtures/envelopes.json"), "utf8"),
) as {
  protocolVersion: number;
  entries: { name: string; envelope: unknown; canonicalJson: string }[];
};

const validator = new Validator(schema);

test("fixture corpus is present and versioned", () => {
  assert.equal(fixtures.protocolVersion, limitsDocument.protocolVersion);
  assert.ok(fixtures.entries.length >= 8);
});

test("every fixture validates against the generated schema", () => {
  for (const entry of fixtures.entries) {
    const errors = validator.validate(entry.envelope);
    assert.deepEqual(errors, [], `fixture ${entry.name} failed schema validation`);
  }
});

test("every fixture round-trips to the Rust canonical encoding", () => {
  for (const entry of fixtures.entries) {
    assert.ok(entry.canonicalJson.length > 0, `fixture ${entry.name} missing canonicalJson`);
    // TS re-encoding of the fixture value must byte-match what the typed
    // Rust structs produced.
    assert.equal(
      canonicalJson(entry.envelope),
      entry.canonicalJson,
      `fixture ${entry.name} canonical encoding drifted`,
    );
    // And parsing the canonical string yields the same value (true round
    // trip: text -> value -> text).
    const reparsed: unknown = JSON.parse(entry.canonicalJson);
    assert.equal(canonicalJson(reparsed), entry.canonicalJson);
    assert.deepEqual(reparsed, entry.envelope);
  }
});

test("generated types narrow envelopes by discriminant", () => {
  // Compile-time proof that the ts-rs union is usable; runtime assertions
  // keep it honest even without a typecheck step.
  for (const entry of fixtures.entries) {
    const envelope = entry.envelope as Envelope;
    switch (envelope.type) {
      case "request":
        assert.equal(typeof envelope.method, "string");
        assert.equal(typeof envelope.id, "number");
        break;
      case "event":
        assert.equal(typeof envelope.seq, "number");
        assert.equal(typeof envelope.name, "string");
        break;
      case "error":
        assert.equal(typeof envelope.error.code, "string");
        assert.equal(typeof envelope.error.retry, "string");
        break;
      case "helloAck":
        assert.equal(typeof envelope.limits.maxFrameBytes, "number");
        break;
      default:
        break;
    }
  }
});

test("every fixture is within the generated wire bounds", () => {
  for (const entry of fixtures.entries) {
    const errors = checkBounds(
      entry.envelope,
      limitsDocument.limits,
      limitsDocument.maxWireInteger,
    );
    assert.deepEqual(errors, [], `fixture ${entry.name} violates wire bounds`);
  }
});

test("nullable fields may be omitted and still validate", () => {
  const omitted = { type: "request", id: 9, method: "workspace.status", params: {} };
  assert.deepEqual(validator.validate(omitted), []);
  // Generated types agree: nullable fields are optional.
  const typed = omitted as Envelope & { type: "request" };
  assert.equal(typed.workspace ?? null, null);
  assert.equal(typed.deadlineMs ?? null, null);
});

test("nested batches are rejected by the generated schema", () => {
  const flat = {
    type: "batch",
    envelopes: [{ type: "cancel", id: 1 }],
  };
  assert.deepEqual(validator.validate(flat), []);
  const nested = {
    type: "batch",
    envelopes: [{ type: "batch", envelopes: [{ type: "cancel", id: 1 }] }],
  };
  assert.notDeepEqual(validator.validate(nested), [], "nested batch must fail");
});

test("fixed-width integer formats are range-checked", () => {
  const base = { type: "request", id: 1, method: "m", params: null };
  assert.deepEqual(validator.validate({ ...base, deadlineMs: 4294967295 }), []);
  assert.notDeepEqual(
    validator.validate({ ...base, deadlineMs: 4294967296 }),
    [],
    "u32 overflow must fail TS validation like Rust deserialization",
  );
  assert.notDeepEqual(validator.validate({ ...base, deadlineMs: 12.5 }), []);
  assert.notDeepEqual(validator.validate({ ...base, deadlineMs: -1 }), []);
});

test("the validator is not vacuous: corrupted envelopes fail", () => {
  const corrupted: unknown[] = [
    { type: "nope" },
    { type: "cancel" }, // missing id
    { type: "cancel", id: "42" }, // wrong primitive
    { type: "hello", protocolVersion: 1, capabilities: [], lastSessionGeneration: null }, // missing authToken
    { type: "event", seq: -1.5, sessionGeneration: 7, name: "x", payload: null }, // non-integer seq
    null,
    [],
  ];
  for (const value of corrupted) {
    assert.notDeepEqual(
      validator.validate(value),
      [],
      `expected validation failure for ${JSON.stringify(value)}`,
    );
  }
});

test("the bounds walker is not vacuous: oversized values fail", () => {
  const limits = limitsDocument.limits;
  assert.notDeepEqual(
    checkBounds({ big: "x".repeat(limits.maxStringBytes + 1) }, limits, limitsDocument.maxWireInteger),
    [],
  );
  let deep: unknown = null;
  for (let i = 0; i <= limits.maxJsonDepth; i += 1) deep = [deep];
  assert.notDeepEqual(checkBounds(deep, limits, limitsDocument.maxWireInteger), []);
  assert.notDeepEqual(
    checkBounds({ n: limitsDocument.maxWireInteger + 1 }, limits, limitsDocument.maxWireInteger),
    [],
  );
});
