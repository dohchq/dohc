import { expect, it, vi } from "vitest";
import { mkdir, readFile, readdir, writeFile, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createDatasetSources } from "./datasetSourceCreation";
import { createTestScratch } from "./testTemp";
import { CreatedFileWriteError } from "./workspaceFiles";
vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it("keeps changed source when a form retry encounters it", async () => {
  const root = await createTestScratch("dohc-form-source-");
  const files = { "forms/frontend.js": "FORM", "forms/frontend.css": "STYLE" };
  const finish = { register: vi.fn(async () => {}), capture: vi.fn(async () => {}), verify: vi.fn(async () => {}) };
  await mkdir(join(root, "forms"));
  await writeFile(join(root, "forms/frontend.css"), "Edited by the owner");
  await expect(createDatasetSources(root, files, new AbortController().signal, finish)).rejects.toThrow("contains different source");
  expect(await readFile(join(root, "forms/frontend.css"), "utf8")).toBe("Edited by the owner");
  expect(await readdir(join(root, "forms"))).toEqual(["frontend.css"]);
  expect(finish.register).not.toHaveBeenCalled();
});

it("validates every destination before writing any source", async () => {
  const root = await createTestScratch("dohc-form-source-");
  const finish = { register: vi.fn(), capture: vi.fn(), verify: vi.fn() };
  await expect(createDatasetSources(root, { "form.js": "FORM", "../outside.js": "ESCAPE" }, new AbortController().signal, finish)).rejects.toThrow();
  expect(await readdir(root)).toEqual([]);
  expect(finish.register).not.toHaveBeenCalled();
});

it("reports a file left by a failed write and completes remove-and-retry", async () => {
  const root = await createTestScratch("dohc-form-source-");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const write = handle.writeFile.bind(handle);
    vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
      await write("TRUNCATED");
      throw Error("disk full");
    });
    return handle;
  });
  const progress: string[][] = [];
  const finish = { register: vi.fn(async () => {}), capture: vi.fn(async () => {}), verify: vi.fn(async () => {}) };
  const files = { "form.js": "COMPLETE" };
  await expect(createDatasetSources(root, files, new AbortController().signal, finish,
    (_stage, paths) => progress.push(paths))).rejects.toBeInstanceOf(CreatedFileWriteError);
  expect(progress.at(-1)).toEqual(["form.js"]);
  expect(await readFile(join(root, "form.js"), "utf8")).toBe("TRUNCATED");
  await unlink(join(root, "form.js"));
  await createDatasetSources(root, files, new AbortController().signal, finish);
  expect(await readdir(root)).toEqual(["form.js"]);
  expect(await readFile(join(root, "form.js"), "utf8")).toBe("COMPLETE");
});
