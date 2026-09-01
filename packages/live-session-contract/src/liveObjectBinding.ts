/// <reference types="node" />

import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { validateUserWritePath } from "@dohc/workspace-core/paths";

export const LIVE_OBJECT_BINDING_IDENTIFIER_MAX_BYTES = 512;
export const LIVE_OBJECT_BINDING_PATH_MAX_BYTES = 1_024;
export const LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT = 100;

const LIVE_OBJECT_BINDING_FIELDS = [
  "workspaceId",
  "mainVersionId",
  "objectId",
  "lineageClaimId",
  "currentPath",
  "selectorPaths",
  "restoreFenceGeneration",
] as const;

export interface LiveObjectBinding {
  readonly workspaceId: string;
  readonly mainVersionId: string;
  readonly objectId: string;
  readonly lineageClaimId: string;
  readonly currentPath: string;
  readonly selectorPaths: readonly string[];
  readonly restoreFenceGeneration: number;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("LiveObjectBinding must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== LIVE_OBJECT_BINDING_FIELDS.length ||
    keys.some(
      (key) =>
        !(LIVE_OBJECT_BINDING_FIELDS as readonly string[]).includes(key),
    )
  ) {
    throw new TypeError("LiveObjectBinding must contain exactly its seven fields.");
  }
  return candidate;
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function hasAsciiControlByte(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function identifier(
  value: Record<string, unknown>,
  field: (typeof LIVE_OBJECT_BINDING_FIELDS)[number],
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    !isWellFormedUtf16(candidate) ||
    utf8Bytes(candidate).byteLength > LIVE_OBJECT_BINDING_IDENTIFIER_MAX_BYTES ||
    hasAsciiControlByte(candidate)
  ) {
    throw new TypeError(`${field} is not a valid live-object identifier.`);
  }
  return candidate;
}

function normalizedPath(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string.`);
  }
  if (!isWellFormedUtf16(value)) {
    throw new TypeError(`${field} is not a tracked workspace path.`);
  }
  const validated = validateUserWritePath(value);
  if (!validated.ok) {
    throw new TypeError(`${field} is not a tracked workspace path.`);
  }
  const normalized = validated.normalized;
  if (
    normalized.length === 0 ||
    utf8Bytes(normalized).byteLength > LIVE_OBJECT_BINDING_PATH_MAX_BYTES ||
    hasAsciiControlByte(normalized) ||
    classifyEngineFilePath(normalized).kind !== "tracked"
  ) {
    throw new TypeError(`${field} is not a tracked workspace path.`);
  }
  return normalized;
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8Bytes(left);
  const rightBytes = utf8Bytes(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function parseLiveObjectBinding(value: unknown): LiveObjectBinding {
  const candidate = record(value);
  const rawSelectorPaths = candidate.selectorPaths;
  if (
    !Array.isArray(rawSelectorPaths) ||
    rawSelectorPaths.length === 0 ||
    rawSelectorPaths.length > LIVE_OBJECT_BINDING_SELECTOR_PATH_MAX_COUNT
  ) {
    throw new TypeError("selectorPaths must contain from 1 through 100 paths.");
  }

  const selectorPaths = [
    ...new Set(
      Array.from(rawSelectorPaths, (path) =>
        normalizedPath(path, "selectorPaths"),
      ),
    ),
  ].sort(compareUtf8);

  const restoreFenceGeneration = candidate.restoreFenceGeneration;
  if (
    typeof restoreFenceGeneration !== "number" ||
    !Number.isSafeInteger(restoreFenceGeneration) ||
    restoreFenceGeneration < 0
  ) {
    throw new TypeError(
      "restoreFenceGeneration must be a non-negative safe integer.",
    );
  }

  return {
    workspaceId: identifier(candidate, "workspaceId"),
    mainVersionId: identifier(candidate, "mainVersionId"),
    objectId: identifier(candidate, "objectId"),
    lineageClaimId: identifier(candidate, "lineageClaimId"),
    currentPath: normalizedPath(candidate.currentPath, "currentPath"),
    selectorPaths,
    restoreFenceGeneration,
  };
}
