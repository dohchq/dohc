import { expect, it } from "vitest";
import { channelSlugForName } from "./chatWireIds";

it("uses Unicode whitespace like the engine when deriving channel folders", () => {
  expect(channelSlugForName("a\u0085b")).toBe("a-b");
  expect(channelSlugForName(" a\u0085 \t_b ")).toBe("a-b");
});
