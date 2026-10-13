import * as Schema from "effect/Schema";

export const MAX_FILE_RESOLVE_TARGETS = 128;
export const MAX_FILE_RESOLVE_BYTES = 48 * 1024;
export type FileResolveTarget = { path: string } | { objectId: string };
const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const Resolution = Schema.Union([
  Schema.Struct({ status: Schema.Literal("found"), objectId: NonEmpty, path: NonEmpty }),
  Schema.Struct({ status: Schema.Literal("absent") }),
  Schema.Struct({ status: Schema.Literal("invalid") }),
]);
const Result = Schema.Struct({ versionId: NonEmpty, results: Schema.Array(Resolution) });
export type FileResolution = typeof Resolution.Type;
export type FileResolveResult = typeof Result.Type;
export const decodeFileResolveResult = Schema.decodeUnknownSync(Result);
