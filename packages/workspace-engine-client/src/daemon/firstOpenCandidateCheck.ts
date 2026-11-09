import { FIRST_OPEN_CANDIDATE_REFUSALS, type FirstOpenCandidateRefusal } from "@dohc/workspace-contracts/first-open";

/** `dohc_engine_collab::limits::MAX_PUBLIC_MARKDOWN_BYTES`. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
/** `dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES`. */
const MAX_UPDATE_BYTES = 20 * 1024 * 1024;

/** What the relay declares about one candidate. The engine's answer repeats it. */
export interface FirstOpenCandidateBinding {
  readonly objectId: string;
  readonly path: string;
  readonly sourceMomentId: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: number;
  readonly candidateSha256: string;
  readonly candidateByteLength: number;
  readonly replicationEpoch: string;
  readonly streamIdentity: string;
  readonly maxFullStateBytes: number;
}

/** A candidate the relay built and the verified ordinary file it must settle to. */
export interface FirstOpenCandidateInput {
  readonly objectId: string;
  readonly path: string;
  readonly sourceMomentId: string;
  readonly replicationEpoch: string;
  readonly streamIdentity: string;
  readonly source: Uint8Array;
  readonly sourceSha256: string;
  readonly candidate: Uint8Array;
  readonly candidateSha256: string;
  readonly maxFullStateBytes: number;
}

const isRefusal = (value: unknown): value is FirstOpenCandidateRefusal => (FIRST_OPEN_CANDIDATE_REFUSALS as readonly unknown[]).includes(value);

/**
 * The engine's verdict. The full-state digest names the encoding measured
 * during the check; a later encoding need not repeat its bytes.
 */
export type FirstOpenCandidateCheck = { readonly contractVersion: 1; readonly binding: FirstOpenCandidateBinding } & (
  | { readonly status: "checked"; readonly settledSourceSha256: string; readonly settledSourceByteLength: number;
      readonly fullStateSha256: string; readonly fullStateByteLength: number }
  | { readonly status: "refused"; readonly cause: FirstOpenCandidateRefusal }
  | { readonly status: "too-large"; readonly bound: "full-state-encoding"; readonly limit: number });

const bindingKeys = ["objectId", "path", "sourceMomentId", "sourceSha256", "sourceByteLength", "candidateSha256",
  "candidateByteLength", "replicationEpoch", "streamIdentity", "maxFullStateBytes"] as const;
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const isInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 4096 && !value.includes("\0");

/** The binding for `input`, refused before anything is sent when a declared bound fails. */
export function firstOpenCandidateBinding(input: FirstOpenCandidateInput): FirstOpenCandidateBinding {
  const { objectId, path, sourceMomentId, replicationEpoch, streamIdentity, source, sourceSha256, candidate, candidateSha256, maxFullStateBytes } = input;
  if (![objectId, path, sourceMomentId, replicationEpoch, streamIdentity].every(isText) || !isDigest(sourceSha256) || !isDigest(candidateSha256) ||
      !(source instanceof Uint8Array) || source.byteLength > MAX_SOURCE_BYTES ||
      !(candidate instanceof Uint8Array) || candidate.byteLength < 2 || candidate.byteLength > MAX_UPDATE_BYTES ||
      !isInteger(maxFullStateBytes, 2, MAX_UPDATE_BYTES)) {
    throw new TypeError("Invalid first-open candidate bounds.");
  }
  return Object.freeze({ objectId, path, sourceMomentId, sourceSha256, sourceByteLength: source.byteLength, candidateSha256,
    candidateByteLength: candidate.byteLength, replicationEpoch, streamIdentity, maxFullStateBytes });
}

/** What the client reserves for one check's upload: its bundle and the request around it. */
export function firstOpenCandidateUploadBytes(binding: FirstOpenCandidateBinding): number {
  return binding.candidateByteLength + binding.sourceByteLength + 3 * 1024 * 1024;
}

/** The engine answered about another candidate or source, or out of its exact shape. */
export class InvalidFirstOpenCandidateCheck extends TypeError {
  constructor() { super("Invalid first-open candidate check."); }
}

/** Accepts only an answer about exactly `binding`, in the engine's exact shape. */
export function parseFirstOpenCandidateCheck(value: unknown, binding: FirstOpenCandidateBinding): FirstOpenCandidateCheck {
  const invalid = (): never => { throw new InvalidFirstOpenCandidateCheck(); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const row = value as Record<string, unknown>, echoed = row.binding as Record<string, unknown> | null;
  if (row.contractVersion !== 1 || !echoed || typeof echoed !== "object" || Array.isArray(echoed) ||
      Object.keys(echoed).sort().join() !== [...bindingKeys].sort().join() || bindingKeys.some(key => echoed[key] !== binding[key])) return invalid();
  const keys = Object.keys(row).sort().join();
  switch (row.status) {
    case "checked":
      // The engine answers checked only for the file's exact bytes.
      if (keys !== "binding,contractVersion,fullStateByteLength,fullStateSha256,settledSourceByteLength,settledSourceSha256,status" ||
          row.settledSourceSha256 !== binding.sourceSha256 || row.settledSourceByteLength !== binding.sourceByteLength ||
          !isDigest(row.fullStateSha256) || !isInteger(row.fullStateByteLength, 2, binding.maxFullStateBytes)) return invalid();
      return { status: "checked", contractVersion: 1, binding, settledSourceSha256: row.settledSourceSha256,
        settledSourceByteLength: row.settledSourceByteLength, fullStateSha256: row.fullStateSha256, fullStateByteLength: row.fullStateByteLength };
    case "refused":
      if (keys !== "binding,cause,contractVersion,status" || !isRefusal(row.cause)) return invalid();
      return { status: "refused", contractVersion: 1, binding, cause: row.cause };
    case "too-large":
      if (keys !== "binding,bound,contractVersion,limit,status" || row.bound !== "full-state-encoding" || row.limit !== binding.maxFullStateBytes) return invalid();
      return { status: "too-large", contractVersion: 1, binding, bound: "full-state-encoding", limit: binding.maxFullStateBytes };
    default:
      return invalid();
  }
}
