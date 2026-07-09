import { describe, expect, it, vi } from "vitest";
import type { CliRequestWithoutToken } from "./protocol";
import { executeCli } from "./index";

const channel = {
  id: "ch_general",
  name: "General",
  slug: "general",
  kind: "channel" as const,
};

describe("executeCli", () => {
  it("prints stable JSON with a schemaVersion field", async () => {
    const result = await executeCli({
      argv: ["chat", "channels", "--json"],
      cwd: "/workspace",
      env: {},
      request: async () => ({ channels: [channel] }),
    });
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify({ schemaVersion: 1, channels: [channel] }, null, 2)}\n`,
    });
  });

  it("prints only thread ids for grep -l JSON output", async () => {
    const result = await executeCli({
      argv: ["chat", "grep", "needle", "-l", "--json"],
      cwd: "/workspace",
      env: {},
      request: async () => ({ threadIds: ["th_one", "th_two"] }),
    });
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify({
        schemaVersion: 1,
        threadIds: ["th_one", "th_two"],
      }, null, 2)}\n`,
    });
  });

  it("materializes stdin and sends agent attribution", async () => {
    const requests: CliRequestWithoutToken[] = [];
    const result = await executeCli({
      argv: ["chat", "reply", "th_8f", "--as-agent", "-"],
      cwd: "/workspace/project",
      env: {},
      readStdin: async () => "A detailed report\n",
      request: async (request) => {
        requests.push(request);
        return { threadId: "th_8f2k1c", messageId: "msg_new" };
      },
    });
    expect(requests).toEqual([
      {
        protocolVersion: 1,
        verb: "reply",
        args: {
          cwd: "/workspace/project",
          actor: "agent",
          thread: "th_8f",
          attachments: [],
          needsDecision: false,
          body: "A detailed report\n",
        },
      },
    ]);
    expect(result.stdout).toBe("replied th_8f2k1c msg_new\n");
  });

  it("sends show --peek without consuming read state", async () => {
    const request = vi.fn(async () => ({
      thread: {
        id: "th_one",
        title: "One",
        channel,
        commentCount: 0,
        openDecisionCount: 0,
      },
      messages: [
        {
          id: "msg_one",
          author: { kind: "human" as const, displayName: "Ice" },
          body: "Hello",
          createdAtMs: 1,
          attachments: [],
        },
      ],
    }));
    const result = await executeCli({
      argv: ["chat", "show", "th_o", "--peek"],
      cwd: "/workspace",
      env: {},
      request,
    });
    expect(request).toHaveBeenCalledWith({
      protocolVersion: 1,
      verb: "show",
      args: { cwd: "/workspace", actor: "human", target: "th_o", peek: true },
    });
    expect(result.stdout).toContain("msg_one");
  });

  it("returns exactly one stderr line and exit 1", async () => {
    const result = await executeCli({
      argv: ["chat", "channels"],
      env: {},
      request: async () => {
        throw new Error("dohc: not inside a dohc workspace\nextra detail");
      },
    });
    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dohc: not inside a dohc workspace extra detail\n",
    });
    expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
  });

  it("hides response validation details", async () => {
    const result = await executeCli({
      argv: ["chat", "channels"],
      env: {},
      request: async () => ({ channels: [{ id: 7 }] }),
    });
    expect(result.stderr).toBe("dohc: desktop app returned an invalid response\n");
  });
});
