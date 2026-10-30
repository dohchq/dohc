import {z} from "zod";
import {FIRST_OPEN_ACTIVATION_CODE, FIRST_OPEN_INTEGRITY_CODES, FIRST_OPEN_RECOVERIES, FIRST_OPEN_TOO_LARGE_CODES,
  FIRST_OPEN_UNSUPPORTED_CAUSES, firstOpenRecovery, type FirstOpenOutcome, type FirstOpenRefusal,
  type FirstOpenTemporaryStop} from "./firstOpen";

const identifier = z.string().min(1).max(512);
const source = z.object({workspaceId: identifier, objectId: identifier, path: z.string().min(1).max(1_024),
  sourceMomentId: identifier, sourceDigest: z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const base = z.object({source, recovery: z.enum(FIRST_OPEN_RECOVERIES)});
const receipt = z.object({originId: z.string().regex(/^service-host:first-open:[0-9a-f]{64}$/), originSeq: z.literal(0), relaySeq: z.number().int().positive().safe()}).strict();
const transient = z.enum(["contention", "busy", "reconfigured", "history-unavailable", "worker-failed", "storage-failed",
  "host-absent", "host-unreachable", "check-failed", "check-deadline"]);
const routeOutcome = z.union([
  base.extend({kind: z.enum(["published", "replayed"]), receipt}).strict(),
  base.extend({kind: z.literal("existing-history"), reason: z.literal("prior-authority")}).strict(),
  base.extend({kind: z.literal("refused"), reason: z.enum(["deletion", "stale-source"])}).strict(),
  base.extend({kind: z.literal("refused"), reason: z.literal("unsupported-source"), cause: z.enum(FIRST_OPEN_UNSUPPORTED_CAUSES)}).strict(),
  base.extend({kind: z.literal("refused"), reason: z.literal("too-large"), code: z.enum(FIRST_OPEN_TOO_LARGE_CODES)}).strict(),
  base.extend({kind: z.literal("unavailable"), reason: transient}).strict(),
  base.extend({kind: z.literal("unavailable"), reason: z.literal("build-deadline"), retryAfterMs: z.number().int().positive().safe()}).strict(),
  base.extend({kind: z.literal("integrity"), reason: z.enum(FIRST_OPEN_INTEGRITY_CODES)}).strict(),
]);

/** Only the route can return a receipt. Capture refusals belong to owner status. */
export function decodeFirstOpenResponse(value: unknown, expected: FirstOpenOutcome["source"]): FirstOpenOutcome {
  const {outcome} = z.object({ok: z.literal(true), outcome: routeOutcome}).strict().parse(value);
  if (outcome.recovery !== firstOpenRecovery(outcome) ||
    (Object.keys(expected) as (keyof typeof expected)[]).some(key => outcome.source[key] !== expected[key])) {
    throw new Error("First-open response does not match its request.");
  }
  return outcome;
}

/** Structured owner feedback, including a stop the owner or an edit can clear. */
export const FirstOpenOwnerStatus: z.ZodType<FirstOpenRefusal | FirstOpenTemporaryStop> = z.union([
  base.extend({reason: z.literal("deletion")}).strict(),
  base.extend({reason: z.literal("unsupported-source"), code: z.enum(FIRST_OPEN_UNSUPPORTED_CAUSES)}).strict(),
  base.extend({reason: z.literal("too-large"), code: z.enum(FIRST_OPEN_TOO_LARGE_CODES)}).strict(),
  base.extend({reason: z.literal("ordinary-activation-refused"), code: z.string().regex(FIRST_OPEN_ACTIVATION_CODE).optional()}).strict(),
  base.extend({reason: z.literal("integrity"), code: z.enum(FIRST_OPEN_INTEGRITY_CODES)}).strict(),
  base.extend({reason: z.literal("retry-stopped"), code: z.literal("build-deadline"), deadlineAnswers: z.literal(3), recovery: z.literal("retry-later")}).strict(),
]);
