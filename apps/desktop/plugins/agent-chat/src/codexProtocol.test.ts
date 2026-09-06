import { describe, expect, it } from "vitest";
import {
  approvalRequest,
  approvalRequestId,
  codexDecision,
  codexRuntimePolicy,
  codexThreadId,
  defaultPermissionOptions,
  isApprovalMethod,
  isFatalStderr,
  mapNotification,
  textFromContent,
  turnStatus,
} from "./codexProtocol.ts";

const id = () => "generated-id";

describe("dohc's modes as Codex's sandbox", () => {
  // The three pairs are Codex's own: `codex --sandbox` accepts exactly these
  // three sandbox values and `codex --ask-for-approval` exactly these three
  // approval values (codex-cli 0.146.0). Naming both halves of each pair here
  // is what makes a swapped mapping fail rather than merely differ.
  it("asks for the read-only sandbox when a person must approve", () => {
    expect(codexRuntimePolicy("approval-required", "/work")).toEqual({
      approvalPolicy: "untrusted",
      threadSandbox: "read-only",
      turnSandbox: { type: "readOnly", networkAccess: false },
    });
  });

  it("makes only the workspace writable when edits are auto-accepted", () => {
    expect(codexRuntimePolicy("auto-accept-edits", "/work")).toEqual({
      approvalPolicy: "on-request",
      threadSandbox: "workspace-write",
      turnSandbox: {
        type: "workspaceWrite",
        writableRoots: ["/work"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    });
  });

  it("drops the sandbox only for full access", () => {
    expect(codexRuntimePolicy("full-access", "/work")).toEqual({
      approvalPolicy: "never",
      threadSandbox: "danger-full-access",
      turnSandbox: { type: "dangerFullAccess" },
    });
  });

  it("writes the workspace root it was given, not a fixed path", () => {
    const policy = codexRuntimePolicy("auto-accept-edits", "/elsewhere");
    expect(policy.turnSandbox).toMatchObject({ writableRoots: ["/elsewhere"] });
  });

  it("falls back to the strictest sandbox, never a permissive one", () => {
    // A mode this driver has never heard of must not widen what Codex may do.
    const unknown = codexRuntimePolicy(
      "something-new" as Parameters<typeof codexRuntimePolicy>[0],
      "/work",
    );
    expect(unknown.threadSandbox).toBe("read-only");
    expect(unknown.approvalPolicy).toBe("untrusted");
  });
});

describe("Codex's answers as dohc's", () => {
  it("maps every decision dohc can make", () => {
    expect(codexDecision("allow_once")).toBe("accept");
    expect(codexDecision("allow_always")).toBe("acceptForSession");
    expect(codexDecision("cancel")).toBe("cancel");
    expect(codexDecision("reject_once")).toBe("decline");
    expect(codexDecision("reject_always")).toBe("decline");
  });

  it("treats an interrupted turn as cancelled and an unknown one as completed", () => {
    expect(turnStatus("interrupted")).toBe("cancelled");
    expect(turnStatus("cancelled")).toBe("cancelled");
    expect(turnStatus("failed")).toBe("failed");
    expect(turnStatus("completed")).toBe("completed");
    expect(turnStatus(undefined)).toBe("completed");
  });

  it("offers the three options dohc's permission surface shows", () => {
    expect(defaultPermissionOptions()).toEqual([
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow for session", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ]);
  });
});

describe("which requests this driver answers", () => {
  it("answers Codex's four approval requests and no others", () => {
    expect(isApprovalMethod("item/commandExecution/requestApproval")).toBe(true);
    expect(isApprovalMethod("item/fileChange/requestApproval")).toBe(true);
    expect(isApprovalMethod("applyPatchApproval")).toBe(true);
    expect(isApprovalMethod("execCommandApproval")).toBe(true);
    expect(isApprovalMethod("item/tool/requestUserInput")).toBe(false);
    expect(isApprovalMethod("account/chatgptAuthTokens/refresh")).toBe(false);
    expect(isApprovalMethod("requestApproval")).toBe(false);
  });

  it("calls a file change a file change and everything else a command", () => {
    expect(
      approvalRequest("item/fileChange/requestApproval", {}, "r1").requestType,
    ).toBe("file-change");
    expect(
      approvalRequest("item/commandExecution/requestApproval", {}, "r1").requestType,
    ).toBe("command");
    expect(approvalRequest("execCommandApproval", {}, "r1").requestType).toBe("command");
  });

  it("shows the command Codex named, and its reason", () => {
    expect(
      approvalRequest(
        "item/commandExecution/requestApproval",
        { command: "rm -rf /", reason: "tidying up", locations: ["/", 7] },
        "r1",
      ),
    ).toEqual({
      kind: "permission-request",
      requestId: "r1",
      requestType: "command",
      title: "rm -rf /",
      detail: "tidying up",
      locations: ["/"],
      options: defaultPermissionOptions(),
    });
  });

  it("names an unnamed request rather than showing an empty one", () => {
    expect(approvalRequest("item/fileChange/requestApproval", {}, "r1").title).toBe(
      "File change",
    );
    expect(
      approvalRequest("item/commandExecution/requestApproval", {}, "r1").title,
    ).toBe("Command");
  });

  it("prefers the approval id Codex gave, and reports when it gave none", () => {
    expect(approvalRequestId({ approvalId: "a", itemId: "b", requestId: "c" })).toBe("a");
    expect(approvalRequestId({ itemId: "b", requestId: "c" })).toBe("b");
    expect(approvalRequestId({ requestId: "c" })).toBe("c");
    expect(approvalRequestId({})).toBeUndefined();
    expect(approvalRequestId({ approvalId: "" })).toBeUndefined();
    expect(approvalRequestId("not an object")).toBeUndefined();
  });
});

describe("a lost websocket ends the session", () => {
  it("is the one stderr line that arrives fatal", () => {
    expect(isFatalStderr("ERROR failed to connect to websocket: timeout")).toBe(true);
    expect(isFatalStderr("Failed To Connect To WebSocket")).toBe(true);
    expect(isFatalStderr("warning: models cache missing a field")).toBe(false);
  });
});

describe("finding the thread Codex started", () => {
  it("reads either shape Codex uses, and neither from a non-object", () => {
    expect(codexThreadId({ threadId: "t1" })).toBe("t1");
    expect(codexThreadId({ thread: { id: "t2" } })).toBe("t2");
    expect(codexThreadId({ threadId: "t1", thread: { id: "t2" } })).toBe("t1");
    expect(codexThreadId({})).toBeUndefined();
    expect(codexThreadId(null)).toBeUndefined();
  });
});

describe("text out of Codex's content shapes", () => {
  it("joins arrays, reads objects, and returns nothing for the rest", () => {
    expect(textFromContent("plain")).toBe("plain");
    expect(textFromContent({ text: "inner" })).toBe("inner");
    expect(textFromContent({ content: "inner" })).toBe("inner");
    expect(textFromContent([{ text: "a" }, "b", { content: "c" }])).toBe("abc");
    expect(textFromContent(42)).toBe("");
  });
});

describe("Codex's notifications as dohc's events", () => {
  it("streams assistant text and reasoning on their own streams", () => {
    expect(
      mapNotification("item/agentMessage/delta", { itemId: "a1", delta: "hi" }, id),
    ).toEqual({ kind: "text-delta", itemId: "a1", stream: "assistant", text: "hi" });
    expect(
      mapNotification("item/reasoning/textDelta", { itemId: "r1", delta: "why" }, id),
    ).toEqual({ kind: "text-delta", itemId: "r1", stream: "reasoning", text: "why" });
    expect(
      mapNotification("item/reasoning/summaryTextDelta", { delta: "sum" }, id),
    ).toEqual({ kind: "text-delta", itemId: "reasoning", stream: "reasoning", text: "sum" });
  });

  it("names an unidentified delta rather than dropping it", () => {
    expect(mapNotification("item/agentMessage/delta", { delta: "hi" }, id)).toMatchObject({
      itemId: "assistant",
    });
  });

  it("reports an item's phase from the method, not from its status", () => {
    const started = mapNotification(
      "item/started",
      { item: { id: "c1", type: "command", title: "ls", status: "completed" } },
      id,
    );
    expect(started).toMatchObject({ phase: "started" });
    expect(started).toMatchObject({ item: { status: "in_progress" } });

    const completed = mapNotification(
      "item/completed",
      { item: { id: "c1", type: "command", title: "ls" } },
      id,
    );
    expect(completed).toMatchObject({ phase: "completed" });
    expect(completed).toMatchObject({ item: { status: "completed" } });
  });

  it("keeps the two item types dohc renders and calls the rest other", () => {
    const typeOf = (type: unknown): unknown => {
      const event = mapNotification("item/started", { item: { id: "i", type } }, id);
      return event?.kind === "item" ? event.item.type : undefined;
    };
    expect(typeOf("command")).toBe("command");
    expect(typeOf("file_change")).toBe("file_change");
    expect(typeOf("mcp_tool_call")).toBe("other");
    expect(typeOf(undefined)).toBe("other");
  });

  it("gives an item without an id one, so dohc can address it", () => {
    expect(mapNotification("item/started", { item: {} }, id)).toMatchObject({
      item: { id: "generated-id", title: "Agent item" },
    });
    expect(mapNotification("item/started", { itemId: "from-params", item: {} }, id))
      .toMatchObject({ item: { id: "from-params" } });
  });

  it("reads token usage out of the nested total Codex reports", () => {
    expect(
      mapNotification(
        "thread/tokenUsage/updated",
        { usage: { total: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } } },
        id,
      ),
    ).toEqual({ kind: "token-usage", used: 18, input: 11, output: 7 });
  });

  it("reports zero rather than a number dohc cannot show", () => {
    expect(
      mapNotification("thread/tokenUsage/updated", { usage: { total: {} } }, id),
    ).toMatchObject({ kind: "token-usage", used: 0 });
  });

  it("carries a turn's failure through with its message", () => {
    expect(
      mapNotification(
        "turn/completed",
        { turn: { id: "t9", status: "failed", error: "it broke" } },
        id,
      ),
    ).toEqual({
      kind: "turn-completed",
      turnId: "t9",
      status: "failed",
      errorMessage: "it broke",
    });
  });

  it("reports an error as retriable only when Codex says it will retry", () => {
    expect(
      mapNotification("error", { error: { message: "boom" }, willRetry: true }, id),
    ).toEqual({ kind: "error", message: "boom", fatal: false });
    expect(mapNotification("error", { error: { message: "boom" } }, id)).toEqual({
      kind: "error",
      message: "boom",
      fatal: true,
    });
  });

  it("names an account event without repeating the account's detail", () => {
    expect(mapNotification("account/rateLimits/updated", { plan: "pro" }, id)).toEqual({
      kind: "auth",
      event: "rate-limits",
      detail: "Rate limits updated.",
    });
    expect(
      mapNotification("mcpServer/oauthLogin/completed", { token: "secret" }, id),
    ).toEqual({ kind: "auth", event: "mcp-oauth-completed", detail: "MCP OAuth completed." });
  });

  it("drops a notification dohc has no event for", () => {
    expect(mapNotification("thread/started", { thread: { id: "t" } }, id)).toBeNull();
    expect(mapNotification("mcpServer/startupStatus/updated", {}, id)).toBeNull();
    expect(mapNotification("something/new", {}, id)).toBeNull();
  });

  it("never carries Codex's own payload into an event", () => {
    // The event union has no field for it, and this is the boundary that has
    // to hold: a provider payload carries tool arguments and account detail.
    const event = mapNotification(
      "item/completed",
      { item: { id: "c1", type: "command", title: "ls", secret: "provider payload" } },
      id,
    );
    expect(JSON.stringify(event)).not.toContain("provider payload");
  });
});
