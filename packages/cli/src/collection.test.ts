import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeCli } from "./index";
import { CLI_PROTOCOL_VERSION } from "./protocol";

const noSocket = () => {
  throw new Error("a local command reached the socket");
};

describe("collection commands", () => {
  it("queries a Collection with a typed filter, sort, and cursor", async () => {
    const result = { ok: true, collection: { path: "tasks", status: "valid", reasons: [] } };
    const request = vi.fn(async () => ({ ...result, records: [], groups: null, nextCursor: null }));
    const cursor = {
      sortValues: [{ present: true, value: 3 }],
      recordPath: "tasks/a.md",
      recordId: "rec_1",
    };
    const run = await executeCli({
      argv: [
        "collection",
        "query",
        "tasks",
        "--filter",
        '{"field":"done","operator":"equals","value":false}',
        "--sort",
        "points:desc",
        "--sort",
        "a:b",
        "--resolve-relations",
        "--limit",
        "10",
        "--cursor",
        JSON.stringify(cursor),
        "--json",
      ],
      cwd: "/workspace",
      request,
    });
    expect(run.exitCode).toBe(0);
    expect(request).toHaveBeenCalledWith({
      protocolVersion: CLI_PROTOCOL_VERSION,
      verb: "collectionQuery",
      args: {
        cwd: resolve("/workspace"),
        actor: "agent",
        collectionPath: "tasks",
        filter: { field: "done", operator: "equals", value: false },
        sort: [
          { field: "points", direction: "desc" },
          { field: "a:b", direction: "asc" },
        ],
        resolveRelations: true,
        limit: 10,
        cursor,
      },
    });
  });

  it("reads a record with the default history limit", async () => {
    const request = vi.fn(async () => ({ ok: false, reason: "No record rec_1 in tasks." }));
    const run = await executeCli({
      argv: ["collection", "read-record", "tasks", "rec_1", "--before", "0"],
      cwd: "/workspace",
      request,
    });
    expect(run).toEqual({ exitCode: 1, stdout: "", stderr: "dohc: No record rec_1 in tasks.\n" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: "collectionRecord",
        args: expect.objectContaining({ recordId: "rec_1", historyLimit: 50, beforeHistoryId: 0 }),
      }),
    );
  });

  it("creates a record and sets fields with typed JSON values", async () => {
    const request = vi.fn(async (input: { verb: string }) =>
      input.verb === "collectionCreateRecord"
        ? { ok: true, recordId: "rec_1", recordPath: "tasks/launch.md" }
        : { ok: true, recordPath: "tasks/launch.md" },
    );
    const typed = { points: 3, done: true, tags: ["a", "b"], due: null, toString: "x" };
    await executeCli({
      argv: [
        "collection",
        "create-record",
        "tasks",
        "launch",
        "--field",
        "status=Open",
        "--fields-json",
        JSON.stringify(typed),
      ],
      request,
    });
    await executeCli({
      argv: [
        "document",
        "set-fields",
        "tasks/launch.md",
        "--field",
        "note=x",
        "--field",
        "note=y",
        "--fields-json",
        JSON.stringify(typed),
      ],
      request,
    });
    expect(request.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({
        verb: "collectionCreateRecord",
        args: expect.objectContaining({
          actor: "agent",
          collectionPath: "tasks",
          name: "launch",
          fields: { status: "Open", ...typed },
        }),
      }),
      expect.objectContaining({
        verb: "collectionSetFields",
        args: expect.objectContaining({
          recordPath: "tasks/launch.md",
          fields: { note: "y", ...typed },
        }),
      }),
    ]);
  });

  it.each([
    [["collection", "query", "tasks", "--limit", "501"], "invalid limit"],
    [["collection", "query", "tasks", "--filter", "{"], "--filter takes JSON"],
    [["collection", "query", "tasks", "--filter", '{"field":"a"}'], "invalid filter"],
    [["collection", "create-record", "tasks", "a/b"], "a record name is one file name"],
    [["collection", "create-record", "tasks", "a", "--record-id", "r1"], "invalid recordId"],
    [["document", "set-fields", "a.md", "--fields-json", "[1]"], "takes a JSON object"],
    [["document", "set-fields", "a.md", "--fields-json", '{"id":"x"}'], "engine-owned"],
    [["document", "set-fields", "a.md", "--field", "a=1", "--fields-json", '{"a":1}'], "not both"],
    [["document", "set-fields", "a.md", "--field", "a=1", "--fields-json", "null"], "JSON object"],
    [["collection", "create-record", "tasks", "a", "--agent", "Nova"], "--agent"],
  ])("refuses %j before it reaches the app", async (argv, refusal) => {
    const run = await executeCli({ argv, request: noSocket });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(refusal);
  });
});

describe("local commands", () => {
  it("validates collection.yaml and automations.yaml without the app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dohc-validate-"));
    await writeFile(join(dir, "good.yaml"), "version: 1\nfields:\n  points:\n    type: number\n");
    await writeFile(join(dir, "bad.yaml"), "version: 1\nfields:\n  status:\n    type: nope\n");
    await writeFile(
      join(dir, "automations.yaml"),
      "version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: nope\n    do: []\n",
    );
    const run = (argv: string[]) => executeCli({ argv, cwd: dir, request: noSocket });
    expect(await run(["collection", "validate", "good.yaml"])).toEqual({
      exitCode: 0,
      stdout: "Valid: good.yaml\n",
      stderr: "",
    });
    const bad = await run(["collection", "validate", "bad.yaml", "--json"]);
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({
      ok: false,
      path: "bad.yaml",
      diagnostics: [{ code: "unknown-field-type", path: "/fields/status/type" }],
    });
    const automations = await run(["automation", "validate", "automations.yaml", "--json"]);
    expect(automations.exitCode).toBe(1);
    expect(JSON.parse(automations.stdout).diagnostics).toEqual([
      { automation: "stamp", code: "missing-kind", path: "/automations/0/when" },
      { automation: "stamp", code: "empty-value", path: "/automations/0/do" },
    ]);
    expect(await run(["collection", "validate", "missing.yaml"])).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining("ENOENT"),
    });
  });

  it("lists this computer's workspaces and marks the one this folder is in", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dohc-state-"));
    const root = await realpath(await mkdtemp(join(tmpdir(), "dohc-root-")));
    await mkdir(join(root, "notes"));
    const workspaces = [
      { workspaceId: "ws-a", rootPath: root.replaceAll("\\", "/"), kind: "personal", remote: {} },
      { workspaceId: "ws-b", rootPath: join(root, "..", "elsewhere"), kind: "shared" },
    ];
    await writeFile(join(stateDir, "dohc-workspaces.json"), JSON.stringify({ workspaces }));
    const run = (argv: string[]) =>
      executeCli({
        argv,
        cwd: join(root, "notes"),
        env: { DOHC_STATE_DIR: stateDir },
        request: noSocket,
      });
    const listed = JSON.parse((await run(["workspace", "info", "--json"])).stdout);
    expect(listed.workspaces).toEqual([
      { workspaceId: "ws-a", rootPath: workspaces[0]!.rootPath, kind: "personal", current: true },
      { workspaceId: "ws-b", rootPath: workspaces[1]!.rootPath, kind: "shared", current: false },
    ]);
    const named = await run(["workspace", "info", "--workspace", "ws-b"]);
    expect(named.stdout).toBe(
      `  ws-a  personal  ${workspaces[0]!.rootPath}\n* ws-b  shared  ${workspaces[1]!.rootPath}\n`,
    );
  });
});
