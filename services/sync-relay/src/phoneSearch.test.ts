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
  it("queries pages only with includeNeighbors:false, excludes non-Markdown drawings, and strips related metadata", async () => {
    const files = mockFiles(["docs/plan.md", "docs/sketch.excalidraw", ".env"], () =>
      searchResult({
        results: [
          hit({ path: ".env", title: "Secrets", snippet: "TOKEN=1" }),
          hit({ path: "docs/sketch.excalidraw", title: "Sketch", snippet: "alfama" }),
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
      results: [{ path: "docs/plan.md", title: "Plan", snippet: "Stay in Alfama" }],
      indexBuilding: false,
      truncated: false,
      complete: true,
    });
    expect(result.results[0]).not.toHaveProperty("related");
    expect(result.results[0]).not.toHaveProperty("objectId");
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
        snippet:
          "See @[docs/plan.md], [Budget](../private/secret-00.md), [[private/secret-01|Secret]], and https://example.com for quartz",
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
          snippet:
            "See @[docs/plan.md], (a file not shared here), (a file not shared here), and https://example.com for quartz",
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

  it("drops hits whose only match was inside a redacted Markdown link or wikilink, while keeping visible links", async () => {
    const member = await memberFixture([
      { folder: "private", yaml: "people:\n  cara@dohc.test: edit\n" },
    ]);
    const files = mockFiles(["private/budget.md", "docs/plan.md", "docs/notes.md"], (input) =>
      searchResult({
        results:
          input.pathPrefix === "docs"
            ? [
                hit({
                  id: "oracle",
                  path: "docs/plan.md",
                  title: "Plan",
                  snippet: "See [Budget](../private/budget.md) and [[budget]]",
                  matchedTerms: ["budget"],
                }),
                hit({
                  id: "real",
                  path: "docs/notes.md",
                  title: "Notes",
                  snippet: "Visible [Plan](./plan.md) mentions budget",
                  matchedTerms: ["budget"],
                }),
              ]
            : [],
      }),
    );
    const result = await searchWorkspacePages(files, {
      workspaceId: "trip",
      query: "budget",
      limit: 20,
      member,
      signal: new AbortController().signal,
    });
    expect(result.results).toEqual([
      {
        path: "docs/notes.md",
        title: "Notes",
        snippet: "Visible [Plan](./plan.md) mentions budget",
      },
    ]);

    // Clipped snippet link fragments and full-text pre-clipping redaction never leak private paths.
    const clippedFiles = mockFiles(["private/budget.md", "docs/plan.md", "docs/long.md"], () =>
      searchResult({
        results: [
          hit({
            id: "clipped-tail",
            path: "docs/plan.md",
            title: "Plan",
            snippet: "Quartz note with [Budget](../private/bud…",
            matchedTerms: ["quartz"],
          }),
          hit({
            id: "clipped-head",
            path: "docs/long.md",
            title: "Long",
            snippet: "…private/budget.md) and quartz details",
            matchedTerms: ["quartz"],
          }),
        ],
      }),
    );
    const clipped = await searchWorkspacePages(clippedFiles, {
      workspaceId: "trip",
      query: "quartz",
      limit: 20,
      member,
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(clipped)).not.toContain("private/");
    expect(clipped.results).toEqual([
      { path: "docs/plan.md", title: "Plan", snippet: "Quartz note with (a file not shared here)" },
      {
        path: "docs/long.md",
        title: "Long",
        snippet: "…(a file not shared here) and quartz details",
      },
    ]);

    const bodyFiles: PhoneSearchFiles = {
      ...clippedFiles,
      readTextFile: async ({ path }) =>
        path === "docs/long.md"
          ? {
              contentKind: "text",
              text: `# Heading ${"a".repeat(240)} [Secret Budget](../private/budget.md)\n\n${"x".repeat(250)} [Budget](../private/budget.md) quartz ${"y".repeat(250)}`,
            }
          : null,
    };
    const fromBody = await searchWorkspacePages(
      {
        ...bodyFiles,
        retrieveWorkspace: async () =>
          searchResult({
            results: [
              hit({
                id: "clipped-heading",
                path: "docs/long.md",
                title: `Heading ${"a".repeat(240)} [Secret Bud…`,
                snippet: "…private/budget.md) quartz",
                matchedTerms: ["quartz"],
              }),
            ],
          }),
      },
      {
        workspaceId: "trip",
        query: "quartz",
        limit: 20,
        member,
        signal: new AbortController().signal,
      },
    );
    expect(JSON.stringify(fromBody)).not.toContain("private/");
    expect(JSON.stringify(fromBody)).not.toContain("Secret Bud");
    expect(fromBody.results[0]?.snippet).toContain("(a file not shared here) quartz");
  });

  it("searches beyond 32 root pages when a folder rule exists and marks incomplete when time budget expires", async () => {
    const member = await memberFixture([
      { folder: "private", yaml: "people:\n  cara@dohc.test: edit\n" },
    ]);
    const rootPages = Array.from({ length: 35 }, (_, i) => `page-${String(i).padStart(2, "0")}.md`);
    const files = mockFiles(["private/secret.md", ...rootPages], (input) =>
      searchResult({
        results:
          input.pathPrefix === "page-34.md"
            ? [hit({ path: "page-34.md", title: "Last", snippet: "Unique quartz match" })]
            : [],
      }),
    );
    const found = await searchWorkspacePages(files, {
      workspaceId: "trip",
      query: "quartz",
      limit: 20,
      member,
      signal: new AbortController().signal,
    });
    expect(found).toEqual({
      ok: true,
      results: [{ path: "page-34.md", title: "Last", snippet: "Unique quartz match" }],
      indexBuilding: false,
      truncated: false,
      complete: true,
    });

    let clock = 0;
    const timedOut = await searchWorkspacePages(files, {
      workspaceId: "trip",
      query: "quartz",
      limit: 20,
      member,
      signal: new AbortController().signal,
      nowMs: () => {
        const current = clock;
        clock += 5_000;
        return current;
      },
    });
    expect(timedOut).toEqual({
      ok: true,
      results: [],
      indexBuilding: false,
      truncated: true,
      complete: false,
    });
  });

  it("recovers Markdown pages when 50 Excalidraw drawings crowd out an unscoped Owner search", async () => {
    const drawings = Array.from({ length: 50 }, (_, i) => `drawings/d-${i}.excalidraw`);
    const files = mockFiles([...drawings, "docs/plan.md"], (input) => {
      if (!input.pathPrefix) {
        return searchResult({
          results: drawings.map((p, i) =>
            hit({ id: `d-${i}`, path: p, title: `Drawing ${i}`, snippet: "quartz" }),
          ),
          truncated: false,
          complete: true,
        });
      }
      return searchResult({
        results:
          input.pathPrefix === "docs"
            ? [hit({ path: "docs/plan.md", title: "Plan", snippet: "Markdown quartz" })]
            : [],
      });
    });
    const result = await searchWorkspacePages(files, {
      workspaceId: "trip",
      query: "quartz",
      limit: 20,
      member: null,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      ok: true,
      results: [{ path: "docs/plan.md", title: "Plan", snippet: "Markdown quartz" }],
      indexBuilding: false,
      truncated: false,
      complete: true,
    });

    // Keeps initial eligible hits when scoped fallback exhausts the prefix cap before reaching them.
    const manyPages = Array.from({ length: 520 }, (_, i) => `p-${String(i).padStart(3, "0")}.md`);
    const keptFallback = mockFiles([...drawings.slice(0, 49), ...manyPages], (input) => {
      if (!input.pathPrefix) {
        return searchResult({
          results: [
            ...drawings
              .slice(0, 49)
              .map((p, i) => hit({ id: `d-${i}`, path: p, title: `D${i}`, snippet: "quartz" })),
            hit({ id: "md-last", path: "p-519.md", title: "Last", snippet: "Markdown quartz" }),
          ],
          truncated: false,
          complete: true,
        });
      }
      return searchResult({ results: [] });
    });
    const preserved = await searchWorkspacePages(keptFallback, {
      workspaceId: "trip",
      query: "quartz",
      limit: 20,
      member: null,
      signal: new AbortController().signal,
    });
    expect(preserved.results).toEqual([
      { path: "p-519.md", title: "Last", snippet: "Markdown quartz" },
    ]);
    expect(preserved.complete).toBe(false);
  });

  it("drops path:undefined hits and preserves honest incomplete status on non-crowded Member results", async () => {
    const member = await memberFixture([]);
    const files = mockFiles(["docs/plan.md", "docs/sketch.excalidraw"], (input) =>
      input.pathPrefix
        ? searchResult({
            results:
              input.pathPrefix === "docs/plan.md"
                ? [
                    hit({
                      id: "p1",
                      kind: "page",
                      path: "docs/plan.md",
                      title: "Plan",
                      snippet: "Open",
                    }),
                  ]
                : [],
          })
        : searchResult({
            results: [
              hit({
                id: "c1",
                kind: "chat",
                path: undefined,
                title: "Hidden chat",
                snippet: "secret",
              }),
              hit({
                id: "r1",
                kind: "record",
                path: undefined,
                title: "Record",
                snippet: "secret",
              }),
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
      results: [{ path: "docs/plan.md", title: "Plan", snippet: "Open" }],
      indexBuilding: false,
      truncated: false,
      complete: true,
    });

    // Incomplete engine response with a single dropped drawing must NOT turn into complete: true.
    const incomplete = mockFiles(["docs/sketch.excalidraw"], () =>
      searchResult({
        results: [
          hit({ id: "d1", kind: "page", path: "docs/sketch.excalidraw", title: "D", snippet: "x" }),
        ],
        truncated: false,
        complete: false,
      }),
    );
    expect(
      await searchWorkspacePages(incomplete, {
        workspaceId: "trip",
        query: "x",
        limit: 20,
        member,
        signal: new AbortController().signal,
      }),
    ).toEqual({
      ok: true,
      results: [],
      indexBuilding: false,
      truncated: false,
      complete: false,
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
