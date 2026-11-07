// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentBadge, AgentSettingsProvider } from "./AgentBadge";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
import { settingsWithAgent } from "../../testing/agentSettings";

const mine = { group: "agent-mine", hue: null, self: true } as const;
const theirs = { group: "agent-theirs", hue: null, self: false } as const;
const ada = { ...DEFAULT_USER_SETTINGS, profile: { preferredName: "Ada" } };

function tooltipFor(author: { authorDisplayName: string; authorOwnerDisplayName?: string; authorAgentId?: string }, presentation: typeof mine | typeof theirs, settings = settingsWithAgent({ name: "Nova", launch: { command: "local-tool --private-path" } }, ada)) {
  render(<AgentSettingsProvider settings={settings}>
    <AgentBadge testIdPrefix="chats-post" author={author} presentation={presentation} />
  </AgentSettingsProvider>);
  fireEvent.focus(screen.getByTestId("chats-post-agent-badge"));
  return screen.getByRole("tooltip", { hidden: true }).textContent ?? "";
}

afterEach(cleanup);
describe("agent badge", () => {
  it("names your agent's tool on this computer, with the full command as its tooltip", () => {
    const text = tooltipFor({ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada", authorAgentId: "default" }, mine,
      settingsWithAgent({ name: "Nova", launch: { tool: "codex", executable: "/tools/codex" } }, ada));
    expect(text).toBe("NovaOwned by AdaCodex on this computer");
    expect(screen.getByTestId("chats-post-agent-runs-with").getAttribute("title")).toContain("/tools/codex");
  });

  it("shows the owner, and how your agent runs only on your agent's message", () => {
    expect(tooltipFor({ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada", authorAgentId: "default" }, mine)).toContain("Your runner command");
    expect(screen.getByTestId("chats-post-agent-runs-with").getAttribute("title")).toBe("local-tool --private-path");
    cleanup();
    // In a shared workspace, another person's agent can carry your agent's name and id. It is still theirs.
    const text = tooltipFor({ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada", authorAgentId: "default" }, theirs);
    expect(text).toBe("NovaOwned by Ada");
    expect(screen.queryByTestId("chats-post-agent-runs-with")).toBeNull();
  });

  it("finds your agent only by the id its run's message carries", () => {
    expect(tooltipFor({ authorDisplayName: "Atlas", authorAgentId: "default" }, mine)).toContain("Your runner command");
    cleanup();
    // A connected agent with no name posts as "Agent", and an older message can
    // carry your agent's name. Neither is your agent's run.
    for (const name of ["Agent", "Nova"]) {
      expect(tooltipFor({ authorDisplayName: name }, mine, settingsWithAgent({ name, launch: { command: "local-tool" } }, ada)))
        .not.toContain("Your runner command");
      cleanup();
    }
    // An agent no longer in Settings shows no command.
    expect(tooltipFor({ authorDisplayName: "Nova", authorAgentId: "codex" }, mine)).not.toContain("Your runner command");
  });

  it("adds what the agent reported as one line, and no line when it reported nothing", () => {
    const reported = (authorReported?: { product?: string; version?: string; model?: string }) => {
      cleanup();
      render(<AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ice", ...(authorReported ? { authorReported } : {}) }} presentation={theirs} />);
      fireEvent.focus(screen.getByTestId("chats-post-agent-badge"));
      return screen.queryByTestId("chats-post-agent-reported")?.textContent ?? null;
    };
    expect(reported({ product: "Claude Code", version: "2.1", model: "Claude Opus 5.5" })).toBe("Claude Code 2.1 · Claude Opus 5.5 (as reported)");
    expect(screen.getByTestId("chats-post-agent-reported").classList.contains("wrap-anywhere")).toBe(true);
    const suffix = screen.getByTestId("chats-post-agent-reported").querySelector("span");
    expect(suffix?.textContent).toBe("(as reported)");
    expect(suffix?.classList.contains("whitespace-nowrap")).toBe(true);
    expect(reported({ product: "Claude Code", version: "2.1" })).toBe("Claude Code 2.1 (as reported)");
    expect(reported({ model: "Claude Opus 5.5" })).toBe("Claude Opus 5.5 (as reported)");
    expect(reported()).toBeNull();
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toContain("Owned by Ice");
  });

  it("names an agent that joined with a link, in olive, without an owner", () => {
    const presentation = { group: "7", hue: "plum", self: false } as const;
    render(<AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Claude Code", linkAgent: true }} presentation={presentation} />);
    const badge = screen.getByTestId("chats-post-agent-badge");
    expect(badge.getAttribute("aria-label")).toBe("agent");
    expect(badge.parentElement!.className).toContain("text-agent");
    expect(badge.parentElement!.className).not.toContain("hue");
    fireEvent.focus(badge);
    const text = screen.getByRole("tooltip", { hidden: true }).textContent ?? "";
    expect(text).toContain("Claude Code");
    expect(text).not.toContain("Owned by");
    expect(text).not.toContain("Owner name unavailable");
  });

  it("closes on Escape, and stays open while it has focus", () => {
    render(<AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada" }} presentation={theirs} />);
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
    render(<div onClick={onOpen}>
      <AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Nova", authorOwnerDisplayName: "Ada" }} />
    </div>);
    fireEvent.click(screen.getByTestId("chats-post-agent-badge"));
    expect(screen.getByRole("tooltip", { hidden: true }).textContent).toContain("Owned by Ada");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("marks a connected agent with the plug and a card that names it as reported, and your run's Claude as an agent", () => {
    const connected = { group: "agent-connected", hue: null, self: true, connected: true } as const;
    render(<AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Claude", authorOwnerDisplayName: "Ada" }} presentation={connected} />);
    const badge = screen.getByTestId("chats-post-agent-badge");
    expect(badge.getAttribute("aria-label")).toBe("connected agent");
    fireEvent.focus(badge);
    const card = screen.getByRole("tooltip").textContent ?? "";
    expect(card).toContain("Claude (as reported)");
    expect(card).toContain("Connected agent");
    expect(card).not.toContain("Owned by");
    cleanup();
    render(<AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Claude", authorOwnerDisplayName: "Ada", authorAgentId: "claude" }} presentation={mine} />);
    expect(screen.getByTestId("chats-post-agent-badge").getAttribute("aria-label")).toBe("agent");
    fireEvent.focus(screen.getByTestId("chats-post-agent-badge"));
    expect(screen.getByRole("tooltip").textContent).not.toContain("(as reported)");
  });

  it("says \"(as reported)\" once on a connected agent's card: on its reported line, else on its name", () => {
    const connected = { group: "agent-connected", hue: null, self: true, connected: true } as const;
    const card = (authorReported?: { product: string; version: string; model: string }) => {
      render(<AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: "Scout", ...(authorReported ? { authorReported } : {}) }} presentation={connected} />);
      fireEvent.focus(screen.getByTestId("chats-post-agent-badge"));
      const text = screen.getByRole("tooltip").textContent;
      cleanup();
      return text;
    };
    expect(card({ product: "Claude Code", version: "2.1", model: "Claude Opus 5.5" })).toBe("ScoutConnected agentClaude Code 2.1 · Claude Opus 5.5 (as reported)");
    expect(card()).toBe("Scout (as reported)Connected agent");
  });

  it("marks a share's agent post with the plug, and a card that claims no kind", () => {
    // A share serves no run id, so its agent posts could be a run's or a connected agent's.
    const share = { group: "agent-share", hue: null, self: false, connected: "unknown" } as const;
    for (const name of ["Scout", "Agent"]) {
      render(<AgentBadge testIdPrefix="chats-post" author={{ authorDisplayName: name, authorOwnerDisplayName: "Ada" }} presentation={share} />);
      const badge = screen.getByTestId("chats-post-agent-badge");
      expect(badge.getAttribute("aria-label")).toBe("agent");
      expect(badge.querySelector(".lucide-plug")).not.toBeNull();
      fireEvent.focus(badge);
      // No second line: neither "Connected agent" nor an owner.
      expect(screen.getByRole("tooltip").textContent).toBe(`${name} (as reported)`);
      cleanup();
    }
  });
});
