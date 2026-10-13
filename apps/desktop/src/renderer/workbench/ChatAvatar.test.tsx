// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { neutralPresentation, ownPresentation } from "./actorPresentation";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { ChatAvatar } from "./ChatAvatar";
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
    render(<ChatAvatar presentation={neutralPresentation} name={name} kind="human" />);
    expect(screen.getByTitle(name, { normalizer: (value) => value }).textContent).toBe(initial);
  });

  it("keeps an emoji code point intact when Segmenter is unavailable", async () => {
    vi.stubGlobal("Intl", { Segmenter: undefined });
    vi.resetModules();
    const { ChatAvatar: FallbackAvatar } = await import("./ChatAvatar");
    render(<FallbackAvatar presentation={neutralPresentation} name="😀 Reader" kind="human" />);
    expect(screen.getByTitle("😀 Reader").textContent).toBe("😀R");
  });
});

describe("ChatAvatar presentation", () => {
  it("uses the supplied hue regardless of label and group", () => {
    const presentation = { group: "opaque", hue: "teal" as const, self: false };
    const { rerender } = render(<ChatAvatar name="Ada" kind="human" presentation={presentation} />);
    expect(screen.getByTitle("Ada").className).toContain("text-hue-teal");
    rerender(<ChatAvatar name="A😀" kind="human" presentation={{ ...presentation, group: "other" }} />);
    expect(screen.getByTitle("A😀").className).toContain("text-hue-teal");
  });
  it("keeps an unknown person neutral and agents in the default voice", () => {
    render(<ChatAvatar name="Ada" kind="human" presentation={neutralPresentation} />);
    render(<ChatAvatar name="Agent" kind="agent" presentation={neutralPresentation} />);
    expect(screen.getByTitle("Ada").className).toContain("text-muted");
    expect(screen.getByTitle("Agent").className).toContain("text-agent");
  });
  it("keeps automation marks bare", () => {
    render(<ChatAvatar name="Job" kind="automation" presentation={neutralPresentation} />);
    expect(screen.getByTitle("Job").className).not.toMatch(/\b(border|hue|agent|rounded)/u);
    expect(screen.getByTitle("Job").querySelector("svg.lucide-zap")).not.toBeNull();
  });
  it("applies chosen colours only to self, and repaints", () => {
    render(<ChatAvatar name="You" kind="human" presentation={{ ...ownPresentation, hue: "teal" }} />);
    render(<ChatAvatar name="Someone" kind="human" presentation={{ ...neutralPresentation, hue: "teal" }} />);
    render(<ChatAvatar name="Agent" kind="agent" presentation={ownPresentation} />);
    act(() => setChosenColors({ ...DEFAULT_USER_SETTINGS.appearance, yourColor: "rose", yourAgentColor: "olive" }));
    expect(screen.getByTitle("You").className).toContain("text-hue-rose");
    expect(screen.getByTitle("Someone").className).toContain("text-hue-teal");
    expect(screen.getByTitle("Agent").className).toContain("text-hue-olive");
    act(() => setChosenColors(DEFAULT_USER_SETTINGS.appearance));
    expect(screen.getByTitle("You").className).toContain("text-hue-teal");
    expect(screen.getByTitle("Agent").className).toContain("text-agent");
  });
});
