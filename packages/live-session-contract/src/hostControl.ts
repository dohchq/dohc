export const HOST_MODE_VALUES = ["device", "service"] as const;
export type HostMode = (typeof HOST_MODE_VALUES)[number];

declare const hostEpochBrand: unique symbol;
export type HostEpoch = number & { readonly [hostEpochBrand]: "HostEpoch" };

declare const hostTransitionGenerationBrand: unique symbol;
export type HostTransitionGeneration = number & {
  readonly [hostTransitionGenerationBrand]: "HostTransitionGeneration";
};

export type HostAdmissionState = "closed" | "open" | "draining";
export type HostTransitionPhase = "draining" | "activating";

export const HOST_CONTROL_IDENTIFIER_MAX_BYTES = 1_024;

export interface HostTransitionRecord {
  readonly phase: HostTransitionPhase;
  readonly transitionGeneration: HostTransitionGeneration;
  readonly transitionId: string;
  readonly fromMode: HostMode;
  readonly fromHostId: string;
  readonly fromInstanceId: string;
  readonly fromConnectionId: string;
  readonly fromEpoch: HostEpoch;
  readonly toMode: HostMode;
  readonly toHostId: string;
  readonly startedAtMs: number;
}

export interface HostControlSnapshot {
  readonly configuredMode: HostMode;
  readonly configuredHostId: string;
  readonly hostEpoch: HostEpoch;
  readonly admissionState: HostAdmissionState;
  readonly registeredInstanceId: string | null;
  readonly registeredConnectionId: string | null;
  readonly updatedAtMs: number;
  readonly lastTransitionGeneration: HostTransitionGeneration | null;
  readonly lastCompletedTransitionId: string | null;
  readonly transition: HostTransitionRecord | null;
}

export function parseHostMode(value: unknown): HostMode {
  if (value === "device" || value === "service") return value;
  throw new TypeError("host mode must be device or service");
}

export function parseHostEpoch(value: unknown): HostEpoch {
  return parsePositiveSafeInteger(value, "host epoch") as HostEpoch;
}

export function nextHostEpoch(epoch: HostEpoch): HostEpoch {
  return nextPositiveSafeInteger(epoch, "host epoch") as HostEpoch;
}

export function parseHostTransitionGeneration(
  value: unknown,
): HostTransitionGeneration {
  return parsePositiveSafeInteger(
    value,
    "host transition generation",
  ) as HostTransitionGeneration;
}

export function nextHostTransitionGeneration(
  generation: HostTransitionGeneration,
): HostTransitionGeneration {
  return nextPositiveSafeInteger(
    generation,
    "host transition generation",
  ) as HostTransitionGeneration;
}

export function parseHostControlIdentifier(
  value: unknown,
  name = "host control identifier",
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      throw new TypeError(`${name} must not contain ASCII control characters`);
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new TypeError(`${name} must contain well-formed UTF-16`);
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${name} must contain well-formed UTF-16`);
    }
  }
  if (
    new TextEncoder().encode(value).byteLength > HOST_CONTROL_IDENTIFIER_MAX_BYTES
  ) {
    throw new RangeError(`${name} must be at most 1024 UTF-8 bytes`);
  }
  return value;
}

function parsePositiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function nextPositiveSafeInteger(value: number, name: string): number {
  const parsed = parsePositiveSafeInteger(value, name);
  if (parsed === Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${name} is exhausted`);
  }
  return parsed + 1;
}
