import { describe, expect, it } from "vitest";
import type { WorkspaceFile } from "../server/workspaceReads";
import { homeRows, OTHER_FILES_SHOWN } from "./homeModel";

const file = (path: string): WorkspaceFile => ({ path, objectId: `object:${path}`, page: path.endsWith(".md") });
const names = (rows: readonly { name: string; depth?: number }[]) => rows.map(row => `${"  ".repeat(row.depth ?? 0)}${row.name}`);

describe("Home's rows", () => {
  const files = ["trip/days.md", "trip/budget.md", "trip/stays/porto.md", "notes.md", "Agenda 10.md", "Agenda 9.md", "photo.jpg",
    "trip/map.png", "people/dataset.json", "people/maya.md"].map(file);

  it("nest pages in the folders that hold them, folders first, by the name each row shows", () => {
    expect(names(homeRows(files, new Set()).pages)).toEqual(["trip", "Agenda 9", "Agenda 10", "notes"]);
    expect(names(homeRows(files, new Set(["trip", "trip/stays"])).pages))
      .toEqual(["trip", "  stays", "    porto", "  budget", "  days", "Agenda 9", "Agenda 10", "notes"]);
  });

  it("leave out a Collection's documents, and list the other files by name", () => {
    const { pages, others, otherCount } = homeRows(files, new Set(["people"]));
    expect(pages.some(row => row.path.startsWith("people/"))).toBe(false);
    expect(others.map(row => [row.name, row.kind === "other" ? row.folder : null])).toEqual([["map.png", "trip"], ["photo.jpg", ""]]);
    expect(otherCount).toBe(2);
  });

  it("show the first other files and count them all", () => {
    const many = Array.from({ length: OTHER_FILES_SHOWN + 5 }, (_, index) => file(`data/${index}.csv`));
    const { others, otherCount } = homeRows(many, new Set());
    expect(others).toHaveLength(OTHER_FILES_SHOWN);
    expect(otherCount).toBe(OTHER_FILES_SHOWN + 5);
  });
});
