import { renderCliResult } from "./render";
import { renderThreadMarkdown } from "./threadMarkdown";
import { describe, expect, it } from "vitest";
import {
  CLI_CAPABILITIES,
  CLI_PROTOCOL_VERSION,
  MAX_FILE_WRITE_FILES,
  cliRequestSchema,
  parseCliResult,
} from "./protocol";

const token = "a".repeat(64);
const argsBase = { cwd: "C:/ws", actor: "agent" as const };

it("preserves each save-only restore queue and its incident in kept edits", () => {
  const keptEdits = ["old-1:delivery:0", "old-2:delivery:0"].map(incident => ({path: "note.md", reason: "restore-fenced",
    storedOn: "this-computer", recovery: "paused", saveOnly: true, incident}));
  expect(parseCliResult("liveKeptEdits", {ok: true, keptEdits})).toEqual({ok: true, keptEdits});
  expect(() => parseCliResult("liveKeptEdits", {ok: true, keptEdits: [{...keptEdits[0], saveOnly: false}]})).toThrow();
});

it("parses Access answers through the field allowlist and refuses caller workspace selectors", () => {
  const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "accessSharing", args: { ...argsBase, lane: "received" } };
  expect(cliRequestSchema.safeParse(request).success).toBe(true);
  expect(cliRequestSchema.safeParse({ ...request, args: { ...request.args, workspaceId: "other" } }).success).toBe(false);
  expect(cliRequestSchema.safeParse({ ...request, args: { ...request.args, accountId: "other" } }).success).toBe(false);
  const answer = parseCliResult("accessSharing", { ref: null, rows: [{ kind: "share", shareId: "share", grantId: "grant", via: "received", status: "removed",
      granterUserId: null, granterEmail: null, recipientUserId: "recipient", recipientEmail: null, subjectName: null, sharerName: null,
      selector: null, access: null, generation: null, removalMessage: "The owner removed your access." }],
    visibility: "visible", freshness: "stale", checkedAtMs: 7, unknownReason: null,
    nextCursor: null, coverage: { kind: "received-account", complete: true, observation: "interval" }, bearerUrl: "secret" });
  expect(answer).not.toHaveProperty("bearerUrl");
  expect(JSON.parse(renderCliResult("accessSharing", answer)).rows[0].removalMessage).toBe("The owner removed your access.");
});

it("accepts only CLI and MCP counting labels, with an optional label on the strict envelope", () => {
  const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "groups", args: argsBase };
  expect(cliRequestSchema.parse(request)).not.toHaveProperty("door");
  for (const door of ["cli", "mcp"]) expect(cliRequestSchema.parse({ ...request, door })).toMatchObject({ door });
  for (const door of ["automation", "renderer", "unknown", null, 1]) {
    expect(cliRequestSchema.safeParse({ ...request, door }).success).toBe(false);
  }
  expect(cliRequestSchema.safeParse({ ...request, usage: true }).success).toBe(false);
});

it("refuses a link author on every chat write, for the CLI and MCP doors alike, and reads one back", () => {
  const writes = [
    { verb: "post", args: { ...argsBase, group: "general", attachments: [], needsDecision: false, body: "Hi" } },
    { verb: "reply", args: { ...argsBase, thread: "th_1", attachments: [], needsDecision: false, body: "Hi" } },
  ];
  for (const door of ["cli", "mcp"] as const) {
    for (const write of writes) {
      const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, door, ...write };
      expect(cliRequestSchema.safeParse(request).success).toBe(true);
      expect(cliRequestSchema.safeParse({ ...request, args: { ...write.args, actor: "link" } }).success).toBe(false);
      expect(cliRequestSchema.safeParse({ ...request, args: { ...write.args, authorKind: "link" } }).success).toBe(false);
    }
  }
  const shown = parseCliResult("show", {
    thread: { id: "th_1", title: "Plan", group: { id: "ch_1", name: "General", slug: "general", kind: "group" }, commentCount: 0, openDecisionCount: 0 },
    messages: [{ id: "msg_1", author: { kind: "link", displayName: "Guest" }, body: "Hi", createdAtMs: 0, attachments: [] }],
    dispatch: { paused: null, lastRun: null },
  });
  if ("stream" in shown) throw new Error("expected a thread");
  expect(shown.messages[0]?.author.kind).toBe("link");
  expect(renderThreadMarkdown(shown)).toContain("**Guest** · link holder · ");
});

