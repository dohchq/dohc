import { describe, expect, it } from "vitest";
import { engineHistoryContractCompileCheck } from "./engineContracts.compile";

describe("engine history contract compile guard", () => {
  it("loads the exact-identity guard", () => {
    expect(engineHistoryContractCompileCheck).toBe(true);
  });
});
