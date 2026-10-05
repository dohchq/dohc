import { z } from "zod";
import type { ChangeAuthor } from "@dohc/workspace-contracts/engine";
import type { PreparedSetBatch, SetBatchLookup, SetBatchPlan, SetBatchReceipt, SetBatchReference } from "@dohc/workspace-engine-client";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { RunWrite, StoredRun, StoredStep } from "./automationRunStore";

export interface AutomationSetBatches {
  prepare(plan: SetBatchPlan): Promise<PreparedSetBatch>;
  submit(plan: SetBatchPlan, digest: string, author: ChangeAuthor, signal: AbortSignal): Promise<SetBatchReceipt>;
  lookup(reference: SetBatchReference): Promise<SetBatchLookup>;
  wait(receipts: SetBatchReference[]): Promise<void>;
}

const json = z.custom<JsonValue>(value => value !== undefined);
export const StoredSetBatchSchema = z.object({
  part: z.number().int().nonnegative(), count: z.number().int().positive(),
  digest: z.string(), abandoned: z.boolean().optional(), borrowed: z.boolean().optional(),
  plan: z.object({
    key: z.object({ claimId: z.string(), keySeed: z.string(), step: z.number().int().nonnegative(), batch: z.string() }),
    versionId: z.string(),
    records: z.array(z.object({ collectionId: z.string(), recordId: z.string(),
      fields: z.array(z.object({ field: z.string(), before: json, after: json })),
      binding: z.object({ objectId: z.string(), lineageClaimId: z.string().nullable(), restoreGeneration: z.number().int().nullable(), schemaSha256: z.string() }).nullable(),
    })),
  }),
});
export type StoredSetBatch = z.infer<typeof StoredSetBatchSchema>;

export function sameBatchKey(a: SetBatchReference["key"], b: SetBatchReference["key"]): boolean {
  return a.claimId === b.claimId && a.keySeed === b.keySeed && a.step === b.step && a.batch === b.batch;
}

export function batchWrites(batch: StoredSetBatch, receipt: SetBatchReceipt | null, step: StoredStep): RunWrite[][] {
  if (receipt && (receipt.digest !== batch.digest || !sameBatchKey(receipt.key, batch.plan.key) || receipt.records.length !== batch.count)) {
    throw new Error("The engine's Set receipt does not match this run's saved batch.");
  }
  return Array.from({ length: batch.count }, (_, index) => {
    const effect = step.effects[batch.part + index];
    const record = receipt?.records[index];
    if (effect?.kind !== "set" || (record && record.recordId !== effect.target.recordId)) throw new Error("The saved Set batch does not match its step.");
    if (!record) return [];
    if (record.path === null) return [{ kind: "skipped", recordId: record.recordId, path: effect.target.path, reason: "The record is no longer in the Collection." }];
    const path = record.path;
    return record.fields.flatMap((field): RunWrite[] => field.state === "changed"
      ? [{ kind: "field", recordId: record.recordId, path, field: field.field, before: field.before, after: field.after }]
      : field.state === "kept" ? [{ kind: "kept", recordId: record.recordId, path, field: field.field,
        planned: effect.fields.find(planned => planned.field === field.field)!.after, current: field.current }] : []);
  });
}

/** Fence every saved key before Undo or a terminal outcome can use its changes. */
export async function reconcileSetBatches(run: StoredRun, lookup: AutomationSetBatches["lookup"]): Promise<StoredRun> {
  const recovered = structuredClone(run);
  let offset = 0;
  for (const step of recovered.steps) {
    for (const batch of step.batches ?? []) {
      if (batch.abandoned) continue;
      let result: SetBatchLookup;
      try { result = await lookup({ key: batch.plan.key, digest: batch.digest }); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("automation-set-batch-key-reused")) throw error;
        batch.abandoned = true;
        batch.borrowed = true;
        continue;
      }
      if (result.state === "retired") throw new Error("This automation run has left run history.");
      if (result.state !== "committed") {
        batch.abandoned = true;
        batch.borrowed = true;
        continue;
      }
      const writes = batchWrites(batch, result.receipt, step);
      for (const [part, own] of writes.entries()) {
        const index = offset + batch.part + part;
        recovered.applied[index] = { ...recovered.applied[index], ordinal: step.ordinal, writes: own, writeCount: 1 };
      }
    }
    offset += step.effects.length;
  }
  // Non-Set effects retain their single-effect recovery boundary.
  recovered.applied = recovered.applied.filter(entry => entry !== undefined);
  return recovered;
}

export async function receiptRuns(runs: readonly StoredRun[], lookup?: AutomationSetBatches["lookup"]): Promise<StoredRun[]> {
  if (!runs.some(run => run.steps.some(step => step.batches?.length))) return [...runs];
  if (!lookup) throw new Error("The workspace engine is not running.");
  return Promise.all(runs.map(run => reconcileSetBatches(run, lookup)));
}