it("rejects unused agent attribution on automation switches", () => {
  const args = { ...argsBase, collectionPath: "tasks", automation: "stamp", enabled: false,
    expectedContentHash: token, reformat: true, submitId: "switch-1" };
  const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "automationSwitch", args };
  expect(cliRequestSchema.safeParse(request).success).toBe(true);
  expect(cliRequestSchema.safeParse({ ...request, args: { ...args, agent: "Client" } }).success).toBe(false);
});

it("bounds fileWrite batches to 256 files", () => {
  const request = (count: number) => ({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileWrite",
    args: { ...argsBase, requestId: "batch", files: Array.from({ length: count }, (_, n) => ({ path: `${n}.txt`, contentBase64: "" })) } });
  expect(cliRequestSchema.safeParse(request(MAX_FILE_WRITE_FILES)).success).toBe(true);
  expect(cliRequestSchema.safeParse(request(MAX_FILE_WRITE_FILES + 1)).success).toBe(false);
});

it.each(["collectionSetFields", "collectionCreateRecord"])("validates the agent label for %s", verb => {
  const fields = verb === "collectionSetFields" ? { recordPath: "tasks/a.md", fields: { status: "done" } }
    : { collectionPath: "tasks", name: "a", fields: {} };
  const request = (agent: string) => ({ token, protocolVersion: CLI_PROTOCOL_VERSION, verb, args: { ...argsBase, ...fields, agent } });
  expect(cliRequestSchema.safeParse(request("Client")).success).toBe(true);
  expect(cliRequestSchema.safeParse(request("automation/spoof")).success).toBe(false);
});

describe("moment author results", () => {
  it("preserves a relay-confirmed person's public name", () => {
    const result = momentsResult([{kind: "human", humanId: "recipient", humanName: "Recipient", relayConfirmed: true}]);
    expect(parseCliResult("moments", result)).toEqual(result);
  });
  it.each([
    { kind: "agent", agentId: "agent" },
    { kind: "automation", automationId: "collection:tasks#stamp", depth: 4 },
    { kind: "named", userId: "user_ana", grantId: "grant", grantGeneration: 2 },
    { kind: "link", grantId: "grant", grantGeneration: 2, principalId: "holder" },
    { kind: "human", humanId: "ada" },
  ])("keeps a $kind author without a declared principal", (author) => {
    const result = momentsResult([author]);
    expect(parseCliResult("moments", result)).toEqual(result);
  });

  it("keeps every author of a change and refuses an empty list", () => {
    const result = momentsResult([{ kind: "human", humanId: "ada" }, { kind: "agent", agentId: "agent" }]);
    expect(parseCliResult("moments", result)).toEqual(result);
    expect(() => parseCliResult("moments", momentsResult([]))).toThrow();
  });

  it("keeps a live author snapshot's account holder, declared agent, and link holder", () => {
    const result = momentsResult([
      { kind: "human", humanId: "owner", humanName: "Owner" },
      { kind: "agent", agentId: "writer", agentName: "Writer", onBehalfOf: "owner" },
      { kind: "link", publicPrincipalId: "public_1", label: "Anonymous" },
    ]);
    expect(parseCliResult("moments", result)).toEqual(result);
    const fullHuman = momentsResult([
      { kind: "human", humanId: "owner", humanName: "Owner", relayConfirmed: true, onBehalfOf: "owner" },
    ]);
    expect(parseCliResult("moments", fullHuman)).toEqual(fullHuman);
    for (const author of [
      { kind: "human", humanId: "owner", humanName: "Owner", agentName: "Writer" },
      { kind: "link", publicPrincipalId: "public_1", label: "Anonymous", grantId: "grant" },
    ]) expect(() => parseCliResult("moments", momentsResult([author]))).toThrow();
  });

  it("refuses a link author that claims a person", () => {
    expect(() => parseCliResult("moments", momentsResult([{ kind: "link", grantId: "grant", grantGeneration: 2, principalId: "holder", userId: "user_ana" }]))).toThrow();
  });
});

function momentsResult(authors: unknown[]) {
  return {
    changes: [{
      id: "moment-1", recordedAtMs: 1, source: "workspace-engine", operation: "write",
      path: "tasks/a.md", versionId: "main", fileCount: 1, authors,
    }],
    count: 1, totalAvailable: 1, hasMore: false, cursorMs: 1,
  };
}

