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

const group = {
  id: "ch_general",
  name: "General",
  slug: "general",
  kind: "group" as const,
};

describe("executeCli", () => {
  it("prints stable JSON with a schemaVersion field", async () => {
    const result = await executeCli({
      argv: ["chat", "groups", "--json"],
      cwd: "/workspace",
      env: {},
      request: async () => ({ groups: [group] }),
    });
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify({ schemaVersion: 2, groups: [group] }, null, 2)}\n`,
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
        schemaVersion: 2,
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
      result: { groups: [] },
    }));
    const result = await executeCli({
      argv: ["chat", "groups"],
      cwd: "/workspace",
      env: {},
      client: {
        stateDir,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        transport,
        // `transport` is mocked, so no socket is opened; state the platform the
        // test exercises rather than inheriting the host's endpoint layout.
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
        return { group, threadId: "th_new", messageId: "msg_post", title: "Run report" };
      }
      if (value.verb === "react") {
        return {
          threadId: "th_new",
          messageId: "msg_post",
          emoji: "+1",
          state: "added" as const,
        };
      }
      return { groups: [group] };
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
      argv: ["chat", "groups"],
    });

    expect(requests.map((value) => ({ verb: value.verb, args: value.args }))).toEqual([
      {
        verb: "post",
        args: {
          cwd: WORKSPACE,
          actor: "human",
          runId: "run_env",
          group: "general",
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
        verb: "groups",
        args: { cwd: WORKSPACE, actor: "human" },
      },
    ]);
  });

  it("sends show --peek without consuming read state", async () => {
    const request = vi.fn(async () => ({
      dispatch: { paused: "budget", lastRun: null },
      thread: {
        id: "th_one",
        title: "One",
        group,
        commentCount: 0,
        openDecisionCount: 0,
      },
      messages: [
        {
          id: "msg_one",
          author: { kind: "human" as const, displayName: "Sam" },
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
    expect(result.stdout).toContain('dispatch: {"paused":"budget","lastRun":null}');
    const json = await executeCli({ argv: ["chat", "show", "th_o", "--peek", "--json"], cwd: "/workspace", env: {}, request });
    expect(JSON.parse(json.stdout)).toMatchObject({ dispatch: { paused: "budget", lastRun: null } });
  });

  it("lists one file's history and prints the text one change left", async () => {
    const change = {
      id: "moment-2",
      recordedAtMs: Date.UTC(2026, 8, 25, 12),
      source: "workspace-engine" as const,
      operation: "write" as const,
      path: "notes/plan.md",
      versionId: "main",
      authors: [{ kind: "agent" as const, agentId: "claude", onBehalfOf: "user:ice" }],
      fileCount: 1 as const,
    };
    const list = vi.fn(async () => ({ changes: [change], count: 1, totalAvailable: 3, hasMore: true, cursorMs: change.recordedAtMs }));
    const listed = await executeCli({ argv: ["history", "list", "plan.md", "--limit", "1"], cwd: "/workspace/notes", env: {}, request: list });
    expect(list).toHaveBeenCalledWith({
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "moments",
      args: { cwd: resolve("/workspace/notes"), actor: "human", limit: 1, path: "plan.md" },
    });
    expect(listed).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "moment-2 · 2026-09-25T12:00:00.000Z · write · notes/plan.md · agent claude\n2 more; raise --limit to list them\n",
    });

    const detail = {
      ok: true as const,
      change: {
        ...change,
        files: [{ path: "notes/plan.md", operation: "write" as const }],
        before: { path: "notes/plan.md", text: "# Plan\n" },
        after: { path: "notes/plan.md", text: "# Plan\n\nShip Friday.\n" },
      },
    };
    const show = vi.fn(async () => detail);
    expect(await executeCli({ argv: ["history", "show", "moment-2"], cwd: "/workspace", env: {}, request: show })).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "# Plan\n\nShip Friday.\n",
    });
    expect(show).toHaveBeenCalledWith({
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "moment",
      args: { cwd: WORKSPACE, actor: "human", id: "moment-2" },
    });
    expect((await executeCli({ argv: ["history", "show", "moment-2", "--before"], env: {}, request: show })).stdout).toBe("# Plan\n");

    // Text prints byte for byte, so a redirect reproduces a file with no final newline.
    const bare = { ...detail, change: { ...detail.change, after: { path: "notes/plan.md", text: "abc" } } };
    expect((await executeCli({ argv: ["history", "show", "moment-2"], env: {}, request: async () => bare })).stdout).toBe("abc");

    const created = { ...detail, change: { ...detail.change, before: null } };
    expect(await executeCli({ argv: ["history", "show", "moment-2", "--before"], env: {}, request: async () => created })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dohc: moment-2 created notes/plan.md; it has no text before it\n",
    });
    expect(await executeCli({ argv: ["history", "show", "moment-9", "--json"], env: {}, request: async () => ({ ok: false, reason: "change not found: moment-9" }) })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dohc: change not found: moment-9\n",
    });
  });

  it("lists an automation's runs and shows what one run's steps changed", async () => {
    const run = {
      run: "atc_1", state: "failed" as const, error: "The record is open elsewhere.",
      createdAtMs: Date.UTC(2026, 8, 27, 9), updatedAtMs: Date.UTC(2026, 8, 27, 9),
      trigger: { kind: "changed" as const, recordId: "rec_1", by: "agent" as const, depth: 1 },
      definitionChanged: false, chainStopped: false, undone: false,
    };
    const list = vi.fn(async () => ({ ok: true, runs: [{ ...run, changes: 1 }] }));
    expect(await executeCli({ argv: ["automation", "runs", "tasks", "stamp"], cwd: "/workspace", env: {}, request: list })).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "atc_1 · 2026-09-27T09:00:00.000Z · failed · record changed · record rec_1 · by agent · depth 1 · 1 change · The record is open elsewhere.\n",
    });
    expect(list).toHaveBeenCalledWith({
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "automationRuns",
      args: { cwd: WORKSPACE, actor: "human", collectionPath: "tasks", automation: "stamp" },
    });

    const steps = [
      { step: 1, changes: [{ kind: "field", recordId: "rec_1", path: "tasks/one.md", field: "Done", before: null, after: "2026-09-27" }] },
      { step: 3, changes: [{ kind: "message", messageId: "message-1", name: "Team" }] },
      { step: 4, changes: [{
        kind: "dataset-action", rules: { datasetId: "ds_1", revision: 2, revisionSha256: "a".repeat(64) },
        operationId: "op_send", tableId: "tbl_invoices", name: "Send invoice", revision: 3,
      }] },
    ];
    const show = vi.fn(async () => ({ ok: true, run: { ...run, steps, failedStep: 3, startsOver: false } }));
    expect((await executeCli({ argv: ["automation", "run", "tasks", "stamp", "atc_1"], cwd: "/workspace", env: {}, request: show })).stdout).toBe([
      "atc_1 · 2026-09-27T09:00:00.000Z · failed",
      "trigger: record changed · record rec_1 · by agent · depth 1",
      "error: The record is open elsewhere.",
      "step 3 failed",
      "Try again resumes at step 3.",
      "step 1:",
      '  set Done on tasks/one.md: null -> "2026-09-27"',
      "step 3:",
      "  posted to Team · message-1",
      "step 4:",
      "  ran Send invoice in table tbl_invoices",
      "",
    ].join("\n"));
    expect(JSON.parse((await executeCli({ argv: ["automation", "run", "tasks", "stamp", "atc_1", "--json"], env: {}, request: show })).stdout))
      .toEqual({ schemaVersion: 2, ok: true, run: { ...run, steps, failedStep: 3, startsOver: false } });
    // A changed automation's run does not resume; Try again starts over.
    const changed = async () => ({ ok: true, run: { ...run, definitionChanged: true, steps, failedStep: 3, startsOver: true } });
    const changedText = (await executeCli({ argv: ["automation", "run", "tasks", "stamp", "atc_1"], env: {}, request: changed })).stdout;
    expect(changedText).toContain("step 3 failed\nTry again starts over from step 1 and needs --start-over.\n");
    expect(changedText).not.toContain("resumes");
    expect(await executeCli({ argv: ["automation", "run", "tasks", "stamp"], env: {}, request: show })).toEqual({
      exitCode: 1, stdout: "", stderr: "dohc: automation run requires a run id\n",
    });
  });

  it("presses a button, prints the run it started, and exits with the actions to confirm", async () => {
    const send = vi.fn(async (request: CliRequestWithoutToken) =>
      request.verb === "automationPress" && request.args.confirm.includes("sendInvoice")
        ? { ok: true, run: "atc_1", outcome: null, error: null, waiting: "Waiting to check who can edit this Collection." }
        : {
            ok: false,
            reason: 'This press runs actions dohc cannot undo: "Send invoice" (--confirm sendInvoice). Confirm each by name to run them.',
            confirm: [{ name: "sendInvoice", label: "Send invoice" }],
          });
    expect(await executeCli({ argv: ["automation", "press", "Billing", "Send", "12"], env: {}, request: send })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: 'dohc: This press runs actions dohc cannot undo: "Send invoice" (--confirm sendInvoice). Confirm each by name to run them.\n',
    });
    expect(await executeCli({
      argv: ["automation", "press", "Billing", "Send", "12", "--table", "Invoices", "--confirm", "sendInvoice", "--request-id", "press-1"],
      cwd: "/workspace",
      env: {},
      request: send,
    })).toEqual({ exitCode: 0, stderr: "", stdout: "started run atc_1\nWaiting to check who can edit this Collection.\n" });
    expect(send).toHaveBeenLastCalledWith({
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "automationPress",
      args: {
        cwd: WORKSPACE, actor: "human", collectionPath: "Billing", field: "Send", record: "12",
        table: "Invoices", confirm: ["sendInvoice"], requestId: "press-1",
      },
    });
    const ended = async () => ({ ok: true, run: "atc_1", outcome: "failed", error: "Paid is not a field.", waiting: null });
    expect((await executeCli({ argv: ["automation", "press", "Billing", "Send", "12"], env: {}, request: ended })).stdout)
      .toBe("run atc_1 failed: Paid is not a field.\n");
    const relayed = async () => ({ ok: true, relayed: true });
    expect((await executeCli({ argv: ["automation", "press", "Trip", "Book", "rec_1"], env: {}, request: relayed })).stdout)
      .toBe("sent to the owner's computer, which runs it\n");
    // A flag value that looks like a global flag stays the flag's value.
    const record = vi.fn(send);
    await executeCli({ argv: ["automation", "press", "Billing", "Send", "12", "--confirm", "--json"], env: {}, request: record });
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ args: expect.objectContaining({ confirm: ["--json"] }) }));
    expect(await executeCli({ argv: ["automation", "press", "Billing", "Send"], env: {}, request: send })).toEqual({
      exitCode: 1, stdout: "", stderr: "dohc: automation press requires a Collection, a button, and a record\n",
    });
  });

  it("tries a run again, and exits with the reason it refused", async () => {
    const send = vi.fn(async (request: CliRequestWithoutToken) =>
      request.verb === "automationRetry" && request.args.startOver
        ? { ok: true, status: "queued" }
        : { ok: false, status: "definition-changed", repeatsMessages: false, reason: "This automation changed since the run failed. To do that, try again with --start-over, or startOver: true." });
    expect(await executeCli({ argv: ["automation", "retry", "tasks", "stamp", "atc_1"], env: {}, request: send })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dohc: This automation changed since the run failed. To do that, try again with --start-over, or startOver: true.\n",
    });
    expect(await executeCli({ argv: ["automation", "retry", "tasks", "stamp", "atc_1", "--start-over"], cwd: "/workspace", env: {}, request: send })).toEqual({
      exitCode: 0, stderr: "", stdout: "queued\n",
    });
    expect(send).toHaveBeenLastCalledWith({
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "automationRetry",
      args: { cwd: WORKSPACE, actor: "human", collectionPath: "tasks", automation: "stamp", run: "atc_1", startOver: true },
    });

    const elsewhere = async () => ({
      ok: false,
      reason: "Only the computer this run failed on can try it again. The notice names that computer.",
      notice: { title: 'Automation "Stamp" failed', body: "The record is open elsewhere. It ran on Laptop." },
    });
    expect((await executeCli({ argv: ["automation", "retry", "tasks", "stamp", "atc_1"], env: {}, request: elsewhere })).stderr).toBe(
      'dohc: Only the computer this run failed on can try it again. The notice names that computer. Automation "Stamp" failed: The record is open elsewhere. It ran on Laptop.\n',
    );
  });

  it("refuses a history list limit past the desktop's bound before sending", async () => {
    const send = vi.fn();
    expect(await executeCli({ argv: ["history", "list", "--limit", "501"], env: {}, request: send })).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "dohc: --limit accepts at most 500\n",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("returns exactly one stderr line and exit 1", async () => {
    const result = await executeCli({
      argv: ["chat", "groups"],
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
      argv: ["chat", "groups"],
      env: {},
      request: async () => ({ groups: [{ id: 7 }] }),
    });
    expect(result.stderr).toBe("dohc: desktop app returned an invalid response\n");
  });
});
