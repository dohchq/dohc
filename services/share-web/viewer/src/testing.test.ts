// @vitest-environment jsdom
import {expect, it} from "vitest";
import {settle} from "./testing";

it("waits for a condition that work off the main thread makes true only after many act turns", async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  // Stands in for a save's hash, which a loaded host's thread pool can take this long to finish.
  let done = false;
  setTimeout(() => {done = true;}, 200);
  await settle(() => done);
  expect(done).toBe(true);
});
