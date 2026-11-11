import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "../server/workspaceReads";
import { FILES_SHOWN, homeRows } from "./homeModel";

const file = (path: string): WorkspaceFile => ({ path, objectId: `object:${path}`, page: path.endsWith(".md") });
const names = (rows: readonly { name: string; depth?: number }[]) => rows.map(row => `${"  ".repeat(row.depth ?? 0)}${row.name}`);

describe("Home's rows", () => {
  const files = ["trip/days.md", "trip/budget.md", "trip/stays/porto.md", "notes.md", "Agenda 10.md", "Agenda 9.md", "photo.jpg",
    "trip/map.png", "trip/route.excalidraw", "people/dataset.json", "people/maya.md"].map(file);

  it("nest pages in the folders that hold them, folders first, by the name each row shows", () => {
    expect(names(homeRows(files, new Set()).pages)).toEqual(["trip", "Agenda 9", "Agenda 10", "notes"]);
    expect(names(homeRows(files, new Set(["trip", "trip/stays"])).pages))
      .toEqual(["trip", "  stays", "    porto", "  budget", "  days", "Agenda 9", "Agenda 10", "notes"]);
  });

  it("leave out a Collection's documents, and list the other files by name", () => {
    const { pages, others } = homeRows(files, new Set(["people"]));
    expect(pages.some(row => row.path.startsWith("people/"))).toBe(false);
    expect(others.shown.map(row => [row.name, row.kind === "other" ? row.folder : null])).toEqual([["map.png", "trip"], ["photo.jpg", ""]]);
    expect(others.count).toBe(2);
  });

  it("list Excalidraw files as sketches, apart from the other files", () => {
    const { sketches } = homeRows(files, new Set());
    expect(sketches.shown.map(row => [row.kind, row.name, row.kind === "sketch" ? row.folder : null])).toEqual([["sketch", "route.excalidraw", "trip"]]);
    expect(sketches.count).toBe(1);
  });

  it("show the first other files and count them all", () => {
    const many = Array.from({ length: FILES_SHOWN + 5 }, (_, index) => file(`data/${index}.csv`));
    const { others } = homeRows(many, new Set());
    expect(others.shown).toHaveLength(FILES_SHOWN);
    expect(others.count).toBe(FILES_SHOWN + 5);
  });
});
