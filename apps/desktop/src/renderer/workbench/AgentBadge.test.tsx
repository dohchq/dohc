// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBadge, AgentSettingsProvider } from "./AgentBadge";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { settingsWithAgent } from "../../testing/agentSettings";

const mine = { group: "agent-mine", hue: null, self: true } as const;
const theirs = { group: "agent-theirs", hue: null, self: false } as const;
const ada = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Ada" } };

function tooltipFor(
  author: { authorDisplayName: string; authorOwnerDisplayName?: string; authorAgentId?: string },
  presentation: typeof mine | typeof theirs,
  settings = settingsWithAgent(
    { name: "Nova", launch: { command: "local-tool --private-path" } },
    ada,
  ),
) {
  render(
    <AgentSettingsProvider settings={settings}>
      <AgentBadge testIdPrefix="chats-post" author={author} presentation={presentation} />
    </AgentSettingsProvider>,
  );
  fireEvent.focus(screen.getByTestId("chats-post-agent-badge"));
  return screen.getByRole("tooltip", { hidden: true }).textContent ?? "";
}

afterEach(cleanup);
describe("agent badge", () => {
  it("shows the owner, and how your agent runs only on your agent's message", () => {
    expect(
      tooltipFor(
        { authorDisplayName: "Nova", authorOwnerDisplayName: "Ada", authorAgentId: "default" },
        mine,
      ),
    ).toContain("Your runner command");
    expect(screen.getByTestId("chats-post-agent-runs-with").getAttribute("title")).toBe(
      "local-tool --private-path",
    );
    cleanup();
    // In a shared workspace, another person's agent can carry your agent's name and id. It is still theirs.
    const text = tooltipFor(
      { authorDisplayName: "Nova", authorOwnerDisplayName: "Ada", authorAgentId: "default" },
      theirs,
    );
    expect(text).toBe("NovaOwned by Ada");
    expect(screen.queryByTestId("chats-post-agent-runs-with")).toBeNull();
  });

  it("finds your agent only by the id its run's message carries", () => {
    expect(tooltipFor({ authorDisplayName: "Atlas", authorAgentId: "default" }, mine)).toContain(
      "Your runner command",
    );
    cleanup();
    for (const name of ["Agent", "Nova"]) {
      expect(
        tooltipFor(
          { authorDisplayName: name },
          mine,
          settingsWithAgent({ name, launch: { command: "local-tool" } }, ada),
        ),
      ).not.toContain("Your runner command");
      cleanup();
    }
    expect(tooltipFor({ authorDisplayName: "Nova", authorAgentId: "codex" }, mine)).not.toContain(
      "Your runner command",
    );
  });

  it("closes on Escape, and stays open while it has focus", () => {
    render(
      <AgentBadge
        testIdPrefix="chats-post"
        author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada" }}
        presentation={theirs}
      />,
    );
    const badge = screen.getByTestId("chats-post-agent-badge");
    expect(badge.tabIndex).toBe(0);
    badge.focus();
    fireEvent.focus(badge);
    fireEvent.mouseLeave(badge.parentElement!);
    expect(screen.getByRole("tooltip", { hidden: true })).not.toBeNull();
    fireEvent.keyDown(badge, { key: "Escape" });
    expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
  });

  it("opens its details without opening the containing post", () => {
    const onOpen = vi.fn();
    render(
      <div onClick={onOpen}>
        <AgentBadge
          testIdPrefix="chats-post"
          author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada" }}
        />
      </div>,
    );
    fireEvent.click(screen.getByTestId("chats-post-agent-badge"));
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toContain("Owned by Ada");
    expect(onOpen).not.toHaveBeenCalled();
  });
});
