import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLI_PROTOCOL_VERSION,
  type CliRequestWithoutToken,
} from "./protocol";
import { executeCli } from "./index";

// buildCliRequest resolves the incoming cwd, and resolve() is drive-qualified on
// Windows ("/workspace" -> "C:\workspace"), so asserting a hard-coded POSIX
// literal only ever passed on POSIX hosts. The INPUTS below stay unresolved and
// only these EXPECTATIONS are resolved -- feeding an already-resolved path in
// would make the assertion pass even if the CLI stopped resolving at all.
const WORKSPACE = resolve("/workspace");
const PROJECT = resolve("/workspace/project");

const TOKEN = "a".repeat(64);
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-cli-index-test-"));
  cleanupDirs.push(dir);
  await writeFile(join(dir, "dohc-cli-token"), `${TOKEN}\n`, { mode: 0o600 });
  return dir;
}

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
      env: { DOHC_RUN_ID: "run_ambient" },
      readStdin: async () => "A detailed report\n",
      request: async (request) => {
        requests.push(request);
        return { threadId: "th_8f2k1c", messageId: "msg_new" };
      },
    });
    expect(requests).toEqual([
      {
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "reply",
        args: {
          cwd: PROJECT,
          actor: "agent",
          runId: "run_ambient",
          thread: "th_8f",
          attachments: [],
          needsDecision: false,
          body: "A detailed report\n",
        },
      },
    ]);
    expect(result.stdout).toBe("replied th_8f2k1c msg_new\n");
  });

  it.each([
    ["post", ["chat", "post", "general", "-"]],
    ["reply", ["chat", "reply", "th_8f", "-"]],
  ] as const)("rejects empty stdin for %s", async (_verb, argv) => {
    const request = vi.fn();
    const result = await executeCli({
      argv,
      cwd: "/workspace",
      env: {},
      readStdin: async () => " \n\t ",
      request,
    });

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dohc: stdin body is empty\n",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 30_000],
    [1_234, 1_234],
  ] as const)("uses the configured response timeout %s", async (timeoutMs, expectedTimeoutMs) => {
    const stateDir = await tempStateDir();
    const transport = vi.fn(async () => ({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: true,
      result: { channels: [] },
    }));
    const result = await executeCli({
      argv: ["chat", "channels"],
      cwd: "/workspace",
      env: {},
      client: {
        stateDir,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        transport,
        // `transport` is mocked, so no socket is opened; state the platform the
        // test exercises rather than inheriting the host's win32 refusal.
        platform: "linux",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(transport).toHaveBeenCalledWith(
      join(stateDir, "dohc-cli.sock"),
      expect.any(String),
      expectedTimeoutMs,
    );
  });

  it("passes the ambient run id through every chat write request only", async () => {
    const requests: CliRequestWithoutToken[] = [];
    const request = async (value: CliRequestWithoutToken): Promise<unknown> => {
      requests.push(value);
      if (value.verb === "post") {
        return { channel, threadId: "th_new", messageId: "msg_post", title: "Run report" };
      }
      if (value.verb === "react") {
        return {
          threadId: "th_new",
          messageId: "msg_post",
          emoji: "+1",
          state: "added" as const,
        };
      }
      return { channels: [channel] };
    };
    const common = {
      cwd: "/workspace",
      env: { DOHC_RUN_ID: "run_env" },
      request,
    };

    await executeCli({
      ...common,
      argv: ["chat", "post", "general", "--title", "Run report", "done"],
    });
    await executeCli({
      ...common,
      argv: ["chat", "react", "msg_post", "+1", "--as-agent"],
    });
    await executeCli({
      ...common,
      argv: ["chat", "channels"],
    });

    expect(requests.map((value) => ({ verb: value.verb, args: value.args }))).toEqual([
      {
        verb: "post",
        args: {
          cwd: WORKSPACE,
          actor: "human",
          runId: "run_env",
          channel: "general",
          title: "Run report",
          attachments: [],
          needsDecision: false,
          body: "done",
        },
      },
      {
        verb: "react",
        args: {
          cwd: WORKSPACE,
          actor: "agent",
          runId: "run_env",
          message: "msg_post",
          emoji: "+1",
        },
      },
      {
        verb: "channels",
        args: { cwd: WORKSPACE, actor: "human" },
      },
    ]);
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
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "show",
      args: { cwd: WORKSPACE, actor: "human", target: "th_o", peek: true },
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
