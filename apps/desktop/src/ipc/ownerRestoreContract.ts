import {z} from "zod";
import {parseCanonicalAdmittedLiveUpdateMetadata, parseLiveDocumentKey, parseLiveUpdateReceipt, parseServerDerivedLiveUpdateAuthority} from "@dohc/live-session-contract/live-update-admission";
import {parseLiveObjectBinding} from "@dohc/live-session-contract/live-object-binding";

const id = z.string().min(1).max(512), digest = z.string().regex(/^[a-f0-9]{64}$/), integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
function parsed<T>(parse: (input: unknown) => T) {
  return z.unknown().transform((value, context) => {
    try {return parse(value);} catch {context.addIssue({code: "custom", message: "Invalid restore evidence."}); return z.NEVER;}
  });
}
const document = parsed(parseLiveDocumentKey), binding = parsed(parseLiveObjectBinding), receipt = parsed(parseLiveUpdateReceipt);
const authority = parsed(parseServerDerivedLiveUpdateAuthority);
export const OwnerRestorePhase = z.enum(["authority-invalidated", "fenced", "old-cut-applied", "native-fenced", "relay-admitted", "native-applied", "settled", "resumed", "declined"]);
export type OwnerRestorePhase = z.infer<typeof OwnerRestorePhase>;
export const OwnerRestoreIntent = z.object({
  deliveryKind: z.enum(["bootstrap", "owner"]), operationId: id, document, shareId: id, grantId: id,
  expectedGrantGeneration: integer.min(1), expectedDependentGrantIds: z.array(id), expectedFence: integer.min(1),
  restorePointCursor: integer, restorePointReceiptDigest: digest,
}).strict();
export const OwnerRestoreRecipient = z.object({grantId: id, principalKind: z.enum(["user", "email", "link"]), userId: id.nullable(), email: z.string().nullable()});
export const OwnerRestoreStatus = z.object({operationId: id, document, path: z.string(), phase: OwnerRestorePhase,
  intent: OwnerRestoreIntent, proposalDigest: digest.nullable()}).superRefine((status, context) => {
  const sameDocument = (Object.keys(status.document) as (keyof typeof status.document)[])
    .every(key => status.document[key] === status.intent.document[key]);
  if (status.operationId !== status.intent.operationId || !sameDocument) {
    context.addIssue({code: "custom", message: "The restore status belongs to another operation or file."});
  }
});
export const OwnerRestoreGrantCursor = z.object({shareCreatedAtMs: integer, shareId: id,
  grantCreatedAtMs: integer.nullable(), grantId: id.nullable()}).strict().refine(
    cursor => (cursor.grantCreatedAtMs === null) === (cursor.grantId === null), "Invalid restore grant cursor.");
export const OwnerRestoreOptions = z.object({document, path: z.string(),
  grants: z.array(OwnerRestoreRecipient.extend({shareId: id, generation: integer.min(1)})),
  points: z.array(z.object({cursor: integer, receivedAtMs: integer.nullable(), kind: z.enum(["baseline", "accepted"]), receiptDigest: digest,
    authority: authority.nullable()}).refine(point => (point.kind === "baseline") === (point.authority === null), "Invalid restore point author.")),
  authors: z.array(OwnerRestoreRecipient),
  nextBeforeCursor: integer.nullable(), nextGrantCursor: OwnerRestoreGrantCursor.nullable(), pendingOperation: z.object({operationId: id, phase: OwnerRestorePhase, proposalDigest: digest.nullable()}).nullable(),
});
export const OwnerRestorePlan = z.object({intent: OwnerRestoreIntent, path: z.string(), recipients: z.array(OwnerRestoreRecipient)});
export const OwnerUnfinishedRestores = z.object({
  restores: z.array(z.object({operationId: id, path: z.string().min(1).max(4096), phase: OwnerRestorePhase, proposalDigest: digest.nullable()})
    .refine(restore => restore.phase !== "resumed" && restore.phase !== "declined", "The restore has finished.")).max(50),
  // This page's restores the relay could not read.
  unreadable: integer.max(50),
  nextCursor: id.nullable(),
});
export type OwnerUnfinishedRestores = z.infer<typeof OwnerUnfinishedRestores>;
const priorCut = z.object({operationId: id, proposalDigest: digest, restoreJournalCursor: integer,
  selectedEventCount: integer, acceptedEventCount: integer, selectedTerminal: receipt.nullable(), frozenTerminal: receipt.nullable()});
