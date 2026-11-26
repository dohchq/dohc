import { describe, expect, it } from "vitest";
import { chatRunnerDeclaration } from "./chatRunnerDeclaration";

const launch = { command: "run-agent --secret-flag" };
const agent = (id: string, name: string, enabled = true) => ({ id, name, enabled, launch });

describe("a computer's runner declaration", () => {
  it("declares each agent dohc can start, on or off, with no command, and the others by name", () => {
    const answer = chatRunnerDeclaration({
      installId: "local:mac",
      computerLabel: "Ana's Mac",
      agents: [
        agent("default", "Claude"),
        agent("codex", "Codex", false),
        { id: "mine", name: "Mine", enabled: false, launch: undefined },
      ],
    });
    expect(answer).toEqual({
      ok: true,
      declaration: {
        installId: "local:mac",
        computerLabel: "Ana's Mac",
        runners: [
          { agentId: "default", displayName: "Claude", enabled: true },
          { agentId: "codex", displayName: "Codex", enabled: false },
        ],
        agents: [{ agentId: "mine", displayName: "Mine" }],
      },
    });
    expect(JSON.stringify(answer)).not.toContain("secret-flag");
  });

  it("declares an empty list for a computer with no agents", () => {
    expect(
      chatRunnerDeclaration({ installId: "local:mac", computerLabel: "Mac", agents: [] }),
    ).toEqual({
      ok: true,
      declaration: { installId: "local:mac", computerLabel: "Mac", runners: [], agents: [] },
    });
  });

  it("sends the list as unknown, not the runners refused, when another agent can't be sent", () => {
    const answer = chatRunnerDeclaration({
      installId: "local:mac",
      computerLabel: "Mac",
      agents: [
        agent("default", "Claude"),
        { id: "mine", name: " padded ", enabled: true, launch: undefined },
      ],
    });
    expect(answer).toEqual({
      ok: true,
      declaration: {
        installId: "local:mac",
        computerLabel: "Mac",
        runners: [{ agentId: "default", displayName: "Claude", enabled: true }],
        agents: null,
      },
    });
  });

  it.each<[string, Parameters<typeof chatRunnerDeclaration>[0], object]>([
    [
      "an install ID past the relay's bound",
      { installId: `local:${"a".repeat(300)}`, computerLabel: "Mac", agents: [] },
      { reason: "install-id" },
    ],
    [
      "a label past 64 code units",
      { installId: "local:mac", computerLabel: "😀".repeat(40), agents: [] },
      { reason: "computer-label" },
    ],
    [
      "more agents than the relay keeps",
      {
        installId: "local:mac",
        computerLabel: "Mac",
        agents: Array.from({ length: 65 }, (_, index) => agent(`agent-${index}`, `Agent ${index}`)),
      },
      { reason: "too-many-agents" },
    ],
    [
      "a personal agent's ID",
      { installId: "local:mac", computerLabel: "Mac", agents: [agent("p-ana", "Ana's")] },
      { reason: "agent-id", agentId: "p-ana" },
    ],
    [
      "two names with one handle",
      {
        installId: "local:mac",
        computerLabel: "Mac",
        agents: [agent("default", "Claude"), agent("other", "claude!")],
      },
      { reason: "same-name", agentId: "other" },
    ],
  ])("refuses, rather than cuts, %s", (_name, input, refusal) => {
    expect(chatRunnerDeclaration(input)).toEqual({ ok: false, ...refusal });
  });
});
