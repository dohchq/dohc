import { expect, it } from "vitest";
import { classifyEngineFilePath, classifyEngineFilePathForRead } from "./enginePathFloor";

it.each([".dohc", ".DOHC", ".Dohc", ".ＤＯＨＣ", ".GIT", "NODE_MODULES", ".DOHC-WRITE-tmp"])("ignores reserved name %s", (name) => {
  const path = `notes/${name}/engine/private.md`;
  expect(classifyEngineFilePath(path)).toEqual({ kind: "ignored" });
  for (const platform of ["linux", "darwin", "win32"] as const) {
    expect(classifyEngineFilePathForRead(path, platform)).toEqual({ kind: "ignored" });
  }
});

it.each(["dohc", ".dohc-notes", "my-dohc", "my-node_modules"])("tracks ordinary name %s", (name) => {
  expect(classifyEngineFilePath(`${name}/notes.md`)).toEqual({ kind: "tracked" });
});
