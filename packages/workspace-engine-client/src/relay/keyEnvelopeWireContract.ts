import { ProtocolShapeError, mutableStruct } from "../wireSchema";
import type { KeyEnvelopeDownloadResult, KeyEnvelopeUploadResult } from "@dohc/workspace-contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { JsonValue } from "../protocol";

export type { KeyEnvelopeDownloadResult, KeyEnvelopeUploadResult } from "@dohc/workspace-contracts";

export const KEY_ENVELOPE_METHOD = {
  upload: "keys.upload",
  download: "keys.download",
} as const;

export type KeyEnvelopeMethod =
  (typeof KEY_ENVELOPE_METHOD)[keyof typeof KEY_ENVELOPE_METHOD];

export type KeyEnvelopeMethodResultMap = {
  [KEY_ENVELOPE_METHOD.upload]: KeyEnvelopeUploadResult;
  [KEY_ENVELOPE_METHOD.download]: KeyEnvelopeDownloadResult;
};

const KeyEnvelopeResultSchemas = {
  [KEY_ENVELOPE_METHOD.upload]: mutableStruct({
    etag: Schema.String,
  }),
  [KEY_ENVELOPE_METHOD.download]: mutableStruct({
    envelopeJson: Schema.String,
    etag: Schema.String,
  }),
} as const;

export function decodeKeyEnvelopeResult<M extends KeyEnvelopeMethod>(
  method: M,
  value: JsonValue,
): KeyEnvelopeMethodResultMap[M] {
  const schema = KeyEnvelopeResultSchemas[method];
  if (schema === undefined) {
    throw new ProtocolShapeError(
      `Unsupported key-envelope method: ${method}`,
    );
  }
  const decoded = Schema.decodeUnknownResult(schema)(value);
  if (Result.isFailure(decoded)) {
    throw new ProtocolShapeError(
      `${method} result: ${decoded.failure.message}`,
    );
  }
  return decoded.success as KeyEnvelopeMethodResultMap[M];
}