export const OwnerRestoreReview = z.object({
  operationId: id, workspaceId: id, binding, proposalDigest: digest, candidateDigest: digest, recordedAtMs: integer,
  point: z.object({journalCursor: integer, receiptDigest: digest, markdownDigest: digest}).passthrough(),
  selectedPointReceivedAtMs: integer.max(8_640_000_000_000_000).nullable(), selectedPointAuthority: authority.nullable(),
  frozenTerminal: receipt.nullable(), selectedEventCount: integer, acceptedEventCount: integer,
  selectedHistoryDigest: digest, acceptedHistoryDigest: digest, nativeSourceManifestDigest: digest,
  content: z.object({frozenMarkdown: z.string(), restoredMarkdown: z.string(), frozenMarkdownDigest: digest,
    restoredMarkdownDigest: digest, frozenMarkdownByteLength: integer, restoredMarkdownByteLength: integer}),
  acceptedEvents: z.array(z.object({metadata: parsed(parseCanonicalAdmittedLiveUpdateMetadata), restoreOperationId: id.nullable()})),
  priorRestoreCuts: z.array(priorCut),
  nativeSources: z.array(z.object({
    source: z.object({deliveryId: id, updateDigest: digest}).passthrough(), acceptedReceipt: receipt.nullable(),
    acceptedRelation: z.enum(["at-or-before-selected", "after-selected", "not-relay-accepted"]),
    occurrences: z.array(z.object({operationId: id, proposalDigest: digest, context: z.enum(["current-fence", "prior-restore"]), acceptedReceipt: receipt.nullable()})),
  })),
}).refine(review => (review.point.journalCursor === 0) === (review.selectedPointReceivedAtMs === null), "Invalid restore point time.")
  .refine(review => (review.point.journalCursor === 0) === (review.selectedPointAuthority === null), "Invalid restore point author.");
export type OwnerRestoreReview = z.infer<typeof OwnerRestoreReview>;
export type OwnerRestoreOptions = z.infer<typeof OwnerRestoreOptions>;
export type OwnerRestorePlan = z.infer<typeof OwnerRestorePlan>;
export type OwnerRestoreStatus = z.infer<typeof OwnerRestoreStatus>;
const scope = {workspaceId: id};
export const OwnerRestoreRequest = z.discriminatedUnion("action", [
  z.object({...scope, action: z.literal("options"), path: z.string().min(1).max(4096), beforeCursor: integer.min(1).optional(), grantCursor: OwnerRestoreGrantCursor.optional()}).strict(),
  z.object({...scope, action: z.literal("plan"), document, shareId: id, grantId: id, restorePointCursor: integer, restorePointReceiptDigest: digest}).strict(),
  z.object({...scope, action: z.literal("begin"), intent: OwnerRestoreIntent}).strict(),
  z.object({...scope, action: z.literal("unfinished"), after: id.optional()}).strict(),
  z.object({...scope, action: z.enum(["status", "prepare", "review", "decline"]), operationId: id}).strict(),
  z.object({...scope, action: z.literal("confirm"), operationId: id, proposalDigest: digest}).strict(),
]);
export type OwnerRestoreRequest = z.infer<typeof OwnerRestoreRequest>;
// A full workspace on the server is the one cause the relay names.
const pending = z.object({kind: z.enum(["pending", "review-required"]), cause: z.literal("quota").optional()});
export const OwnerRestoreActionResponse = {
  options: OwnerRestoreOptions,
  plan: OwnerRestorePlan,
  begin: OwnerRestoreStatus,
  status: OwnerRestoreStatus,
  // Refused: the server would not record the answer that ends the restore.
  decline: z.object({status: OwnerRestoreStatus, result: z.object({kind: z.enum(["declined", "refused"])})}),
  unfinished: OwnerUnfinishedRestores,
  prepare: z.object({status: OwnerRestoreStatus, result: z.union([pending,
    z.object({kind: z.literal("prepared"), proposalDigest: digest, candidateDigest: digest, recordedAtMs: integer, replayed: z.boolean()})])}),
  review: z.object({status: OwnerRestoreStatus, result: z.union([OwnerRestoreReview, pending, z.null()])}),
  confirm: z.object({status: OwnerRestoreStatus, result: z.union([pending,
    z.object({kind: z.literal("resumed"), proposalDigest: digest, receipt: z.unknown()})])}),
};
export type OwnerRestoreAction = keyof typeof OwnerRestoreActionResponse;
export type OwnerRestoreResult<Action extends OwnerRestoreAction = OwnerRestoreAction> = z.infer<(typeof OwnerRestoreActionResponse)[Action]>;
