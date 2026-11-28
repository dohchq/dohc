import { describe, expect, it } from "vitest";
import { A, B, memberVersion, version } from "../server/testApps";
import type { WorkspaceFile } from "../server/workspaceReads";
import { appGroups, FILES_SHOWN, homeRows, revealedPages } from "./homeModel";

const file = (path: string): WorkspaceFile => ({
  path,
  objectId: `object:${path}`,
  page: path.endsWith(".md"),
});
const names = (rows: readonly { name: string; depth?: number }[]) =>
  rows.map((row) => `${"  ".repeat(row.depth ?? 0)}${row.name}`);

describe("Home's rows", () => {
  const files = [
    "trip/days.md",
    "trip/budget.md",
    "trip/stays/porto.md",
    "notes.md",
    "Agenda 10.md",
    "Agenda 9.md",
    "photo.jpg",
    "trip/map.png",
    "trip/route.excalidraw",
    "people/dataset.json",
    "people/maya.md",
  ].map(file);

  it("pass on only the pages a change of rows reveals", () => {
    const passed = new Set<string>();
    expect(revealedPages(homeRows(files, new Set()).pages, passed)).toEqual([
      "Agenda 9.md",
      "Agenda 10.md",
      "notes.md",
    ]);
    expect(revealedPages(homeRows(files, new Set(["trip"])).pages, passed)).toEqual([
      "trip/budget.md",
      "trip/days.md",
    ]);
    expect(revealedPages(homeRows(files, new Set(["trip"])).pages, passed)).toEqual([]);
  });

  it("nest pages in the folders that hold them, folders first, by the name each row shows", () => {
    expect(names(homeRows(files, new Set()).pages)).toEqual([
      "trip",
      "Agenda 9",
      "Agenda 10",
      "notes",
    ]);
    expect(names(homeRows(files, new Set(["trip", "trip/stays"])).pages)).toEqual([
      "trip",
      "  stays",
      "    porto",
      "  budget",
      "  days",
      "Agenda 9",
      "Agenda 10",
      "notes",
    ]);
  });

  it("leave out a Collection's documents, and list the other files by name", () => {
    const { pages, others } = homeRows(files, new Set(["people"]));
    expect(pages.some((row) => row.path.startsWith("people/"))).toBe(false);
    expect(others.shown.map((row) => [row.name, row.kind === "other" ? row.folder : null])).toEqual(
      [
        ["map.png", "trip"],
        ["photo.jpg", ""],
      ],
    );
    expect(others.count).toBe(2);
  });

  it("list Excalidraw files as sketches, apart from the other files", () => {
    const { sketches } = homeRows(files, new Set());
    expect(
      sketches.shown.map((row) => [row.kind, row.name, row.kind === "sketch" ? row.folder : null]),
    ).toEqual([["sketch", "route.excalidraw", "trip"]]);
    expect(sketches.count).toBe(1);
  });

  it("show the first other files and count them all, and show every other file when asked", () => {
    const many = Array.from({ length: FILES_SHOWN + 5 }, (_, index) => file(`data/${index}.csv`));
    const { others } = homeRows(many, new Set());
    expect(others.shown).toHaveLength(FILES_SHOWN);
    expect(others.count).toBe(FILES_SHOWN + 5);
    const expanded = homeRows(many, new Set(), { showAllOthers: true });
    expect(expanded.others.shown).toHaveLength(FILES_SHOWN + 5);
  });

  it("carries objectId on page, sketch, and other rows", () => {
    const rows = homeRows(files, new Set());
    expect(rows.pages.find((row) => row.kind === "page" && row.path === "notes.md")).toMatchObject({
      objectId: "object:notes.md",
    });
    expect(rows.sketches.shown[0]).toMatchObject({
      kind: "sketch",
      path: "trip/route.excalidraw",
      objectId: "object:trip/route.excalidraw",
    });
  });
});

describe("Home's apps", () => {
  const C = "c".repeat(64);
  const D = "d".repeat(64);
  const E = "e".repeat(64);

  it("show the owner's phone version over its link versions, keeping approved ones to revoke", () => {
    const groups = appGroups([
      version(A, true),
      version(E, false),
      version(B, false, "events/signup", true),
      version(C, true, "trip"),
      memberVersion(D),
    ]);
    const ids = groups.map(({ key, versions }) => [key, versions.map((app) => app.publicationId)]);
    expect(ids).toEqual([
      ["events/signup", [B, A]],
      ["trip", [C]],
      [`member:${D}`, [D]],
    ]);
    expect(groups.map((group) => group.approvedBefore)).toEqual([true, true, false]);
  });

  it("keep every version of an app with no phone version", () => {
    const [group] = appGroups([version(A), version(B)]);
    expect(group?.versions.map((app) => app.publicationId)).toEqual([A, B]);
    expect(group?.approvedBefore).toBe(false);
  });
});
