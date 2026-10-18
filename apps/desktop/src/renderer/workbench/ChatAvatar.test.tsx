// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { neutralPresentation, ownPresentation, setOwnPresentation, bindAgentColorUpdates, clearAgentColorOverrides } from "./actorPresentation";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { ChatAvatar } from "./ChatAvatar";
import { setChosenColors } from "./chosenColors";

afterEach(() => {
  clearAgentColorOverrides();
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
    act(() => setChosenColors({ ...DEFAULT_USER_SETTINGS.appearance, yourColor: "rose", yourAgentColor: "rose" }));
    expect(screen.getByTitle("You").className).toContain("text-hue-rose");
    expect(screen.getByTitle("Someone").className).toContain("text-hue-teal");
    expect(screen.getByTitle("Agent").className).toContain("text-hue-rose");
    act(() => setChosenColors(DEFAULT_USER_SETTINGS.appearance));
    expect(screen.getByTitle("You").className).toContain("text-hue-teal");
    expect(screen.getByTitle("Agent").className).toContain("text-agent");
  });
});

it("repaints an own avatar when main supplies its default hue", () => {
  render(<ChatAvatar name="Own preview" kind="human" presentation={ownPresentation} />);
  act(() => setOwnPresentation({ group: "own", hue: "rose", self: true }));
  expect(screen.getByTitle("Own preview").className).toContain("text-hue-rose");
  act(() => setOwnPresentation(undefined));
});


it("repaints every avatar of the changed agent without reading or rerendering its parent", () => {
  let changed: Parameters<import("../../ipc/bridgeContract").DohcDesktopBridge["onAgentColorChanged"]>[0] = () => undefined;
  const stop = bindAgentColorUpdates({ onAgentColorChanged: listener => { changed = listener; return () => undefined; } }, () => "w");
  const parent = vi.fn(() => <>
    <ChatAvatar name="Chat agent" kind="agent" presentation={{ group: "same", hue: null, self: false }} />
    <ChatAvatar name="History agent" kind="agent" presentation={{ group: "same", hue: null, self: false }} />
    <ChatAvatar name="Another agent" kind="agent" presentation={{ group: "other", hue: null, self: false }} />
  </>);
  const Parent = parent;
  render(<Parent />);
  expect(parent).toHaveBeenCalledOnce();
  act(() => changed({ workspaceId: "w", group: "same", hue: "blue" }));
  expect(screen.getByTitle("Chat agent").className).toContain("text-hue-blue");
  expect(screen.getByTitle("History agent").className).toContain("text-hue-blue");
  expect(screen.getByTitle("Another agent").className).toContain("text-agent");
  expect(parent).toHaveBeenCalledOnce();
  act(() => changed({ workspaceId: "w", group: "same", hue: null }));
  expect(screen.getByTitle("Chat agent").className).toContain("text-agent");
  expect(parent).toHaveBeenCalledOnce();
  stop();
});
