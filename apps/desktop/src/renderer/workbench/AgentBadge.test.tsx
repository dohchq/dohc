// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBadge, AgentSettingsProvider } from "./AgentBadge";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { settingsWithAgent } from "../../testing/agentSettings";

const mine = { group: "agent-mine", hue: null, self: true } as const;
const theirs = { group: "agent-theirs", hue: null, self: false } as const;
const ada = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Ada" } };

function tooltipFor(author: { authorDisplayName: string; authorOwnerDisplayName?: string }, presentation: typeof mine | typeof theirs, settings = settingsWithAgent({ name: "Nova", launch: { command: "local-tool --private-path" } }, ada)) {
  render(<AgentSettingsProvider settings={settings}>
    <AgentBadge testIdPrefix="chats-post" author={author} presentation={presentation} />
  </AgentSettingsProvider>);
  fireEvent.focus(screen.getByTestId("chats-post-agent-badge"));
  return screen.getByRole("tooltip").textContent ?? "";
}

afterEach(cleanup);
describe("agent badge", () => {
  it("shows the chosen tool's command for your agent", () => {
    const text = tooltipFor({ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada" }, mine,
      settingsWithAgent({ name: "Nova", launch: { tool: "codex", executable: "/tools/codex" } }, ada));
    expect(text).toContain("/tools/codex");
  });

  it("shows the owner, and your command only on your agent's message", () => {
    expect(tooltipFor({ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada" }, mine)).toContain("Current local command: local-tool --private-path");
    cleanup();
    // In a shared workspace, another person's agent can carry your names. It is still theirs.
    const text = tooltipFor({ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada" }, theirs);
    expect(text).toContain("Owned by Ada");
    expect(text).not.toContain("local-tool");
  });

  it("finds your agent by the name its messages had before agents had ids", () => {
    const renamed = settingsWithAgent({ name: "Atlas", nameBeforeMigration: "Nova", launch: { command: "local-tool" } }, ada);
    expect(tooltipFor({ authorDisplayName: "Nova" }, mine, renamed)).toContain("Current local command: local-tool");
    cleanup();
    // Your person's message from an agent you do not have shows no command.
    expect(tooltipFor({ authorDisplayName: "Cursor" }, mine, renamed)).not.toContain("Current local command");
  });

  it("adds what the agent reported as one line, and no line when it reported nothing", () => {
    const reported = (authorReported?: { product?: string; version?: string; model?: string }) => {
      cleanup();
      render(<AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ice", ...(authorReported ? { authorReported } : {}) }} presentation={theirs} />);
      fireEvent.focus(screen.getByTestId("chats-post-agent-badge"));
      return screen.queryByTestId("chats-post-agent-reported")?.textContent ?? null;
    };
    expect(reported({ product: "Claude Code", version: "2.1", model: "Claude Opus 5.5" })).toBe("Claude Code 2.1 · Claude Opus 5.5 (as reported)");
    expect(reported({ product: "Claude Code", version: "2.1" })).toBe("Claude Code 2.1 (as reported)");
    expect(reported({ model: "Claude Opus 5.5" })).toBe("Claude Opus 5.5 (as reported)");
    expect(reported()).toBeNull();
    expect(screen.getByRole("tooltip").textContent).toContain("Owned by Ice");
  });

  it("closes on Escape, and stays open while it has focus", () => {
    render(<AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada" }} presentation={theirs} />);
    const badge = screen.getByTestId("chats-post-agent-badge");
    expect(badge.tabIndex).toBe(0);
    badge.focus();
    fireEvent.focus(badge);
    fireEvent.mouseLeave(badge.parentElement!);
    expect(screen.getByRole("tooltip")).not.toBeNull();
    fireEvent.keyDown(badge, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("opens its details without opening the containing post", () => {
    const onOpen = vi.fn();
    render(<div onClick={onOpen}>
      <AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada" }} />
    </div>);
    fireEvent.click(screen.getByTestId("chats-post-agent-badge"));
    expect(screen.getByRole("tooltip").textContent).toContain("Owned by Ada");
    expect(onOpen).not.toHaveBeenCalled();
  });
});
