// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAvatar } from "./ChatAvatar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChatAvatar initials", () => {
  it.each([
    ["  ice", "I"],
    ["👩🏽‍💻 Dev", "👩🏽‍💻"],
    ["e\u0301milie", "E\u0301"],
    ["  ", "?"],
  ])("renders the first grapheme of %s", (name, initial) => {
    render(<ChatAvatar name={name} kind="human" />);
    expect(screen.getByTitle(name, { normalizer: (value) => value }).textContent).toBe(initial);
  });

  it("keeps an emoji code point intact when Segmenter is unavailable", async () => {
    vi.stubGlobal("Intl", { Segmenter: undefined });
    vi.resetModules();
    const { ChatAvatar: FallbackAvatar } = await import("./ChatAvatar");
    render(<FallbackAvatar name="😀 Reader" kind="human" />);
    expect(screen.getByTitle("😀 Reader").textContent).toBe("😀");
  });
});
