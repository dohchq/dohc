import { expect, it } from "vitest";
import { DaemonRefusalError, isTransientEngineRefusal, isYdocAuthorCapacityRefusal, isYdocUpdateAdmissionRefusal } from "./daemonLiveAdapter";

it("retries only the author-capacity limit refusal", () => {
  const capacity = new DaemonRefusalError({code: "LIMIT_EXCEEDED", message: "ydoc-author-capacity", retry: "no"}, null);
  const oversized = new DaemonRefusalError({code: "LIMIT_EXCEEDED", message: "author details too large", retry: "no"}, null);
  expect(isYdocAuthorCapacityRefusal(capacity)).toBe(true);
  expect(isTransientEngineRefusal(capacity)).toBe(true);
  expect(isTransientEngineRefusal(oversized)).toBe(false);
});

it.each(["CANCELLED", "INTERNAL", "DEADLINE_EXCEEDED", "OVERLOADED", "RELAY_INVALID_RESPONSE"] as const)(
  "does not infer non-admission from %s with retry no", code => {
    expect(isYdocUpdateAdmissionRefusal(new DaemonRefusalError({ code, message: "uncertain", retry: "no" }, null))).toBe(false);
  },
);

it.each(["INVALID_PARAMS", "LIMIT_EXCEEDED"] as const)("retires unknown %s input refusals", code => {
  expect(isYdocUpdateAdmissionRefusal(new DaemonRefusalError({ code, message: "future-refusal", retry: "no" }, null))).toBe(true);
});

it("retries only the pending settlement discriminator", () => {
  const pending = new DaemonRefusalError({code: "OVERLOADED", message: "settlement-materialization-pending", retry: "afterBackoff"}, null);
  const other = new DaemonRefusalError({code: "OVERLOADED", message: "another failure", retry: "no"}, null);
  expect(isTransientEngineRefusal(pending)).toBe(true);
  expect(isTransientEngineRefusal(other)).toBe(false);
});
