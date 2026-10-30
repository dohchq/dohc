import {describe, expect, it} from "vitest";
import {RELAY_ERROR_MESSAGES} from "../../../../services/sync-relay/src/errors";
import {liveStopHostCopy, readLiveStopRefusal, liveStopRelayError} from "./liveEditingStop";
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