function request(verb: string, args: Record<string, unknown>) {
  return {
    token,
    protocolVersion: CLI_PROTOCOL_VERSION,
    verb,
    args: { ...argsBase, ...args },
  };
}

describe("collection request schemas", () => {
  it("parses the four collection verbs with bounded args", () => {
    expect(
      cliRequestSchema.safeParse(
        request("collectionQuery", {
          collectionPath: "tasks",
          filter: { field: "status", operator: "equals", value: "open" },
          sort: [{ field: "status", direction: "asc" }],
          groupBy: "status",
          resolveRelations: true,
          limit: 100,
          cursor: {
            sortValues: [{ present: true, value: "open" }],
            recordPath: "tasks/a.md",
            recordId: "rec_abcdefghijklmnopqrstuvwxyz",
          },
        }),
      ).success,
    ).toBe(true);
    expect(
      cliRequestSchema.safeParse(
        request("collectionRecord", {
          collectionPath: "tasks",
          recordId: "rec_abcdefghijklmnopqrstuvwxyz",
          historyLimit: 50,
        }),
      ).success,
    ).toBe(true);
    expect(
      cliRequestSchema.safeParse(
        request("collectionSetFields", {
          recordPath: "tasks/a.md",
          fields: { status: "done", notes: null },
        }),
      ).success,
    ).toBe(true);
    expect(
      cliRequestSchema.safeParse(
        request("collectionCreateRecord", {
          collectionPath: "tasks",
          name: "write-brief",
          fields: { status: "open" },
        }),
      ).success,
    ).toBe(true);
  });

  it("passes a marker-encoded filter value through as plain JSON", () => {
    const parsed = cliRequestSchema.safeParse(
      request("collectionQuery", {
        collectionPath: "tasks",
        filter: {
          field: "count",
          operator: "equals",
          value: { $dohcInt64: "9007199254740993" },
        },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses out-of-bound collection args", () => {
    const cases = [
      request("collectionQuery", { collectionPath: "" }),
      request("collectionQuery", { collectionPath: "tasks", limit: 501 }),
      request("collectionQuery", {
        collectionPath: "tasks",
        sort: Array.from({ length: 9 }, (_ignored, index) => ({
          field: `f${index}`,
          direction: "asc" as const,
        })),
      }),
      request("collectionRecord", {
        collectionPath: "tasks",
        recordId: "rec_abcdefghijklmnopqrstuvwxyz",
        historyLimit: 501,
      }),
      request("collectionSetFields", { recordPath: "tasks/a.md", fields: {} }),
      request("collectionSetFields", {
        recordPath: "tasks/a.md",
        fields: Object.fromEntries(
          Array.from({ length: 65 }, (_ignored, index) => [`f${index}`, index]),
        ),
      }),
      // The engine owns the "id" key.
      request("collectionSetFields", {
        recordPath: "tasks/a.md",
        fields: { id: "rec_impostor" },
      }),
      request("collectionCreateRecord", {
        collectionPath: "tasks",
        name: "task",
        fields: { id: "rec_impostor" },
      }),
      // A record name is one file name, not a path.
      request("collectionCreateRecord", {
        collectionPath: "tasks",
        name: "nested/name",
        fields: {},
      }),
      request("collectionCreateRecord", {
        collectionPath: "tasks",
        name: "back\\slash",
        fields: {},
      }),
    ];
    for (const candidate of cases) {
      expect(cliRequestSchema.safeParse(candidate).success, JSON.stringify(candidate.args)).toBe(false);
    }
  });

  it("refuses caller-supplied identity on a collection write", () => {
    // Identity is derived desktop-side; the strict schema rejects any
    // author-shaped claim in the args.
    for (const claim of [
      { author: { kind: "agent", agentId: "impostor" } },
      { onBehalfOf: "someone-else" },
      { authorUserId: "user_1" },
    ]) {
      const parsed = cliRequestSchema.safeParse(
        request("collectionSetFields", {
          recordPath: "tasks/a.md",
          fields: { status: "done" },
          ...claim,
        }),
      );
      expect(parsed.success, JSON.stringify(claim)).toBe(false);
    }
  });
});

describe("collection result schemas", () => {
  it("parses a query result and a record result", () => {
    const record = {
      id: "rec_abcdefghijklmnopqrstuvwxyz",
      path: "tasks/a.md",
      conflicted: false,
      values: [
        {
          field: "status",
          value: "open",
          validation: { status: "valid" },
          resolvedRelations: [],
        },
        {
          field: "estimate",
          value: { $dohcInt64: "9007199254740993" },
          validation: { status: "untyped" },
          resolvedRelations: [],
        },
      ],
    };
    const collection = { path: "tasks", status: "valid", reasons: [] };
    expect(
      parseCliResult("collectionQuery", {
        ok: true,
        collection,
        records: [record],
        groups: [{ value: "open", records: [record] }],
        nextCursor: {
          sortValues: [{ present: true, value: "open" }],
          recordPath: record.path,
          recordId: record.id,
        },
      }),
    ).toMatchObject({ ok: true, records: [{ id: record.id }] });
    expect(
      parseCliResult("collectionRecord", {
        ok: true,
        collection,
        record,
        history: [
          {
            historyId: 3,
            field: "status",
            previous: { present: false, value: null },
            next: { present: true, value: "open" },
            authorOriginId: "origin_agent",
            actorKind: "agent",
            onBehalfOf: "public-holder",
            depth: 0,
            recordedAtMs: 12,
            automationRun: null,
            linkAuthor: { kind: "link", grantId: "link", grantGeneration: 2, publicPrincipalId: "public-holder" },
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      history: [{ historyId: 3, actorKind: "agent", onBehalfOf: "public-holder", linkAuthor: { publicPrincipalId: "public-holder" } }],
    });
  });

  it("parses write results and structured failures", () => {
    expect(
      parseCliResult("collectionSetFields", { ok: true, recordPath: "tasks/a.md" }),
    ).toEqual({ ok: true, recordPath: "tasks/a.md" });
    expect(
      parseCliResult("collectionCreateRecord", {
        ok: true,
        recordId: "rec_abcdefghijklmnopqrstuvwxyz",
        recordPath: "tasks/b.md",
        kept: { status: "done", priority: null },
      }),
    ).toMatchObject({ ok: true, kept: { status: "done", priority: null } });
    expect(
      parseCliResult("collectionSetFields", { ok: false, reason: "refused" }),
    ).toEqual({ ok: false, reason: "refused" });
  });

  it("parses a run's dataset changes with the versions and deletes Undo reads", () => {
    const rules = { datasetId: "d", revision: 2, revisionSha256: "r" };
    const run = {
      run: "atc_1", state: "done", error: null, createdAtMs: 1, updatedAtMs: 2,
      trigger: { kind: "changed", recordId: "a", by: "human", sharedAuthor: null, depth: 0 }, definitionChanged: false, neverStarted: false, chainStopped: false, undone: false,
      steps: [{ step: 1, changes: [
        { kind: "dataset-edit", rules, operationId: "edit", tableId: "t", recordId: "a", expectedVersion: 1, version: 2, fields: [] },
        { kind: "dataset-created", rules, operationId: "create", tableId: "t", recordId: 7, version: 1, deletes: ["delete"] },
      ] }],
      failedStep: null, startsOver: false,
    };
    expect(parseCliResult("automationRun", { ok: true, run })).toEqual({ ok: true, run });
    const timed = { ...run, findMs: 12, planMs: 0, writeMs: 30, writeCount: 2 };
    expect(parseCliResult("automationRun", { ok: true, run: timed })).toEqual({ ok: true, run: timed });
    expect(() => parseCliResult("automationRun", { ok: true, run: { ...timed, writeCount: -1 } })).toThrow();
  });

  it("parses a server's run, with what it changed and the mark of a lost copy, and renders its changes", () => {
    const run = {
      run: "atc_lost", state: "failed", error: "Your server lost its copy of this workspace and may not have sent this run's latest changes.",
      createdAtMs: 1, updatedAtMs: 2, trigger: { kind: null, recordId: null, by: null, sharedAuthor: null, depth: 0 },
      definitionChanged: false, neverStarted: false, chainStopped: false, undone: false, unsentChangesLost: true, server: true,
      changes: [{ kind: "field", recordId: "a", path: "tasks/a.md", field: "Status", before: "Open", after: "Paid" }],
    };
    expect(parseCliResult("automationRun", { ok: true, run })).toEqual({ ok: true, run });
    expect(renderCliResult("automationRun", parseCliResult("automationRun", { ok: true, run }))).toContain('set Status on tasks/a.md: "Open" -> "Paid"');
    expect(() => parseCliResult("automationRun", { ok: true, run: { ...run, unsentChangesLost: false } })).toThrow();
    expect(() => parseCliResult("automationRun", { ok: true, run: { ...run, steps: [] } })).toThrow();
  });

  it("refuses a result that does not match the verb", () => {
    expect(() => parseCliResult("collectionSetFields", { recordPath: "x" })).toThrow();
    expect(() =>
      parseCliResult("collectionCreateRecord", { ok: true, recordId: "rec_1" }),
    ).toThrow();
  });
});

describe("document request schemas", () => {
  it("parses a read, an edit, and an edit that adds at the end", () => {
    expect(cliRequestSchema.safeParse(request("documentRead", { path: "notes/a.md" })).success).toBe(true);
    expect(cliRequestSchema.safeParse(request("documentEdit", {
      agent: "claude-code", path: "notes/a.md", find: "Draft", replacement: "Final",
    })).success).toBe(true);
    expect(cliRequestSchema.safeParse(request("documentEdit", {
      path: "notes/a.md", replacement: "## Next",
    })).success).toBe(true);
  });

  it("refuses an agent name that could pass for an automation, and an empty find", () => {
    for (const agent of ["plugin/automation", "", " padded", "x".repeat(65)]) {
      expect(cliRequestSchema.safeParse(request("documentEdit", {
        agent, path: "notes/a.md", replacement: "x",
      })).success, agent).toBe(false);
    }
    expect(cliRequestSchema.safeParse(request("documentEdit", {
      path: "notes/a.md", find: "", replacement: "x",
    })).success).toBe(false);
  });

  it("parses a document create and a comment on a file", () => {
    expect(cliRequestSchema.safeParse(request("documentCreate", {
      agent: "claude-code", path: "notes/new.md", markdown: "# New",
    })).success).toBe(true);
    expect(cliRequestSchema.safeParse(request("fileChatStart", {
      path: "notes/new.md", title: "Budget", body: "Is 400 enough?", runId: "run-1",
    })).success).toBe(true);
    expect(cliRequestSchema.safeParse(request("fileChatStart", {
      path: "notes/new.md", title: "", body: "x",
    })).success).toBe(false);
    expect(parseCliResult("fileChatStart", {
      ok: true, path: "notes/new.md", threadId: "thread-1", messageId: "message-1",
    })).toMatchObject({ ok: true, threadId: "thread-1" });
    expect(() => parseCliResult("fileChatStart", {
      ok: true, path: "notes/new.md", threadId: "th_1", messageId: "message-1",
    })).toThrow();
  });

  it("bounds each side of an edit by its UTF-8 bytes, not its characters", () => {
    // Three bytes per character: 80,000 fit 256 KiB and 90,000 do not.
    const edit = (replacement: string) =>
      cliRequestSchema.safeParse(request("documentEdit", { path: "notes/a.md", replacement })).success;
    expect(edit("日".repeat(80_000))).toBe(true);
    expect(edit("日".repeat(90_000))).toBe(false);
    expect(edit("a".repeat(256 * 1024))).toBe(true);
  });

  it("parses document results and structured failures", () => {
    expect(parseCliResult("documentRead", { ok: true, path: "a.md", markdown: "# A" }))
      .toEqual({ ok: true, path: "a.md", markdown: "# A" });
    expect(parseCliResult("documentEdit", { ok: true, path: "a.md", changed: false }))
      .toEqual({ ok: true, path: "a.md", changed: false });
    expect(parseCliResult("documentEdit", { ok: false, reason: "refused" }))
      .toEqual({ ok: false, reason: "refused" });
  });
});


it("preserves a group's purpose and each thread's lane", () => {
  const group = { id: "c:team", name: "Team", slug: "team", kind: "group", purpose: "Plan the launch" };
  const listed = { ...group, channelWireId: "wire" };
  expect(parseCliResult("groups", { groups: [listed] })).toEqual({ groups: [listed] });
  expect(parseCliResult("groups", { groups: [group] })).toEqual({ groups: [group] });
  const threads = ["posts", "chat"].map((lane, index) => ({
    id: `t:${index}`, title: lane, lane, commentCount: 0, openDecisionCount: 0, unread: false, updatedAtMs: 1,
  }));
  expect(parseCliResult("threads", { group, threads })).toEqual({ group, threads });
});


it("validates file write authors and preserves partial batch results", () => {
  const input = { token: "a".repeat(64), protocolVersion: CLI_PROTOCOL_VERSION, verb: "fileWrite",
    args: { cwd: "/workspace", actor: "agent", agent: "Client", requestId: "batch", files: [{ path: "file.txt", contentBase64: "eA==", createOnly: true }] } };
  expect(cliRequestSchema.safeParse(input).success).toBe(true);
  expect(cliRequestSchema.safeParse({ ...input, args: { ...input.args, agent: "automation/spoof" } }).success).toBe(false);
  expect(cliRequestSchema.safeParse({ ...input, args: { ...input.args, files: [] } }).success).toBe(false);
  const failed = { ok: false, written: ["1.txt", "2.txt"], path: "3.txt", reason: "Changed. Read again.", currentSha256: "a".repeat(64) };
  expect(parseCliResult("fileWrite", failed)).toEqual(failed);
});

it.each(["accessObject", "accessSharing"] as const)("preserves the unknown reason in %s results", verb => {
  const answer = parseCliResult(verb, { ref: null, rows: [], visibility: "unknown", freshness: "unknown", checkedAtMs: null,
    unknownReason: "other-account", nextCursor: null, coverage: { kind: "unavailable", complete: false, observation: "interval" } });
  expect(JSON.parse(renderCliResult(verb, answer))).toHaveProperty("unknownReason", "other-account");
});

it.each(["accessObject", "accessSharing"] as const)("preserves withheld answers in %s results", verb => {
  const answer = { ref: null, rows: [], visibility: "hidden", freshness: "unknown", checkedAtMs: null,
    unknownReason: null, nextCursor: null, coverage: { kind: "unavailable", complete: false, observation: "interval" } };
  expect(JSON.parse(renderCliResult(verb, parseCliResult(verb, answer)))).toMatchObject({ visibility: "hidden", unknownReason: null });
  expect(() => parseCliResult(verb, { ...answer, unknownReason: "unreadable" })).toThrow();
});

it("maps Access refresh and accepts only actionable request outcomes", () => {
  const request = { token, protocolVersion: CLI_PROTOCOL_VERSION, verb: "accessRefresh", args: argsBase };
  expect(cliRequestSchema.safeParse(request).success).toBe(true);
  expect(CLI_CAPABILITIES.accessRefresh).toEqual(["access.refresh"]);
  for (const extra of [{ workspaceId: "other" }, { accountId: "other" }, { reason: "sharing-open" }]) {
    expect(cliRequestSchema.safeParse({ ...request, args: { ...request.args, ...extra } }).success).toBe(false);
  }
  for (const status of ["requested", "joined", "paced"] as const) {
    expect(parseCliResult("accessRefresh", { status, bearerUrl: "secret" })).toEqual({ status });
    expect(JSON.parse(renderCliResult("accessRefresh", { status }))).toEqual({ status });
  }
  for (const reason of ["signed-out", "unreadable"] as const) {
    expect(parseCliResult("accessRefresh", { status: "unavailable", reason })).toEqual({ status: "unavailable", reason });
  }
  expect(() => parseCliResult("accessRefresh", { status: "finished" })).toThrow();
  expect(() => parseCliResult("accessRefresh", { status: "unavailable" })).toThrow();
});

it("accepts one Links target shape for CLI or MCP, and older group listings", () => {
  const base = { token: "a".repeat(64), protocolVersion: CLI_PROTOCOL_VERSION, verb: "chatLinks" };
  const args = { cwd: "/workspace", actor: "agent", cursor: "sealed" };
  for (const target of [{ group: "general" }, { channelWireId: "wire" }]) {
    expect(cliRequestSchema.safeParse({ ...base, args: { ...args, ...target } }).success).toBe(true);
  }
  for (const target of [{}, { group: "general", channelWireId: "wire" }]) {
    expect(cliRequestSchema.safeParse({ ...base, args: { ...args, ...target } }).success).toBe(false);
  }
  const group = { id: "channel-old", name: "Old", slug: "old", kind: "group", threadCount: 0, threads: [] };
  expect(parseCliResult("groupsFull", { ok: true, groups: [group] })).toEqual({ ok: true, groups: [group] });
});
