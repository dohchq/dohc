import { describe, expect, it } from "vitest";
import {
  CLI_PROTOCOL_VERSION,
  cliRequestSchema,
  parseCliResult,
} from "./protocol";

const token = "a".repeat(64);
const argsBase = { cwd: "C:/ws", actor: "agent" as const };

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
            onBehalfOf: "user:ice",
            depth: 0,
            recordedAtMs: 12,
          },
        ],
      }),
    ).toMatchObject({
      ok: true,
      history: [{ historyId: 3, actorKind: "agent", onBehalfOf: "user:ice" }],
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
      }),
    ).toMatchObject({ ok: true });
    expect(
      parseCliResult("collectionSetFields", { ok: false, reason: "refused" }),
    ).toEqual({ ok: false, reason: "refused" });
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
  const channel = { id: "c:team", name: "Team", slug: "team", kind: "channel", purpose: "Plan the launch" };
  expect(parseCliResult("channels", { channels: [channel] })).toEqual({ channels: [channel] });
  const threads = ["posts", "chat"].map((lane, index) => ({
    id: `t:${index}`, title: lane, lane, commentCount: 0, openDecisionCount: 0, unread: false, updatedAtMs: 1,
  }));
  expect(parseCliResult("threads", { channel, threads })).toEqual({ channel, threads });
});
