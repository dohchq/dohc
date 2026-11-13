import { describe, expect, it } from "vitest";
import { chatRunnerDeclaration } from "./chatRunnerDeclaration";

const launch = { command: "run-agent --secret-flag" };
const agent = (id: string, name: string, enabled = true) => ({ id, name, enabled, launch });

describe("a computer's runner declaration", () => {
  it("declares each agent dohc can start, on or off, with no command", () => {
    const answer = chatRunnerDeclaration({
      installId: "local:mac",
      computerLabel: "Ana's Mac",
      agents: [agent("default", "Claude"), agent("codex", "Codex", false), { id: "mine", name: "Mine", enabled: false, launch: undefined }],
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
      },
    });
    expect(JSON.stringify(answer)).not.toContain("secret-flag");
  });

  it("declares no runners to withdraw the computer", () => {
    expect(chatRunnerDeclaration({ installId: "local:mac", computerLabel: "Mac", agents: [] }))
      .toEqual({ ok: true, declaration: { installId: "local:mac", computerLabel: "Mac", runners: [] } });
  });

  it.each<[string, Parameters<typeof chatRunnerDeclaration>[0], object]>([
    ["an install ID past the relay's bound", { installId: `local:${"a".repeat(300)}`, computerLabel: "Mac", agents: [] }, { reason: "install-id" }],
    ["a label past 64 code units", { installId: "local:mac", computerLabel: "😀".repeat(40), agents: [] }, { reason: "computer-label" }],
    ["more agents than the relay keeps", {
      installId: "local:mac", computerLabel: "Mac",
      agents: Array.from({ length: 65 }, (_, index) => agent(`agent-${index}`, `Agent ${index}`)),
    }, { reason: "too-many-agents" }],
    ["a personal agent's ID", { installId: "local:mac", computerLabel: "Mac", agents: [agent("p-ana", "Ana's")] }, { reason: "agent-id", agentId: "p-ana" }],
    ["two names with one handle", {
      installId: "local:mac", computerLabel: "Mac", agents: [agent("default", "Claude"), agent("other", "claude!")],
    }, { reason: "same-name", agentId: "other" }],
  ])("refuses, rather than cuts, %s", (_name, input, refusal) => {
    expect(chatRunnerDeclaration(input)).toEqual({ ok: false, ...refusal });
  });
});
