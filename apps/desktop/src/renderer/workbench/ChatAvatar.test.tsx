// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_HUES } from "../tokens";
import { ChatAvatar, identityHue } from "./ChatAvatar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChatAvatar initials", () => {
  it.each([
    ["  ice", "I"],
    ["ice de vera", "ID"],
    ["👩🏽‍💻 Dev", "👩🏽‍💻D"],
    ["émilie", "É"],
    ["  ", "?"],
  ])("renders the first letter of the first two words of %s", (name, initial) => {
    render(<ChatAvatar name={name} kind="human" />);
    expect(screen.getByTitle(name, { normalizer: (value) => value }).textContent).toBe(initial);
  });

  it("keeps an emoji code point intact when Segmenter is unavailable", async () => {
    vi.stubGlobal("Intl", { Segmenter: undefined });
    vi.resetModules();
    const { ChatAvatar: FallbackAvatar } = await import("./ChatAvatar");
    render(<FallbackAvatar name="😀 Reader" kind="human" />);
    expect(screen.getByTitle("😀 Reader").textContent).toBe("😀R");
  });
});

describe("ChatAvatar hue", () => {
  it("hashes the display name to a stable hue", () => {
    expect(identityHue("user-1")).toBe(identityHue("user-1"));
    expect(IDENTITY_HUES).toContain(identityHue("user-1"));
    render(<ChatAvatar name="Ice" kind="human" />);
    render(<ChatAvatar name="Nova" kind="human" />);
    expect(screen.getByTitle("Ice").className).toContain(`text-hue-${identityHue("Ice")}`);
    expect(screen.getByTitle("Nova").className).toContain(`text-hue-${identityHue("Nova")}`);
  });

  it("spreads people across the hues", () => {
    const hues = new Set(
      ["Ice", "Nova", "Sam", "Priya", "Lena", "Omar", "Kai", "Yuki", "Ana", "Theo"].map(identityHue),
    );
    expect(hues.size).toBeGreaterThan(4);
  });

  it("keeps the agent in the olive voice", () => {
    render(<ChatAvatar name="Reader" kind="agent" />);
    const avatar = screen.getByTitle("Reader");
    expect(avatar.className).toContain("text-agent");
    expect(avatar.className).not.toContain("hue");
  });
});
