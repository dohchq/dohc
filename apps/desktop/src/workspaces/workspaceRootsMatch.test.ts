import { realpathSync } from "node:fs";
import { expect, it } from "vitest";
import { createTestScratch } from "./testTemp";
import { canonicalWorkspaceRoot } from "./createWorkspaceFolder";
import { workspaceRootForOperation, workspaceRootsMatch } from "./workspaceRootsMatch";

it("compares real registry and native roots without admitting another folder", async () => {
  const folder = await createTestScratch("matching-root-");
  const other = await createTestScratch("other-root-");
  const native = realpathSync.native(folder), registry = canonicalWorkspaceRoot(folder);
  expect(workspaceRootsMatch(native, registry)).toBe(true);
  expect(workspaceRootsMatch(registry, native)).toBe(true);
  expect(workspaceRootsMatch(native, realpathSync.native(other))).toBe(false);
  expect(workspaceRootsMatch(registry, canonicalWorkspaceRoot(other))).toBe(false);
});

it.skipIf(process.platform === "win32")("keeps literal backslashes in POSIX folder names distinct", () => {
  expect(workspaceRootsMatch("/work/trip\\2026", "/work/trip/2026")).toBe(false);
});

it("keeps roots differing only in letter case distinct on every platform", () => {
  const prefix = process.platform === "win32" ? "C:/work/" : "/work/";
  expect(workspaceRootsMatch(`${prefix}Trip`, `${prefix}trip`)).toBe(false);
  expect(workspaceRootsMatch(`${prefix}trip`, `${prefix}Trip`)).toBe(false);
});

it("keeps the operation's exact root for host and copy construction", async () => {
  const folder = await createTestScratch("operation-root-");
  const operationRoot = realpathSync.native(folder);
  const callerRoot = canonicalWorkspaceRoot(folder);
  expect(workspaceRootForOperation(operationRoot, callerRoot)).toBe(operationRoot);
  expect(workspaceRootForOperation(operationRoot, `${callerRoot}/`)).toBe(operationRoot);
  expect(workspaceRootForOperation(callerRoot, operationRoot)).toBe(callerRoot);
});

it("refuses a different folder before selecting an operation root", async () => {
  const folder = await createTestScratch("operation-root-");
  const other = await createTestScratch("other-operation-root-");
  expect(() => workspaceRootForOperation(realpathSync.native(folder), canonicalWorkspaceRoot(other)))
    .toThrow("This workspace changed while this ran. Try again.");
});
