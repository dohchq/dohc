// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBadge, AgentSettingsContext, isOwnAuthor } from "./AgentBadge";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";

afterEach(cleanup);
describe("agent badge", () => {
  it("shows the selected tool instead of the saved Advanced command", () => {
    render(<AgentSettingsContext.Provider value={{ ...DEFAULT_USER_SETTINGS, profile: { agentName: "Nova", preferredName: "Ada" }, runner: { ...DEFAULT_USER_SETTINGS.runner, command: "old-tool", profile: { tool: "codex", executable: "/tools/codex" } } }}>
      <AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada", authorUserId: "owner" }} viewerAuthorId="owner" />
    </AgentSettingsContext.Provider>);
    fireEvent.focus(screen.getByTestId("chats-post-agent-badge"));
    expect(screen.getByRole("tooltip").textContent).toContain("/tools/codex");
    expect(screen.getByRole("tooltip").textContent).not.toContain("old-tool");
  });
  it.each(["owner", "someone-else"])("shows the stored owner and limits the local command for viewer %s", (viewer) => {
    render(<AgentSettingsContext.Provider value={{ ...DEFAULT_USER_SETTINGS, profile: { agentName: "Nova", preferredName: "Ada" }, runner: { ...DEFAULT_USER_SETTINGS.runner, command: "local-tool --private-path" } }}>
      <AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada", authorUserId: "owner" }} viewerAuthorId={viewer} />
    </AgentSettingsContext.Provider>);
    const badge = screen.getByTestId("chats-post-agent-badge");
    expect(badge.tabIndex).toBe(0);
    badge.focus();
    fireEvent.focus(badge);
    expect(screen.getByRole("tooltip").textContent).toContain("Owned by Ada");
    expect(screen.getByRole("tooltip").textContent?.includes("Current local command: local-tool --private-path")).toBe(viewer === "owner");
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

describe("whose message it is", () => {
  const profile = { preferredName: "Ada", agentName: "Nova" };

  it("trusts the verified id on a signed-in message over its name", () => {
    expect(isOwnAuthor("human", { authorDisplayName: "Ada", authorUserId: "user-1" }, "user-1", profile)).toBe(true);
    // Someone else named Ada.
    expect(isOwnAuthor("human", { authorDisplayName: "Ada", authorUserId: "user-2" }, "user-1", profile)).toBe(false);
    // The viewer's id has not loaded yet.
    expect(isOwnAuthor("human", { authorDisplayName: "Ada", authorUserId: "user-1" }, undefined, profile)).toBe(false);
    expect(isOwnAuthor("agent", { authorDisplayName: "Nova", authorUserId: "user-1" }, "user-1", profile)).toBe(true);
  });

  it("goes by your names on a signed-out message", () => {
    expect(isOwnAuthor("human", { authorDisplayName: "Ada" }, undefined, profile)).toBe(true);
    expect(isOwnAuthor("human", { authorDisplayName: "You" }, undefined, {})).toBe(true);
    expect(isOwnAuthor("human", { authorDisplayName: "Grace" }, undefined, profile)).toBe(false);
    expect(isOwnAuthor("agent", { authorDisplayName: "Nova", authorOwnerDisplayName: "Ada" }, undefined, profile)).toBe(true);
    expect(isOwnAuthor("agent", { authorDisplayName: "Nova", authorOwnerDisplayName: "Grace" }, undefined, profile)).toBe(false);
    // Before you name yourself or your agent, main records "You" and "Agent".
    expect(isOwnAuthor("agent", { authorDisplayName: "Agent", authorOwnerDisplayName: "You" }, undefined, {})).toBe(true);
  });
});
