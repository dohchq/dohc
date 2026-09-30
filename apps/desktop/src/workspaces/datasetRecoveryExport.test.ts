import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DATASET_RECOVERY_EXTENSION, writeDatasetRecoveryExport } from "./datasetRecoveryExport";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "dohc-recovery-export-")); roots.push(root); return root; }
async function* chunks(...values: string[]) { for (const value of values) yield Buffer.from(value); }

it("streams a private recovery archive through a synced temp file and publishes atomically", async () => {
  const root = await fixture(), path = join(root, `fundraiser${DATASET_RECOVERY_EXTENSION}`); let checks = 0;
  const result = await writeDatasetRecoveryExport({ workspaceRoots: [], path, stream: chunks("DOHCDR01", "payload"), maxBytes: 1024, signal: new AbortController().signal, authorize: () => { checks++; } });
  expect(result).toEqual({ savedPath: path, byteLength: 15 });
  expect(await readFile(path, "utf8")).toBe("DOHCDR01payload"); expect(checks).toBeGreaterThan(2);
});

it("refuses wrong destinations, overwrite races, and oversized or empty streams", async () => {
  const root = await fixture();
  await expect(writeDatasetRecoveryExport({ workspaceRoots: [], path: join(root, "archive.json"), stream: chunks("x"), maxBytes: 10, signal: new AbortController().signal, authorize() {} })).rejects.toThrow(".dohc-recovery");
  const path = join(root, `archive${DATASET_RECOVERY_EXTENSION}`); await writeFile(path, "existing");
  await expect(writeDatasetRecoveryExport({ workspaceRoots: [], path, stream: chunks("new"), maxBytes: 10, signal: new AbortController().signal, authorize() {} })).rejects.toThrow("already exists");
  await expect(writeDatasetRecoveryExport({ workspaceRoots: [], path, overwrite: true, stream: chunks("new"), maxBytes: 2, signal: new AbortController().signal, authorize() {} })).rejects.toThrow("size limit");
  await expect(writeDatasetRecoveryExport({ workspaceRoots: [], path, overwrite: true, stream: chunks(), maxBytes: 10, signal: new AbortController().signal, authorize() {} })).rejects.toThrow("empty");
});

it("stops before and during an export when workspace authority retires", async () => {
  const root = await fixture(), path = join(root, `archive${DATASET_RECOVERY_EXTENSION}`), abort = new AbortController(); let active = true;
  async function* stream() { yield Buffer.from("first"); active = false; yield Buffer.from("second"); }
  await expect(writeDatasetRecoveryExport({ workspaceRoots: [], path, stream: stream(), maxBytes: 20, signal: abort.signal, authorize() { if (!active) throw new Error("retired"); } })).rejects.toThrow("retired");
  await expect(readFile(path)).rejects.toThrow();
});

it("refuses recovery archives inside any registered workspace, including a nested workspace's parent and aliases", async () => {
  const root = await fixture();
  const parent = join(root, "parent"), nested = join(parent, "nested"), other = join(root, "other");
  await mkdir(nested, { recursive: true });
  await mkdir(other);
  const alias = join(root, "alias");
  await symlink(other, alias, "junction");
  const workspaceRoots = [nested, other, parent];
  for (const folder of [other, parent, nested, alias]) {
    await expect(writeDatasetRecoveryExport({ workspaceRoots, path: join(folder, "archive.dohc-recovery"),
      stream: chunks("private"), maxBytes: 1024, signal: new AbortController().signal, authorize() {} })).rejects.toThrow("outside all workspaces");
    expect(await readdir(folder)).not.toContain("archive.dohc-recovery");
    expect((await readdir(folder)).some(name => name.endsWith(".tmp"))).toBe(false);
  }
  const path = join(root, "archive.dohc-recovery");
  await expect(writeDatasetRecoveryExport({ workspaceRoots, path, stream: chunks("private"), maxBytes: 1024,
    signal: new AbortController().signal, authorize() {} })).resolves.toEqual({ savedPath: join(await realpath(root), "archive.dohc-recovery"), byteLength: 7 });
  expect(await readFile(path, "utf8")).toBe("private");
});

it("resolves registered workspace aliases before checking the destination", async () => {
  const root = await fixture(), workspace = join(root, "workspace"), alias = join(root, "registered-alias");
  await mkdir(workspace);
  await symlink(workspace, alias, "junction");
  await expect(writeDatasetRecoveryExport({ workspaceRoots: [alias], path: join(workspace, "archive.dohc-recovery"),
    stream: chunks("private"), maxBytes: 1024, signal: new AbortController().signal, authorize() {} })).rejects.toThrow("outside all workspaces");
});
