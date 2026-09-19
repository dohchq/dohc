// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentBadge, AgentSettingsContext } from "./AgentBadge";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";

afterEach(cleanup);
describe("agent badge", () => {
  it.each(["owner", "someone-else"])("shows the stored owner and limits the local command for viewer %s", (viewer) => {
    render(<AgentSettingsContext.Provider value={{ ...DEFAULT_USER_SETTINGS, profile: { agentName: "Nova", preferredName: "Ada" }, runner: { ...DEFAULT_USER_SETTINGS.runner, command: "local-tool --private-path" } }}>
      <AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada", authorUserId: "owner" }} viewerAuthorId={viewer} />
    </AgentSettingsContext.Provider>);
    const badge = screen.getByTestId("chats-post-agent-badge");
    expect(badge.tabIndex).toBe(0);
    fireEvent.focus(badge);
    expect(screen.getByRole("tooltip").textContent).toContain("Owned by Ada");
    expect(screen.getByRole("tooltip").textContent?.includes("local-tool --private-path")).toBe(viewer === "owner");
    fireEvent.keyDown(badge, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
