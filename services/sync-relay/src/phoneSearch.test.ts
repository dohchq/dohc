import { parseAccessRule } from "@dohc/security-contract/access-rules";
import type { WorkspaceSearchResult } from "@dohc/workspace-contracts/retrieval";
import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { RelayError } from "./errors";
import { phoneMember } from "./phoneMember";
import { parsePhoneSearchArgs, searchWorkspacePages, type PhoneSearchFiles } from "./phoneSearch";
import { closeTestStorages, testStorage } from "./testing";

afterEach(async () => {
  await closeTestStorages();
});

type Hit = WorkspaceSearchResult["results"][number];

function hit(overrides: Partial<Hit>): Hit {
  return {
    id: "hit-1",
    kind: "page",
    title: "Plan",
    snippet: "Stay in Alfama",
    path: "docs/plan.md",
    objectId: "object-plan",
    matchedTerms: ["alfama"],
    related: [
      {
        kind: "chat",
        edge: "chat-linked-file",
        direction: "in",
        title: "Secret thread",
        path: "private/budget.md",
        threadId: "thread-secret",
      },
    ],
    ...overrides,
  };
}

function searchResult(overrides: Partial<WorkspaceSearchResult>): WorkspaceSearchResult {
  return {
    versionId: "main",
    results: [],
    neighbors: [],
    complete: true,
    indexBuilding: false,
    policyDegraded: false,
    mountsCovered: true,
    sharedChannelRowsUncovered: 0,
    truncated: false,
    ...overrides,
  };
}

function mockFiles(
  paths: readonly string[],
  search: (input: {
    query: string;
    surfaces: ["page"];
    pathPrefix?: string;
    includeNeighbors: false;
    limit: number;
  }) => WorkspaceSearchResult | Promise<WorkspaceSearchResult>,
): PhoneSearchFiles & { calls: Array<Parameters<PhoneSearchFiles["retrieveWorkspace"]>[0]> } {
  const calls: Array<Parameters<PhoneSearchFiles["retrieveWorkspace"]>[0]> = [];
  return {
    calls,
    getActiveVersion: async () => ({ id: "main" }),
    listTextFileMetadata: async () => paths.map((path) => ({ path })),
    retrieveWorkspace: async (input) => {
      calls.push(input);
      return await search(input);
    },
  };
}

async function memberFixture(rules: ReadonlyArray<{ folder: string; yaml: string }>) {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "trip", ownerUserId: "ana", createdAtMs: 1 });
  storage.inviteWorkspaceMember({
    workspaceId: "trip",
    actorUserId: "ana",
    workspaceName: "Lisbon",
    email: "ben@dohc.test",
    recipientUserId: "ben",
    newMemberId: () => "member-ben",
    newGrantId: () => "grant-ben",
    newShareId: () => "share-trip",
    nowMs: 1,
  });
  for (const [index, entry] of rules.entries()) {
    expect(
      storage.changeFolderRule({
        workspaceId: "trip",
        actorUserId: "ana",
        change: { kind: "create", folder: entry.folder, rule: parseAccessRule(entry.yaml)! },
        nowMs: 2 + index,
      }),
    ).toMatchObject({ ok: true });
  }
  const member = phoneMember(storage, "trip", "ben");
  if (!member) throw new Error("expected phoneMember");
  return member;
}

describe("parsePhoneSearchArgs", () => {
  it("accepts trimmed queries and bounded integer limits, and rejects malformed args", () => {
    expect(parsePhoneSearchArgs({ query: "  alfama  " })).toEqual({ query: "alfama", limit: 20 });
    expect(parsePhoneSearchArgs({ query: "plan", limit: 50 })).toEqual({
      query: "plan",
      limit: 50,
    });
    for (const bad of [
      null,
      {},
      { query: "   " },
      { query: "a".repeat(513) },
      { query: "plan", limit: 0 },
      { query: "plan", limit: 51 },
      { query: "plan", limit: 1.5 },
      { query: "plan", surfaces: ["chat"] },
      { query: "plan", includeNeighbors: true },
    ]) {
      expect(() => parsePhoneSearchArgs(bad)).toThrow(RelayError);
    }
  });
});

