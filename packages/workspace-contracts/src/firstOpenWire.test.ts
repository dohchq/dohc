import {expect, it} from "vitest";
import {firstOpenOutcome} from "./firstOpen";
import {decodeFirstOpenResponse, FirstOpenOwnerStatus} from "./firstOpenWire";

const source = {workspaceId: "w", objectId: "o", path: "a.md", sourceMomentId: "m", sourceDigest: "a".repeat(64)};
it("keeps temporary stops separate from permanent refusals and enforces their recovery", () => {
  const stop = {source, reason: "retry-stopped", code: "build-deadline", deadlineAnswers: 3, recovery: "retry-later"};
  expect(FirstOpenOwnerStatus.parse(stop)).toEqual(stop);
  expect(FirstOpenOwnerStatus.safeParse({...stop, recovery: "none"}).success).toBe(false);
  expect(FirstOpenOwnerStatus.safeParse({...stop, reason: "unsupported-source"}).success).toBe(false);
});

it("decodes only route outcomes, with the recovery that outcome permits", () => {
  for (const answer of [
    {kind: "refused", reason: "too-large", code: "source-limit"},
    {kind: "refused", reason: "unsupported-source", cause: "settlement-mismatch"},
    {kind: "integrity", reason: "source-evidence"},
    {kind: "existing-history", reason: "prior-authority"},
    {kind: "unavailable", reason: "build-deadline", retryAfterMs: 60_000},
  ] as const) {
    const outcome = firstOpenOutcome(source, answer);
    expect(decodeFirstOpenResponse({ok: true, outcome}, source)).toEqual(outcome);
    expect(() => decodeFirstOpenResponse({ok: true, outcome: {...outcome, recovery: "invented"}}, source)).toThrow();
  }
  expect(() => decodeFirstOpenResponse({ok: true, outcome: firstOpenOutcome(source,
    {kind: "refused", reason: "ordinary-activation-refused", code: "native"})}, source)).toThrow();
});
