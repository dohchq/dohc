import { expect, it, vi } from "vitest";
import { baselineRecord } from "./liveDocumentAuthority";

it("captures only required data fields when extra fields are allowed", () => {
  const getter = vi.fn(() => { throw new Error("extra field was read"); });
  const input = Object.assign(Object.create(null), { required: "captured" });
  Object.defineProperty(input, "extra", { enumerable: true, get: getter });
  Object.defineProperty(input, Symbol("extra"), { value: 1 });
  const captured = baselineRecord(input, ["required"], true);
  input.required = "changed";
  expect(captured).toEqual({ required: "captured" });
  expect(getter).not.toHaveBeenCalled();
  expect(() => baselineRecord(input, ["required"])).toThrow("Invalid baseline fields.");
  expect(getter).not.toHaveBeenCalled();
});

it.each(["inherited", "accessor", "non-enumerable", "symbol", "proxy", "array"])(
  "refuses a %s record without executing caller code", kind => {
    const trap = vi.fn(() => { throw new Error("caller code ran"); });
    let input: unknown = { required: "value" };
    if (kind === "inherited") input = Object.create({ required: "value" });
    if (kind === "accessor") Object.defineProperty(input, "required", { enumerable: true, get: trap });
    if (kind === "non-enumerable") Object.defineProperty(input, "required", { enumerable: false });
    if (kind === "symbol") Object.defineProperty(input, Symbol("extra"), { value: 1 });
    if (kind === "proxy") input = new Proxy(input as object, { ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap });
    if (kind === "array") input = Object.assign([], { required: "value" });
    expect(() => baselineRecord(input, ["required"])).toThrow(/Invalid baseline/);
    expect(trap).not.toHaveBeenCalled();
  },
);
