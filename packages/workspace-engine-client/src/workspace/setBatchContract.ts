import * as Schema from "effect/Schema";
import { mutableStruct } from "../wireSchema";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
import type { ChangeAttributionWire } from "../ydoc/ydocWireContract";

export interface SetBatchKey { claimId: string; keySeed: string; step: number; batch: string }
export interface SetBatchBinding { objectId: string; lineageClaimId: string | null; restoreGeneration: number | null; schemaSha256: string; headSha256: string }
export interface SetBatchPlan {
  key: SetBatchKey;
  versionId: string;
  records: Array<{ collectionId: string; recordId: string; fields: Array<{ field: string; before: JsonValue; after: JsonValue }>; binding: SetBatchBinding | null }>;
}
export interface PreparedSetBatch { plan: SetBatchPlan; digest: string; open: boolean[] }
export interface SetBatchReference { key: SetBatchKey; digest: string }
export interface SetBatchReceipt extends SetBatchReference {
  versionId: string;
  attribution: ChangeAttributionWire;
  records: Array<{ recordId: string; path: string | null; fields: Array<
    | { state: "changed"; field: string; before: JsonValue; after: JsonValue; historyId: number }
    | { state: "kept"; field: string; current: JsonValue }
    | { state: "unchanged"; field: string }
  > }>;
  jobs: string[];
  committedAtMs: number;
  writerMs: number;
}
export type SetBatchLookup = { state: "committed"; receipt: SetBatchReceipt } | { state: "abandoned" | "retired" };

const array = <S extends Schema.Top>(schema: S) => Schema.mutable(Schema.Array(schema));
export const SetBatchKeySchema = mutableStruct({ claimId: Schema.String, keySeed: Schema.String, step: Schema.Int, batch: Schema.String });
export const SetBatchPlanSchema = mutableStruct({
  key: SetBatchKeySchema, versionId: Schema.String,
  records: array(mutableStruct({ collectionId: Schema.String, recordId: Schema.String,
    fields: array(mutableStruct({ field: Schema.String, before: Schema.Unknown, after: Schema.Unknown })),
    binding: Schema.NullOr(mutableStruct({ objectId: Schema.String, lineageClaimId: Schema.NullOr(Schema.String), restoreGeneration: Schema.NullOr(Schema.Int), schemaSha256: Schema.String, headSha256: Schema.String })),
  })),
});
export const PreparedSetBatchSchema = mutableStruct({ plan: SetBatchPlanSchema, digest: Schema.String, open: array(Schema.Boolean) });
export const SetBatchReceiptSchema = mutableStruct({
  key: SetBatchKeySchema, digest: Schema.String, versionId: Schema.String,
  attribution: Schema.Unknown,
  records: array(mutableStruct({ recordId: Schema.String, path: Schema.NullOr(Schema.String), fields: array(Schema.Union([
    mutableStruct({ state: Schema.Literal("changed"), field: Schema.String, before: Schema.Unknown, after: Schema.Unknown, historyId: Schema.Int }),
    mutableStruct({ state: Schema.Literal("kept"), field: Schema.String, current: Schema.Unknown }),
    mutableStruct({ state: Schema.Literal("unchanged"), field: Schema.String }),
  ])) })),
  jobs: array(Schema.String), committedAtMs: Schema.Int, writerMs: Schema.Number,
});
export const SetBatchLookupSchema = Schema.Union([
  mutableStruct({ state: Schema.Literal("committed"), receipt: SetBatchReceiptSchema }),
  mutableStruct({ state: Schema.Literal("abandoned") }),
  mutableStruct({ state: Schema.Literal("retired") }),
]);
export const SetBatchWaitSchema = mutableStruct({ settled: Schema.Boolean });
