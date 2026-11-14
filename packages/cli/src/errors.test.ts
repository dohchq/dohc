import { expect, it } from "vitest";
import { cliErrorLine } from "./errors";

it("names dohc once: a sentence that starts with dohc keeps its words, any other gets the prefix", () => {
  expect(cliErrorLine(new Error("dohc could not send the invite."))).toBe("dohc could not send the invite.\n");
  expect(cliErrorLine(new Error("dohc: no such group: general"))).toBe("dohc: no such group: general\n");
  expect(cliErrorLine(new Error("no such group: general"))).toBe("dohc: no such group: general\n");
  // A word that only starts with the name is not the name.
  expect(cliErrorLine(new Error("dohcfile is missing"))).toBe("dohc: dohcfile is missing\n");
});
