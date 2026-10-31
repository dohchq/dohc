import {describe, expect, it} from "vitest";
import {RELAY_ERROR_MESSAGES} from "../../../../services/sync-relay/src/errors";
import {liveStopError, liveStopHostCopy, readLiveStopRefusal, liveStopRelayError, liveStopAction} from "./liveEditingStop";
import {HOST_STOP_CASES, hostStopWireError} from "../testing/liveStopHost.test-helper";

describe("session-host Stop contract", () => {
  it.each(HOST_STOP_CASES)("keeps the relay and desktop sentence equal for %s (%s)", (code, sessionHost, words) => {
    const relay = (RELAY_ERROR_MESSAGES as Readonly<Record<string, string>>)[code];
    expect(relay?.replaceAll("{path}", "old/plan.md")).toBe(words);
    expect(liveStopHostCopy(code, sessionHost, code === "host-moved" ? "old/plan.md" : undefined)).toBe(`${words}\nSession host: ${sessionHost}`);
  });
  it.each(HOST_STOP_CASES)("reads %s by code without trusting the sentence", (code, sessionHost) => {
    expect(readLiveStopRefusal(hostStopWireError(code, sessionHost, "untrusted relay text"))).toEqual({code, sessionHost,
      ...(code === "host-moved" ? {path: "old/plan.md"} : {})});
  });
  it.each(HOST_STOP_CASES)("carries %s from the relay through Electron with local words", (code, sessionHost, words) => {
    const error = liveStopRelayError({code, sessionHost, error: "untrusted relay text", ...(code === "host-moved" ? {path: "old/plan.md"} : {})});
    expect(error?.message).toBe(`${words}\nSession host: ${sessionHost}`);
    expect(readLiveStopRefusal(new Error(`Error invoking remote method: ${error}`))).toEqual({code, sessionHost,
      ...(code === "host-moved" ? {path: "old/plan.md"} : {})});
  });
  it("does not infer a session-host code from server prose", () => {
    expect(readLiveStopRefusal(new Error(HOST_STOP_CASES[5][2]))).toBeNull();
  });
});

it("drops an unknown sessionHost while keeping the Stop answer", () => {
  const error = liveStopRelayError({code: "host-not-loaded", sessionHost: "private arbitrary text"});
  expect(error?.message).toBe(HOST_STOP_CASES.find(([code]) => code === "host-not-loaded")?.[2]);
  expect(readLiveStopRefusal(new Error(`Error invoking remote method: ${error}`))).toEqual({code: "host-not-loaded"});
});
it("drops a moved sessionHost whose path disagrees with the answer", () => {
  expect(liveStopHostCopy("host-moved", "running without this document (moved from wrong.md)", "old/plan.md"))
    .not.toContain("Session host:");
});

it("does not offer Resume for an ineligible row, even with a Resume hint", () => {
  expect(liveStopAction({code: "edits-pending", resume: true}, {canResume: false})).toBe("retry");
});


it.each([false, true])("reads edits-pending and Resume by code when resume=%s, regardless of words", resume => {
  const refusal = {code: "edits-pending" as const, ...(resume ? {resume: true as const} : {})};
  const error = liveStopError(refusal);
  error.message = "unrelated words";
  expect(readLiveStopRefusal(new Error(`Error invoking remote method: ${error}`))).toEqual(refusal);
});
it("does not read a host refusal's shared prefix as edits-pending", () => {
  expect(readLiveStopRefusal(new Error("Live editing didn't stop."))).toBeNull();
  expect(readLiveStopRefusal(new Error("Live editing didn't stop. Recent edits haven't reached the server yet. Resume live editing to send them, then stop it."))).toBeNull();
  const error = liveStopRelayError({code: "host-not-loaded", sessionHost: "starting"})!;
  expect(error.message.startsWith("Live editing didn't stop.")).toBe(true);
  expect(readLiveStopRefusal(error)?.code).toBe("host-not-loaded");
  expect(readLiveStopRefusal(new Error(HOST_STOP_CASES[5][2]))).toBeNull();
});
it("reads the relay's edits-pending code and Resume hint without trusting words", () => {
  const error = liveStopRelayError({code: "edits-pending", error: "untrusted", resume: true});
  expect(error).toBeInstanceOf(Error);
  expect(readLiveStopRefusal(error)).toEqual({code: "edits-pending", resume: true});
});
