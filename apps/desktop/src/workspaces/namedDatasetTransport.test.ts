import { expect, it } from "vitest";
import { namedDatasetFetch, NamedDatasetOfflineError } from "./namedDatasetTransport";

it("uses its transport deadline even with an existing workspace signal", async () => {
  const workspace = new AbortController(), deadline = new AbortController();
  await expect(namedDatasetFetch(async signal => {
    expect(signal.aborted).toBe(false);
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    signal.throwIfAborted(); return new Response();
  }, workspace.signal, deadline.signal)).rejects.toBeInstanceOf(NamedDatasetOfflineError);
  expect(workspace.signal.aborted).toBe(false);
});

it("never interprets workspace cancellation as offline even if the deadline also expires", async () => {
  const workspace = new AbortController(), deadline = new AbortController();
  await expect(namedDatasetFetch(async signal => {
    workspace.abort(new Error("Workspace changed")); deadline.abort();
    signal.throwIfAborted(); return new Response();
  }, workspace.signal, deadline.signal)).rejects.toThrow("Workspace changed");
});

it("classifies fetch connection failures without classifying other errors", async () => {
  await expect(namedDatasetFetch(async () => { throw new TypeError("fetch failed"); })).rejects.toBeInstanceOf(NamedDatasetOfflineError);
  await expect(namedDatasetFetch(async () => { throw Error("invalid setup"); })).rejects.toThrow("invalid setup");
});
