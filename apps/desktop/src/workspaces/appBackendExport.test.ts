import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { writeAppBackendExport } from "./appBackendExport";

it("writes complete JSON, refuses accidental overwrite, and cleans temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-backend-export-"));
  const path = join(directory, "recovery.json");
  try {
    const signal = new AbortController().signal;
    await writeAppBackendExport({ path, bundle: { formatVersion: 1, files: [] }, signal, overwrite: false });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ formatVersion: 1, files: [] });
    await expect(writeAppBackendExport({ path, bundle: {}, signal, overwrite: false })).rejects.toThrow(/already exists/);
    expect(await readdir(directory)).toEqual(["recovery.json"]);
    await writeAppBackendExport({ path, bundle: { replacement: true }, signal, overwrite: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ replacement: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("does not touch the chosen file after cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dohc-backend-export-"));
  const path = join(directory, "recovery.json");
  try {
    await writeFile(path, "original");
    const controller = new AbortController(); controller.abort();
    await expect(writeAppBackendExport({ path, bundle: {}, signal: controller.signal, overwrite: true })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await readdir(directory)).toEqual(["recovery.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
