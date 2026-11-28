import { describe, expect, it } from "vitest";
import { createServerClient } from "../server/client";
import { deriveSearchUiState, readSearchAnswer, searchWorkspace } from "../server/search";
import { testServer } from "../server/testServer";

describe("searchWorkspace client and parser", () => {
  it("parses valid search answers and rejects malformed ones", () => {
    expect(
      readSearchAnswer({
        ok: true,
        result: {
          ok: true,
          results: [
            { path: "docs/plan.md", title: "Plan", snippet: "Stay in Alfama", objectId: "obj-1" },
            { path: "README.md", title: "", snippet: "" },
          ],
          indexBuilding: false,
          truncated: true,
          complete: false,
        },
        cursor: "0.1.1",
      }),
    ).toEqual({
      results: [
        { path: "docs/plan.md", title: "Plan", snippet: "Stay in Alfama", objectId: "obj-1" },
        { path: "README.md", title: "", snippet: "" },
      ],
      indexBuilding: false,
      truncated: true,
      complete: false,
    });
    for (const bad of [
      null,
      { ok: false },
      { ok: true, result: { ok: false } },
      {
        ok: true,
        result: {
          ok: true,
          results: [{ path: "", title: "x", snippet: "y" }],
          indexBuilding: false,
          truncated: false,
          complete: true,
        },
      },
      {
        ok: true,
        result: { ok: true, results: [], indexBuilding: "yes", truncated: false, complete: true },
      },
    ]) {
      expect(readSearchAnswer(bad)).toBeNull();
    }
  });

  it("posts query and limit to /sync/<workspace>/ops/searchWorkspace", async () => {
    const server = testServer();
    server.on("POST", "/sync/ws-1/ops/searchWorkspace", {
      status: 200,
      body: {
        ok: true,
        result: {
          ok: true,
          results: [{ path: "docs/plan.md", title: "Plan", snippet: "Alfama" }],
          indexBuilding: false,
          truncated: false,
          complete: true,
        },
        cursor: "0.2.0",
      },
    });
    const client = createServerClient({
      origin: server.origin,
      token: "tok",
      fetch: server.fetch,
      signal: new AbortController().signal,
    });
    const answer = await searchWorkspace(
      client,
      "ws-1",
      "alfama",
      new AbortController().signal,
      15,
    );
    expect(answer.results).toEqual([{ path: "docs/plan.md", title: "Plan", snippet: "Alfama" }]);
    expect(server.calls[0]?.body).toEqual({ query: "alfama", limit: 15 });
  });
});

describe("deriveSearchUiState", () => {
  const hit = { path: "docs/plan.md", title: "Plan", snippet: "Alfama" };

  it("derives idle, loading, error, indexing, empty, and results states", () => {
    expect(
      deriveSearchUiState({ query: "   ", loading: true, answer: null, problem: null }),
    ).toEqual({ kind: "idle" });
    expect(
      deriveSearchUiState({ query: "plan", loading: true, answer: null, problem: null }),
    ).toEqual({ kind: "loading" });
    expect(
      deriveSearchUiState({ query: "plan", loading: false, answer: null, problem: "offline" }),
    ).toEqual({ kind: "error", problem: "offline" });
    expect(
      deriveSearchUiState({
        query: "plan",
        loading: false,
        answer: { results: [hit], indexBuilding: true, truncated: false, complete: false },
        problem: null,
      }),
    ).toEqual({ kind: "indexing", results: [hit] });
    expect(
      deriveSearchUiState({
        query: "  plan ",
        loading: false,
        answer: { results: [], indexBuilding: false, truncated: false, complete: true },
        problem: null,
      }),
    ).toEqual({ kind: "empty", query: "plan" });
    expect(
      deriveSearchUiState({
        query: "plan",
        loading: false,
        answer: { results: [hit], indexBuilding: false, truncated: false, complete: true },
        problem: null,
      }),
    ).toEqual({ kind: "results", results: [hit] });
  });
});
