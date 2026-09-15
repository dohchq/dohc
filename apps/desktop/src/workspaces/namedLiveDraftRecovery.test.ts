import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { preserveNamedLiveDraft } from "./namedLiveDraftRecovery";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {...actual, writeFile: vi.fn(actual.writeFile)};
});
const directories: string[] = [];
afterEach(async () => {
  vi.mocked(writeFile).mockClear();
  for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});
});

it("keeps a complete recovery when a repeated snapshot write fails after partial output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-atomic-recovery-")); directories.push(directory);
  const draft = {path: "docs/a.md", objectId: "object", remoteWorkspaceId: "owner", update: new Uint8Array([0, 0])};
  await preserveNamedLiveDraft(directory, "recipient", draft);
  const names = await readdir(directory);
  const original = await readFile(join(directory, names[0]!));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockImplementationOnce(async (path, _content, options) => {
    await actual.writeFile(path, "partial", options);
    throw new Error("flush failed");
  });
  await expect(preserveNamedLiveDraft(directory, "recipient", draft)).rejects.toThrow("flush failed");
  expect(await readdir(directory)).toEqual(names);
  expect(await readFile(join(directory, names[0]!))).toEqual(original);
  await preserveNamedLiveDraft(directory, "recipient", draft);
  expect(await readdir(directory)).toEqual(names);
  expect(await readFile(join(directory, names[0]!))).toEqual(original);
});
