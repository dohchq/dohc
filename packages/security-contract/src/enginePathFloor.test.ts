import { expect, it } from "vitest";
import { classifyEngineFilePath, classifyEngineFilePathForRead } from "./enginePathFloor";
import fixtures from "../../workspace-contracts/src/pathFoldFixtures.json";

it.each(fixtures)("classifies shared fixture $input", ({ input, ignored }) => {
  expect(classifyEngineFilePath(`notes/${input}/x.md`).kind).toBe(ignored ? "ignored" : "tracked");
});

it.each([".dohc", ".DOHC", ".Dohc", ".do‍hc", ".GIT", "NODE_MODULES", ".DOHC-WRITE-tmp"])("ignores reserved name %s", (name) => {
  const path = `notes/${name}/engine/private.md`;
  expect(classifyEngineFilePath(path)).toEqual({ kind: "ignored" });
  for (const platform of ["linux", "darwin", "win32"] as const) {
    expect(classifyEngineFilePathForRead(path, platform)).toEqual({ kind: "ignored" });
  }
});

it.each(["dohc", ".dohc-notes", "my-dohc", "my-node_modules"])("tracks ordinary name %s", (name) => {
  expect(classifyEngineFilePath(`${name}/notes.md`)).toEqual({ kind: "tracked" });
});
