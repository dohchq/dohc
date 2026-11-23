import { expect, it } from "vitest";
import { createStartTimeline } from "./startTimeline";

it("gives each step the time since the step before it, and the first the time since the process began", () => {
  let now = 0;
  const start = createStartTimeline(() => now);
  now = 1900.4;
  start.done("code");
  now = 3600.2;
  start.done("database");
  now = 3640;
  start.done("listening");
  expect(start.line()).toBe("started in 3640 ms: code 1900, database 1700, listening 40");
});
