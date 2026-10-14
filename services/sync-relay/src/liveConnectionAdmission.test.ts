import {expect, it} from "vitest";
import {createLiveConnectionAdmission} from "./liveConnectionAdmission";
import {LiveConnectionLimitError} from "@dohc/live-session-contract/live-connection";
it("reserves all counters atomically and releases them once", () => {
  const admission = createLiveConnectionAdmission();
  const release = admission.reserve([["session", 1, "live_session_limit"], ["person", 2, "live_person_limit"]]);
  expect(() => admission.reserve([["other-session", 1, "live_session_limit"], ["person", 1, "live_person_limit"]]))
    .toThrowError(new LiveConnectionLimitError("live_person_limit"));
  expect(admission.reserve([["other-session", 1]])).not.toBeNull();
  release?.(); release?.();
  expect(admission.reserve([["session", 1], ["person", 1]])).not.toBeNull();
});
it("shares exactly one byte budget across route families", () => {
  const admission = createLiveConnectionAdmission();
  expect(admission.buffers(10)).toBe(admission.buffers(10));
  expect(() => admission.buffers(11)).toThrow();
});
