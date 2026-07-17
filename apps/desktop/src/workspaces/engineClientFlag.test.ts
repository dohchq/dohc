import { describe, expect, it } from "vitest";
import { isRustEngineAdapterEnabled } from "./engineClientFlag";

describe("isRustEngineAdapterEnabled", () => {
  it("is false by default and only enables for the exact value 1", () => {
    expect(isRustEngineAdapterEnabled({})).toBe(false);
    expect(isRustEngineAdapterEnabled({ DOHC_RUST_ENGINE_ADAPTER: "true" })).toBe(
      false,
    );
    expect(isRustEngineAdapterEnabled({ DOHC_RUST_ENGINE_ADAPTER: "1" })).toBe(
      true,
    );
  });
});
