import { describe, expect, it } from "vitest";
import {
  claudeAuth,
  claudePermissionMode,
  claudeSessionArgs,
  isFatalStderr,
  itemTypeForTool,
  mapStreamMessage,
  mcpConfigJson,
  permissionControlResponse,
  permissionRequestEvent,
  permissionTypeForTool,
  sessionAllowRules,
} from "./claudeProtocol.ts";

/**
 * What dohc sends Claude Code, and what Claude Code says back.
 *
 * Every rule here was verified against claude 2.1.233 on this machine before
 * it was written down (the evidence is in the module's own comments), so these
 * tests hold the driver to a protocol that was observed rather than assumed.
 */

const mcp = { command: "dohc-mcp", args: ["--workspace", "/work"] };

function argValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

describe("how dohc starts Claude Code", () => {
  it("asks Claude to route every tool permission to dohc", () => {
    const args = claudeSessionArgs({
      sessionId: "11111111-2222-3333-4444-555555555555",
      resume: false,
      mode: "approval-required",
      mcp,
    });

    // The one argument the whole permission seam rests on. Without it Claude
    // answers its own permission prompts and dohc is never asked.
    expect(argValue(args, "--permission-prompt-tool")).toBe("stdio");
    // A session, not one answer: input and output are both the stream format.
    expect(argValue(args, "--input-format")).toBe("stream-json");
    expect(argValue(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("-p");
    expect(args).toContain("--verbose");
  });

  it("names a new session and continues an old one, never both", () => {
    const fresh = claudeSessionArgs({
      sessionId: "session-a",
      resume: false,
      mode: "approval-required",
      mcp,
    });
    expect(argValue(fresh, "--session-id")).toBe("session-a");
    expect(fresh).not.toContain("--resume");

    const resumed = claudeSessionArgs({
      sessionId: "session-a",
      resume: true,
      mode: "approval-required",
      mcp,
    });
    expect(argValue(resumed, "--resume")).toBe("session-a");
    // `--resume` with an id Claude knows continues that conversation;
    // `--session-id` beside it would name a second one.
    expect(resumed).not.toContain("--session-id");
  });

  it("gives Claude dohc's own MCP server without dropping the user's", () => {
    const args = claudeSessionArgs({
      sessionId: "session-a",
      resume: false,
      mode: "approval-required",
      mcp: { command: "dohc-mcp", args: ["--workspace", "/work"], env: { DOHC_USER: "user-1" } },
    });

    expect(JSON.parse(argValue(args, "--mcp-config") ?? "null")).toEqual({
      mcpServers: {
        dohc: {
          command: "dohc-mcp",
          args: ["--workspace", "/work"],
          env: { DOHC_USER: "user-1" },
        },
      },
    });
    // Dropping the user's own MCP servers is what this flag would do.
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("passes a model only when dohc chose one", () => {
    const chosen = claudeSessionArgs({
      sessionId: "s",
      resume: false,
      mode: "approval-required",
      model: "opus",
      mcp,
    });
    expect(argValue(chosen, "--model")).toBe("opus");

    const unchosen = claudeSessionArgs({
      sessionId: "s",
      resume: false,
      mode: "approval-required",
      mcp,
    });
    expect(unchosen).not.toContain("--model");
  });

  it("asks Claude for the permission mode each dohc mode allows", () => {
    expect(claudePermissionMode("approval-required")).toBe("manual");
    expect(claudePermissionMode("auto-accept-edits")).toBe("acceptEdits");
    expect(claudePermissionMode("full-access")).toBe("bypassPermissions");
    // The weakest mode is the default, so a mode this driver does not know
    // asks a person rather than proceeding.
    expect(claudePermissionMode("something-new" as "approval-required")).toBe("manual");
  });

  it("carries the mode into the arguments", () => {
    const args = claudeSessionArgs({ sessionId: "s", resume: false, mode: "full-access", mcp });
    expect(argValue(args, "--permission-mode")).toBe("bypassPermissions");
  });

  it("keeps the MCP config one argument, whatever the paths hold", () => {
    const json = mcpConfigJson({ command: "dohc-mcp", args: ["--workspace", "C:\\a b\\work"] });
    expect(json).not.toContain("\n");
    expect(JSON.parse(json)).toMatchObject({
      mcpServers: { dohc: { args: ["--workspace", "C:\\a b\\work"] } },
    });
  });
});

describe("what the login probe reports", () => {
  it("reports a login that is there", () => {
    expect(
      claudeAuth(0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c" })),
    ).toEqual({ status: "authenticated", label: "claude.ai" });
  });

  it("keeps the account's email address out of what dohc sees", () => {
    const auth = claudeAuth(
      0,
      JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c" }),
    );
    expect(auth.email).toBeUndefined();
    expect(JSON.stringify(auth)).not.toContain("a@b.c");
  });

  it("reports a missing login as a missing login", () => {
    // The whole point of probing: an installed Claude Code that nobody is
    // logged into must not read as "unknown", and must never read as absent.
    const auth = claudeAuth(0, JSON.stringify({ loggedIn: false }));
    expect(auth.status).toBe("unauthenticated");
    expect(auth.loginHint ?? "").toContain("log in");
  });

  it("says it does not know when Claude did not say", () => {
    expect(claudeAuth(0, "Logged in as somebody").status).toBe("unknown");
    expect(claudeAuth(1, "").status).toBe("unknown");
    expect(claudeAuth(0, JSON.stringify({ account: "someone" })).status).toBe("unknown");
  });
});

describe("what Claude says, as dohc events", () => {
  const ctx = { turnId: "turn-1", cancelled: false, newId: () => "generated" };

  it("splits an assistant message into what dohc renders", () => {
    const events = mapStreamMessage(
      {
        type: "assistant",
        message: {
          id: "msg-1",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Considering." },
            { type: "text", text: "Writing." },
            { type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "notes/a.md" } },
          ],
        },
      },
      ctx,
    );

    expect(events).toEqual([
      { kind: "text-delta", itemId: "msg-1", stream: "reasoning", text: "Considering." },
      { kind: "text-delta", itemId: "msg-1", stream: "assistant", text: "Writing." },
      {
        kind: "item",
        phase: "started",
        item: {
          id: "tool-1",
          type: "file_change",
          title: "Write",
          status: "in_progress",
          locations: ["notes/a.md"],
        },
      },
    ]);
  });

  it("ends the turn dohc is waiting on, with what it cost", () => {
    const events = mapStreamMessage(
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done.",
        usage: { input_tokens: 11, output_tokens: 7 },
      },
      ctx,
    );

    expect(events).toEqual([
      { kind: "token-usage", used: 18, input: 11, output: 7 },
      { kind: "turn-completed", turnId: "turn-1", status: "completed", errorMessage: undefined },
    ]);
  });

  it("reports a failed turn as failed, and a cancelled one as cancelled", () => {
    // `subtype` says "success" on a result that carries an error, so the
    // status has to come from `is_error`.
    const failed = mapStreamMessage(
      { type: "result", subtype: "success", is_error: true, result: "Refused." },
      ctx,
    );
    expect(failed).toContainEqual({
      kind: "turn-completed",
      turnId: "turn-1",
      status: "failed",
      errorMessage: "Refused.",
    });

    const cancelled = mapStreamMessage(
      { type: "result", subtype: "success", is_error: false },
      { ...ctx, cancelled: true },
    );
    expect(cancelled).toContainEqual({
      kind: "turn-completed",
      turnId: "turn-1",
      status: "cancelled",
      errorMessage: undefined,
    });
  });

  it("closes a tool item when its result comes back", () => {
    expect(
      mapStreamMessage(
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true }],
          },
        },
        ctx,
      ),
    ).toEqual([
      {
        kind: "item",
        phase: "completed",
        item: { id: "tool-1", type: "tool_call", title: "Tool failed", status: "failed" },
      },
    ]);
  });

  it("says so when Claude answered a permission dohc never saw", () => {
    // This is what the stream looks like when the permission argument did not
    // reach Claude: it denies on dohc's behalf and reports it afterwards.
    expect(
      mapStreamMessage({ type: "system", subtype: "permission_denied", tool_name: "Write" }, ctx),
    ).toEqual([
      { kind: "error", message: "Claude denied Write without asking dohc.", fatal: false },
    ]);
  });

  it("drops what dohc has no meaning for, including Claude's own payloads", () => {
    expect(mapStreamMessage({ type: "system", subtype: "init", tools: ["Write"] }, ctx)).toEqual([]);
    expect(mapStreamMessage({ type: "system", subtype: "thinking_tokens" }, ctx)).toEqual([]);
    expect(mapStreamMessage("not a message", ctx)).toEqual([]);
    expect(mapStreamMessage({ type: "rate_limit_event" }, ctx)).toEqual([
      { kind: "auth", event: "rate-limits", detail: "Claude reported its rate limits." },
    ]);
  });

  it("knows which stderr line ends the session", () => {
    expect(isFatalStderr("No conversation found with session ID: abc")).toBe(true);
    expect(isFatalStderr("warning: something is deprecated")).toBe(false);
  });
});

