import type {
  KeyEnvelopeDownloadParams,
  KeyEnvelopeDownloadResult,
  KeyEnvelopeUploadParams,
  KeyEnvelopeUploadResult,
} from "@dohc/workspace-contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
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

const KeyEnvelopeResultSchemas = {
  [KEY_ENVELOPE_METHOD.upload]: Schema.Struct({
    etag: Schema.String,
  }).mapFields(Struct.map(Schema.mutableKey)),
  [KEY_ENVELOPE_METHOD.download]: Schema.Struct({
    envelopeJson: Schema.String,
    etag: Schema.String,
  }).mapFields(Struct.map(Schema.mutableKey)),
} as const;

export function decodeKeyEnvelopeResult<M extends KeyEnvelopeMethod>(
  method: M,
  value: JsonValue,
): KeyEnvelopeMethodResultMap[M] {
  const schema = KeyEnvelopeResultSchemas[method];
  if (schema === undefined) {
    throw new KeyEnvelopeProtocolShapeError(
      `Unsupported key-envelope method: ${method}`,
    );
  }
  const decoded = Schema.decodeUnknownResult(schema)(value);
  if (Result.isFailure(decoded)) {
    throw new KeyEnvelopeProtocolShapeError(
      `${method} result: ${decoded.failure.message}`,
    );
  }
  return decoded.success as KeyEnvelopeMethodResultMap[M];
}
