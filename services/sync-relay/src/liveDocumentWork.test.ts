import {expect, it, vi} from "vitest";
import {LiveDocumentWork} from "./liveDocumentWork.js";

function deferred() {
  let resolve!: () => void;
  return {promise: new Promise<void>(done => {resolve = done;}), resolve: () => resolve()};
}

it("serializes one document while allowing unrelated documents to progress", async () => {
  const work = new LiveDocumentWork(), signal = new AbortController().signal, release = deferred(), next = vi.fn(async () => "fresh");
  const first = work.run("a", signal, () => release.promise);
  const second = work.run("a", signal, next);
  expect(next).not.toHaveBeenCalled();
  expect(await work.run("b", signal, async () => "other")).toBe("other");
  release.resolve(); await first;
  expect(await second).toBe("fresh");
  expect(work.busy("a")).toBe(false);
});

it("cancels a waiting caller without cancelling the current pass or retaining its abort listener", async () => {
  const work = new LiveDocumentWork(), release = deferred(), signal = new AbortController(), next = vi.fn();
  const remove = vi.spyOn(signal.signal, "removeEventListener");
  const first = work.run("a", new AbortController().signal, () => release.promise);
  const second = work.run("a", signal.signal, next);
  const failed = expect(second).rejects.toThrow("cancelled");
  signal.abort(new Error("cancelled")); await failed;
  expect(remove).toHaveBeenCalled(); expect(next).not.toHaveBeenCalled(); expect(work.busy("a")).toBe(true);
  release.resolve(); await first;
});

it("releases a failed pass before a waiting caller checks fresh state", async () => {
  const work = new LiveDocumentWork(), release = deferred(), signal = new AbortController().signal;
  const first = work.run("a", signal, async () => {await release.promise; throw new Error("failed");});
  const failed = expect(first).rejects.toThrow("failed");
  const second = work.run("a", signal, async () => "recovered");
  release.resolve(); await failed;
  expect(await second).toBe("recovered");
});
