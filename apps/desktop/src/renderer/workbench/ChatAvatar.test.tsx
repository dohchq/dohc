// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_HUES } from "../tokens";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { ChatAvatar, identityHue } from "./ChatAvatar";
import { setChosenColors } from "./chosenColors";

afterEach(() => {
  setChosenColors(DEFAULT_USER_SETTINGS.appearance);
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
    render(<ChatAvatar name="Ada" kind="human" />);
    render(<ChatAvatar name="Nova" kind="human" />);
    expect(screen.getByTitle("Ada").className).toContain(`text-hue-${identityHue("Ada")}`);
    expect(screen.getByTitle("Nova").className).toContain(`text-hue-${identityHue("Nova")}`);
  });

  it("spreads people across the hues", () => {
    const hues = new Set(
      ["Ada", "Nova", "Sam", "Priya", "Lena", "Omar", "Kai", "Yuki", "Ana", "Theo"].map(identityHue),
    );
    expect(hues.size).toBeGreaterThan(4);
  });

  it("keeps the agent in the olive voice", () => {
    render(<ChatAvatar name="Reader" kind="agent" />);
    const avatar = screen.getByTitle("Reader");
    expect(avatar.className).toContain("text-agent");
    expect(avatar.className).not.toContain("hue");
  });

  it("marks an automation with a bare lightning mark and no identity color", () => {
    render(<ChatAvatar name="Stamp the finish date" kind="automation" size="comment" />);
    const avatar = screen.getByTitle("Stamp the finish date");
    expect(avatar.className).toContain("text-muted");
    expect(avatar.className).not.toMatch(/\b(border|hue|agent|rounded)/u);
    expect(avatar.textContent).toBe("");
    expect(avatar.querySelector("svg.lucide-zap")).not.toBeNull();
  });

  it("draws you and your agent in the colors the settings file chose, and repaints on a change", () => {
    const ownHue = IDENTITY_HUES.find((hue) => hue !== identityHue("Ada"))!;
    render(<ChatAvatar name="Ada" kind="human" own />);
    // Another person with your name keeps the hue dohc picks.
    render(<ChatAvatar name="Ada" kind="human" className="other" />);
    render(<ChatAvatar name="Nova" kind="agent" own />);
    act(() => setChosenColors({ ...DEFAULT_USER_SETTINGS.appearance, yourColor: ownHue, yourAgentColor: "plum" }));
    const [yours, theirs] = screen.getAllByTitle("Ada");
    expect(yours!.className).toContain(`text-hue-${ownHue}`);
    expect(theirs!.className).toContain(`text-hue-${identityHue("Ada")}`);
    expect(screen.getByTitle("Nova").className).toContain("text-hue-plum");
    expect(screen.getByTitle("Nova").className).not.toContain("text-agent");

    act(() => setChosenColors(DEFAULT_USER_SETTINGS.appearance));
    expect(screen.getAllByTitle("Ada")[0]!.className).toContain(`text-hue-${identityHue("Ada")}`);
    expect(screen.getByTitle("Nova").className).toContain("text-agent");
  });
});
