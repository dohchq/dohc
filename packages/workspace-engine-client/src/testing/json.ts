// Request-shape and byte helpers shared by the loopback engines.
import { createHash } from "node:crypto";
import type { JsonValue } from "../protocol";
import type { JsonObject } from "../ydoc/ydocWireContract";

export function asObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export function requiredString(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} is invalid.`);
  return value;
}

export function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("invalid-parameters");
  return value;
}

export function sha256(value: string | Uint8Array | number[]): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : Uint8Array.from(value))
    .digest("hex");
}

export function encodeBase64(bytes: Uint8Array | number[]): string {
  return Buffer.from(bytes).toString("base64");
}

// Refuses non-canonical input the way serde's base64 decoder does.
export function decodeBase64(value: string): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, "base64"));
  if (encodeBase64(bytes) !== value) throw new Error("invalid-input");
  return bytes;
}