describe("searchWorkspacePages", () => {
  it("queries pages only with includeNeighbors:false and strips related/neighbor metadata for owners", async () => {
    const files = mockFiles(["docs/plan.md", ".env"], () =>
      searchResult({
        results: [
          hit({ path: ".env", title: "Secrets", snippet: "TOKEN=1" }),
          hit({
            path: "docs/plan.md",
            title: "Plan",
            snippet: "Stay in Alfama",
            objectId: "obj-1",
          }),
        ],
        neighbors: [
          {
            kind: "page",
            id: "n1",
            title: "Neighbor",
            path: "docs/n.md",
            via: [{ fromId: "hit-1", fromTitle: "Plan", edge: "wikilink", direction: "out" }],
          },
        ],
      }),
    );
    const result = await searchWorkspacePages(files, {
      workspaceId: "trip",
      query: "alfama",
      limit: 20,
      member: null,
      signal: new AbortController().signal,
    });
    expect(files.calls).toEqual([
      { query: "alfama", surfaces: ["page"], includeNeighbors: false, limit: 50 },
    ]);
    expect(result).toEqual({
      ok: true,
      results: [
        { path: "docs/plan.md", title: "Plan", snippet: "Stay in Alfama", objectId: "obj-1" },
      ],
      indexBuilding: false,
      truncated: false,
      complete: true,
    });
    expect(result.results[0]).not.toHaveProperty("related");
    expect(result).not.toHaveProperty("neighbors");
  });

  it("prevents 50 hidden-file or private chat hits from leaking or crowding out a visible page for a joined Member", async () => {
    const member = await memberFixture([
      { folder: "private", yaml: "people:\n  cara@dohc.test: edit\n" },
    ]);
    const hiddenPaths = Array.from(
      { length: 50 },
      (_, i) => `private/secret-${String(i).padStart(2, "0")}.md`,
    );
    const allPaths = [...hiddenPaths, "docs/plan.md", "README.md"];
    const allHits: Hit[] = [
      hit({
        id: "chat-leak",
        kind: "chat",
        path: undefined,
        title: "Private DM",
        snippet: "quartz secret",
      }),
      ...hiddenPaths.map((p, i) =>
        hit({
          id: `hidden-${i}`,
          path: p,
          title: `Top Secret ${i}`,
          snippet: `CONFIDENTIAL quartz ${i}`,
          objectId: `obj-hidden-${i}`,
          matchedTerms: ["quartz", "secret"],
        }),
      ),
      hit({
        id: "visible-doc",
        path: "docs/plan.md",
        title: "Trip @[private/secret-00.md]",
        snippet: "See @[docs/plan.md] and @[private/secret-01.md] for quartz",
        objectId: "obj-plan",
        matchedTerms: ["quartz"],
      }),
    ];
    const files = mockFiles(allPaths, (input) => {
      const matching = allHits.filter((entry) => {
        if (!input.pathPrefix) return true;
        return (
          entry.path === input.pathPrefix ||
          (typeof entry.path === "string" && entry.path.startsWith(`${input.pathPrefix}/`))
        );
      });
      const sliced = matching.slice(0, input.limit);
      return searchResult({
        results: sliced,
        truncated: matching.length > input.limit,
        complete: matching.length <= input.limit,
      });
    });

    const result = await searchWorkspacePages(files, {
      workspaceId: "trip",
      query: "quartz",
      limit: 20,
      member,
      signal: new AbortController().signal,
    });

    expect(
      files.calls.every(
        (call) => call.surfaces.join(",") === "page" && call.includeNeighbors === false,
      ),
    ).toBe(true);
    expect(files.calls.map((call) => call.pathPrefix)).toEqual(["docs", "README.md"]);
    expect(result).toEqual({
      ok: true,
      results: [
        {
          path: "docs/plan.md",
          title: "Trip (a file not shared here)",
          snippet: "See @[docs/plan.md] and (a file not shared here) for quartz",
          objectId: "obj-plan",
        },
      ],
      indexBuilding: false,
      truncated: false,
      complete: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private/secret");
    expect(serialized).not.toContain("CONFIDENTIAL");
    expect(serialized).not.toContain("Private DM");
    expect(serialized).not.toContain("Secret thread");
  });

  it("drops path:undefined hits and normalizes truncated/complete when a Member without folder rules drops leaked hits", async () => {
    const member = await memberFixture([]);
    const files = mockFiles(["docs/plan.md"], () =>
      searchResult({
        results: [
          hit({ id: "c1", kind: "chat", path: undefined, title: "Hidden chat", snippet: "secret" }),
          hit({ id: "r1", kind: "record", path: undefined, title: "Record", snippet: "secret" }),
          hit({ id: "s1", kind: "page", path: ".env", title: "Env", snippet: "KEY=1" }),
          hit({ id: "p1", kind: "page", path: "docs/plan.md", title: "Plan", snippet: "Open" }),
        ],
        truncated: true,
        complete: false,
      }),
    );
    const result = await searchWorkspacePages(files, {
      workspaceId: "trip",
      query: "plan",
      limit: 20,
      member,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      ok: true,
      results: [{ path: "docs/plan.md", title: "Plan", snippet: "Open", objectId: "object-plan" }],
      indexBuilding: false,
      truncated: false,
      complete: true,
    });
  });

  it("handles nested hidden subfolders and case-twin rules without scanning hidden subtrees", async () => {
    const member = await memberFixture([
      { folder: "docs/secret", yaml: "people:\n  cara@dohc.test: edit\n" },
    ]);
    const files = mockFiles(
      ["docs/plan.md", "docs/secret/keys.md", "Docs/other.md", "public/readme.md"],
      (input) =>
        searchResult({
          results:
            input.pathPrefix === "docs/plan.md"
              ? [hit({ path: "docs/plan.md", title: "Plan", snippet: "Match" })]
              : [],
        }),
    );
    const result = await searchWorkspacePages(files, {
      workspaceId: "trip",
      query: "match",
      limit: 20,
      member,
      signal: new AbortController().signal,
    });
    expect(files.calls.map((c) => c.pathPrefix)).toEqual([
      "public",
      "Docs/other.md",
      "docs/plan.md",
    ]);
    expect(result.results.map((r) => r.path)).toEqual(["docs/plan.md"]);
  });

  it("propagates cold-index indexBuilding cleanly and turns INVALID_PARAMS queries into empty results", async () => {
    const cold = mockFiles(["docs/plan.md"], () =>
      searchResult({
        results: [],
        indexBuilding: true,
        complete: false,
      }),
    );
    expect(
      await searchWorkspacePages(cold, {
        workspaceId: "trip",
        query: "plan",
        limit: 20,
        member: null,
        signal: new AbortController().signal,
      }),
    ).toEqual({
      ok: true,
      results: [],
      indexBuilding: true,
      truncated: false,
      complete: false,
    });

    const invalid = mockFiles(["docs/plan.md"], () => {
      throw new EngineRequestError(
        1,
        { code: "INVALID_PARAMS", message: "empty query terms", retry: "no" },
        "retrieval.query",
      );
    });
    expect(
      await searchWorkspacePages(invalid, {
        workspaceId: "trip",
        query: "???",
        limit: 20,
        member: null,
        signal: new AbortController().signal,
      }),
    ).toEqual({
      ok: true,
      results: [],
      indexBuilding: false,
      truncated: false,
      complete: true,
    });
  });
});