describe("what a tool is, to dohc", () => {
  it("names the kind of work each tool does", () => {
    expect(itemTypeForTool("Write")).toBe("file_change");
    expect(itemTypeForTool("Bash")).toBe("command");
    expect(itemTypeForTool("mcp__dohc__read_file")).toBe("mcp_tool_call");
    expect(itemTypeForTool("WebSearch")).toBe("web_search");
    expect(itemTypeForTool("TodoWrite")).toBe("plan");
    expect(itemTypeForTool("Read")).toBe("tool_call");
  });

  it("names what a person is being asked to allow", () => {
    expect(permissionTypeForTool("Write")).toBe("file-change");
    expect(permissionTypeForTool("Bash")).toBe("command");
    expect(permissionTypeForTool("Read")).toBe("file-read");
    expect(permissionTypeForTool("mcp__dohc__write_file")).toBe("tool");
    expect(permissionTypeForTool("Anything")).toBe("tool");
  });
});

describe("a permission, both ways", () => {
  const request = {
    subtype: "can_use_tool",
    tool_name: "Write",
    display_name: "Write",
    description: "notes/a.md",
    input: { file_path: "notes/a.md", content: "secret contents" },
    permission_suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Write", ruleContent: "notes/**" }],
        behavior: "allow",
        destination: "session",
      },
      {
        type: "addRules",
        rules: [{ toolName: "Write", ruleContent: "**" }],
        behavior: "allow",
        destination: "localSettings",
      },
      { type: "setMode", mode: "acceptEdits" },
    ],
  };

  it("asks dohc about the tool without handing over what it carries", () => {
    const event = permissionRequestEvent(request, "req-1");

    expect(event).toEqual({
      kind: "permission-request",
      requestId: "req-1",
      requestType: "file-change",
      title: "Write",
      detail: "notes/a.md",
      locations: ["notes/a.md"],
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Allow for session", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    // The file's whole new contents stay in the driver, which needs them to
    // answer. dohc is told what is being asked, not what is being written.
    expect(JSON.stringify(event)).not.toContain("secret contents");
  });

  it("shows the command a person is being asked to approve", () => {
    const event = permissionRequestEvent(
      {
        subtype: "can_use_tool",
        tool_name: "Bash",
        display_name: "Bash",
        description: "Remove the build output",
        input: { command: "rm -rf dist" },
      },
      "req-2",
    );

    // Approving "Bash" tells a person nothing. Approving `rm -rf dist` does.
    expect(event.title).toBe("rm -rf dist");
    expect(event.requestType).toBe("command");
    expect(event.detail).toBe("Remove the build output");
  });

  it("does not put a tool's arguments in the title of anything else", () => {
    const event = permissionRequestEvent(
      {
        subtype: "can_use_tool",
        tool_name: "mcp__dohc__write_file",
        display_name: "dohc: write file",
        input: { command: "not a shell command", body: "secret contents" },
      },
      "req-3",
    );

    expect(event.title).toBe("dohc: write file");
    expect(JSON.stringify(event)).not.toContain("secret contents");
    expect(JSON.stringify(event)).not.toContain("not a shell command");
  });

  it("runs the tool Claude asked about, with the input Claude asked about", () => {
    expect(permissionControlResponse("req-1", "allow_once", request)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: {
          behavior: "allow",
          updatedInput: { file_path: "notes/a.md", content: "secret contents" },
        },
      },
    });
  });

  it("keeps 'for session' inside the session", () => {
    const answered = permissionControlResponse("req-1", "allow_always", request);
    const permissions = answered.response.response.updatedPermissions;

    // Only the allow rules, and only for this session: a `setMode` suggestion
    // would widen every later tool call, and a `localSettings` one would write
    // the user's own Claude configuration from a click that said "session".
    expect(permissions).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Write", ruleContent: "notes/**" }],
        behavior: "allow",
        destination: "session",
      },
      {
        type: "addRules",
        rules: [{ toolName: "Write", ruleContent: "**" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
    expect(JSON.stringify(permissions)).not.toContain("localSettings");
    expect(JSON.stringify(permissions)).not.toContain("setMode");
  });

  it("carries no rules when the answer was only for this once", () => {
    const once = permissionControlResponse("req-1", "allow_once", request);
    expect(once.response.response.updatedPermissions).toBeUndefined();
  });

  it("stops the tool when dohc says no", () => {
    for (const decision of ["reject_once", "reject_always", "cancel"] as const) {
      const answered = permissionControlResponse("req-1", decision, request);
      expect(answered.response.response.behavior).toBe("deny");
      expect(answered.response.response.updatedInput).toBeUndefined();
    }
    expect(permissionControlResponse("req-1", "cancel", request).response.response.message).toBe(
      "dohc cancelled this request.",
    );
  });

  it("forwards nothing a suggestion did not offer", () => {
    expect(sessionAllowRules({ permission_suggestions: [{ type: "setMode", mode: "auto" }] }))
      .toEqual([]);
    expect(sessionAllowRules({})).toEqual([]);
    expect(sessionAllowRules("nonsense")).toEqual([]);
  });
});
