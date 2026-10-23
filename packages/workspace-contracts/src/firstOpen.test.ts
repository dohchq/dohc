import { describe, expect, it } from "vitest";
import {
  FIRST_OPEN_INTEGRITY_CODES,
  FIRST_OPEN_OWNER_NOTICE,
  FIRST_OPEN_REFUSAL_REASONS,
  FIRST_OPEN_TOO_LARGE_CODES,
  FIRST_OPEN_UNSUPPORTED_CAUSES,
  firstOpenOutcome,
  firstOpenRefusal,
  firstOpenReport,
} from "./firstOpen";

const source = { workspaceId: "workspace-1", objectId: "object-1", path: "docs/a.md", sourceMomentId: "moment-1", sourceDigest: "a".repeat(64) };
const receipt = { originId: "service-host:first-open:origin", originSeq: 0, relaySeq: 2 } as const;
type Answer = Parameters<typeof firstOpenOutcome>[1];

// Each answer, the report agents read, and whether its owner gets a Notice.
const cases: [Answer, object, "refusal" | "transient" | "none"][] = [
  [{ kind: "published", receipt }, { reason: "published", recovery: "pull" }, "none"],
  [{ kind: "replayed", receipt }, { reason: "replayed", recovery: "pull" }, "none"],
  [{ kind: "existing-history", reason: "prior-authority" }, { reason: "prior-authority", recovery: "pull" }, "none"],
  [{ kind: "refused", reason: "stale-source" }, { reason: "stale-source", recovery: "pull-current-source" }, "none"],
  [{ kind: "refused", reason: "deletion" }, { reason: "deletion", recovery: "none" }, "refusal"],
  ...FIRST_OPEN_UNSUPPORTED_CAUSES.map((cause): [Answer, object, "refusal"] =>
    [{ kind: "refused", reason: "unsupported-source", cause }, { reason: "unsupported-source", code: cause, recovery: "none" }, "refusal"]),
  ...FIRST_OPEN_TOO_LARGE_CODES.map((code): [Answer, object, "refusal"] =>
    [{ kind: "refused", reason: "too-large", code }, { reason: "too-large", code, recovery: "none" }, "refusal"]),
  [{ kind: "refused", reason: "ordinary-activation-refused" }, { reason: "ordinary-activation-refused", recovery: "report" }, "refusal"],
  [{ kind: "refused", reason: "ordinary-activation-refused", code: "native-disagreement" },
    { reason: "ordinary-activation-refused", code: "native-disagreement", recovery: "report" }, "refusal"],
  ...(["contention", "busy", "reconfigured", "history-unavailable", "worker-failed", "storage-failed", "host-absent", "host-unreachable",
    "check-failed", "check-deadline"] as const).map((reason): [Answer, object, "transient"] =>
    [{ kind: "unavailable", reason }, { reason: "unavailable", code: reason, recovery: "retry-later" }, "transient"]),
  [{ kind: "unavailable", reason: "build-deadline", retryAfterMs: 60_000 },
    { reason: "unavailable", code: "build-deadline", retryAfterMs: 60_000, recovery: "retry-later" }, "transient"],
  ...FIRST_OPEN_INTEGRITY_CODES.map((code): [Answer, object, "refusal"] =>
    [{ kind: "integrity", reason: code }, { reason: "integrity", code, recovery: "report" }, "refusal"]),
];

describe("first-open reports", () => {
  it.each(cases.map(([answer, report, notice]) => [JSON.stringify(answer), answer, report, notice] as const))(
    "reports %s as one stable reason, code, source and recovery",
    (_, answer, report, notice) => {
      const outcome = firstOpenOutcome(source, answer);
      expect(firstOpenReport(outcome)).toStrictEqual({ ...report, source });
      expect(FIRST_OPEN_OWNER_NOTICE[firstOpenReport(outcome).reason]).toBe(notice);
      expect(firstOpenRefusal(outcome)).toStrictEqual(notice === "refusal" ? { ...report, source } : undefined);
    },
  );

  it("lists exactly the reasons that reach the owner as refusals", () => {
    const refusals = Object.entries(FIRST_OPEN_OWNER_NOTICE).filter(([, notice]) => notice === "refusal").map(([reason]) => reason);
    expect([...FIRST_OPEN_REFUSAL_REASONS].sort()).toEqual(refusals.sort());
  });

  // Proves: no refused activation carries a code the owner's IPC would reject,
  // so one row can never fail its workspace's status.
  it("refuses an activation code outside lowercase letters, digits and hyphens, up to 128 characters", () => {
    for (const code of ["Native_Disagreement", "-leading", "", "a".repeat(129), "native disagreement"]) {
      expect(() => firstOpenOutcome(source, { kind: "refused", reason: "ordinary-activation-refused", code })).toThrow();
    }
    expect(firstOpenReport(firstOpenOutcome(source, { kind: "refused", reason: "ordinary-activation-refused", code: "a".repeat(128) })))
      .toMatchObject({ code: "a".repeat(128) });
  });

  it("names only the source fields the request named", () => {
    const outcome = firstOpenOutcome({ ...source, sourceByteLength: 12 } as typeof source, { kind: "refused", reason: "deletion" });
    expect(outcome.source).toStrictEqual(source);
    expect(Object.isFrozen(outcome) && Object.isFrozen(outcome.source)).toBe(true);
  });
});
