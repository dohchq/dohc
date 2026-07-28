import type {
  KeyEnvelopeDownloadParams,
  KeyEnvelopeDownloadResult,
  KeyEnvelopeUploadParams,
  KeyEnvelopeUploadResult,
} from "@dohc/workspace-contracts";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";

export type {
  KeyEnvelopeDownloadParams,
  KeyEnvelopeDownloadResult,
  KeyEnvelopeUploadParams,
  KeyEnvelopeUploadResult,
} from "@dohc/workspace-contracts";

export const KEY_ENVELOPE_METHOD = {
  upload: "keys.upload",
  download: "keys.download",
} as const;

export type KeyEnvelopeMethod =
  (typeof KEY_ENVELOPE_METHOD)[keyof typeof KEY_ENVELOPE_METHOD];

export type KeyEnvelopeMethodParamsMap = {
  [KEY_ENVELOPE_METHOD.upload]: KeyEnvelopeUploadParams;
  [KEY_ENVELOPE_METHOD.download]: KeyEnvelopeDownloadParams;
};

export type KeyEnvelopeMethodResultMap = {
  [KEY_ENVELOPE_METHOD.upload]: KeyEnvelopeUploadResult;
  [KEY_ENVELOPE_METHOD.download]: KeyEnvelopeDownloadResult;
};

export class KeyEnvelopeProtocolShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyEnvelopeProtocolShapeError";
  }
}

function resultRecord(
  value: JsonValue,
  label: string,
): Record<string, JsonValue | undefined> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new KeyEnvelopeProtocolShapeError(`${label} must be an object.`);
  }
  return value;
}

function stringField(
  record: Record<string, JsonValue | undefined>,
  field: string,
  label: string,
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new KeyEnvelopeProtocolShapeError(
      `${label}.${field} must be a string.`,
    );
  }
  return value;
}

export function decodeKeyEnvelopeResult<M extends KeyEnvelopeMethod>(
  method: M,
  value: JsonValue,
): KeyEnvelopeMethodResultMap[M] {
  const result = resultRecord(value, `${method} result`);
  switch (method) {
    case KEY_ENVELOPE_METHOD.upload:
      return {
        etag: stringField(result, "etag", `${method} result`),
      } as KeyEnvelopeMethodResultMap[M];
    case KEY_ENVELOPE_METHOD.download:
      return {
        envelopeJson: stringField(
          result,
          "envelopeJson",
          `${method} result`,
        ),
        etag: stringField(result, "etag", `${method} result`),
      } as KeyEnvelopeMethodResultMap[M];
  }
}
