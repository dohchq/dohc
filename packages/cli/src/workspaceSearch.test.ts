import { describe, expect, it } from "vitest";
import { parseCliArguments } from "./args";
import { renderCliResult } from "./render";

describe("dohc workspace search", () => {
  it("parses query and filter flags and deduplicates repeated surfaces", () => {
    expect(
      parseCliArguments([
        "workspace",
        "search",
        "tokyo hotel",
        "--surface",
        "page",
        "--surface",
        "record",
        "--surface",
        "page",
        "--path-prefix",
        "Projects",
        "--collection",
        "Trips",
        "--limit",
        "10",
        "--no-neighbors",
      ]),
    ).toMatchObject({
      verb: "workspaceSearch",
      query: "tokyo hotel",
      surfaces: ["page", "record"],
      pathPrefix: "Projects",
      collectionPath: "Trips",
      limit: 10,
      includeNeighbors: false,
    });
  });

  it("refuses missing queries, extra operands, unknown surfaces, and out-of-range limits", () => {
    expect(() => parseCliArguments(["workspace", "search"])).toThrow("requires a query");
    expect(() => parseCliArguments(["workspace", "search", "   "])).toThrow("requires a query");
    expect(() => parseCliArguments(["workspace", "search", "tokyo", "extra"])).toThrow(
      "does not accept 'extra'",
    );
    expect(() =>
      parseCliArguments(["workspace", "search", "tokyo", "--surface", "binary"]),
    ).toThrow("--surface must be page, collection, record, or chat");
    expect(() => parseCliArguments(["workspace", "search", "tokyo", "--limit", "0"])).toThrow(
      "--limit requires a positive whole number",
    );
    expect(() => parseCliArguments(["workspace", "search", "tokyo", "--limit", "51"])).toThrow(
      "--limit must be between 1 and 50",
    );
  });

  it("renders ranked hits, matched fields, related edges, connected neighbors, and coverage notices", () => {
    const rendered = renderCliResult("workspaceSearch", {
      versionId: "main",
      results: [
        {
          id: "record:obj-rec",
          kind: "record",
          title: "Park Hyatt",
          path: "Trips/park-hyatt.md",
          objectId: "obj-rec",
          collectionPath: "Trips",
          recordId: "rec-1",
          matchedFields: [{ name: "city", value: "Tokyo" }],
          snippet: "Shinjuku stay",
          matchedTerms: ["tokyo"],
          related: [
            {
              kind: "collection",
              edge: "collection-member",
              direction: "out",
              title: "Trips",
              collectionPath: "Trips",
            },
          ],
        },
        {
          id: "collection:transactional:data/budget/dataset.json",
          kind: "collection",
          collectionKind: "transactional",
          title: "Trip Budget",
          datasetPath: "data/budget/dataset.json",
          fields: ["item", "yen"],
          snippet: "Transactional dataset",
          matchedTerms: ["budget"],
          related: [],
        },
      ],
      neighbors: [
        {
          id: "chat:th-9",
          kind: "chat",
          title: "Flight Ideas",
          threadId: "th-9",
          via: [
            {
              fromId: "record:obj-rec",
              fromTitle: "Park Hyatt",
              edge: "chat-mention",
              direction: "in",
            },
          ],
        },
      ],
      complete: false,
      indexBuilding: true,
      policyDegraded: true,
      mountsCovered: false,
      sharedChannelRowsUncovered: 2,
      truncated: true,
    });

    expect(rendered).toContain("[record] Park Hyatt — Trips/park-hyatt.md");
    expect(rendered).toContain("fields: city=Tokyo");
    expect(rendered).toContain("related: → [collection] Trips (collection-member)");
    expect(rendered).toContain("[dataset] Trip Budget — data/budget/dataset.json");
    expect(rendered).toContain("Connected:");
    expect(rendered).toContain("[chat] Flight Ideas — th-9 (via to Park Hyatt (chat-mention))");
    expect(rendered).toContain("index is still building");
    expect(rendered).toContain("visibility policy could not be read");
    expect(rendered).toContain("mounted shared folders under shared-with-me/ are not searched");
    expect(rendered).toContain("2 shared channels could not be refreshed");
    expect(rendered).toContain("output truncated to byte budget");
  });

  it("renders a clean empty message when nothing matches", () => {
    const rendered = renderCliResult("workspaceSearch", {
      versionId: "main",
      results: [],
      neighbors: [],
      complete: true,
      indexBuilding: false,
      policyDegraded: false,
      mountsCovered: true,
      sharedChannelRowsUncovered: 0,
      truncated: false,
    });
    expect(rendered).toBe("No matching pages, Collections, records, or chats.");
  });
});
