import { expect, it } from "vitest";
import { namedSessionCheckWindowMs } from "./namedSessionCheck";

it.each([
  ["300000", 900_000],
  ["60000", 180_000],
  ["1", 180_000],
  ["3600000", 900_000],
  ["9999999999", 900_000],
  ["", 900_000],
  ["1.5", 900_000],
  ["-60000", 900_000],
  ["NaN", 900_000],
])("keeps a session three checks of %s ms, inside the accepted range", (value, window) => {
  expect(namedSessionCheckWindowMs(value)).toBe(window);
});
