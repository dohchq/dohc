import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkReaderConfig } from "./readerConfig";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function readerFiles() {
  const root = mkdtempSync(join(tmpdir(), "dohc-reader-config-"));
  roots.push(root);
  const files = { node: join(root, "node"), bundle: join(root, "reader.cjs"), manifest: join(root, "manifest.json") };
  for (const path of Object.values(files)) writeFileSync(path, "");
  return files;
}

it("accepts the three reader files and passes on only the checked value", () => {
  const files = readerFiles();
  expect(checkReaderConfig(`${JSON.stringify(files, null, 2)}\n`)).toEqual({ config: JSON.stringify(files) });
  // JSON.parse keeps the last duplicate, but the engine rejects the original text.
  const duplicate = `{"node":"/elsewhere","node":${JSON.stringify(files.node)},"bundle":${JSON.stringify(files.bundle)},"manifest":${JSON.stringify(files.manifest)}}`;
  expect(checkReaderConfig(duplicate)).toEqual({ config: JSON.stringify(files) });
});

it("names what the engine would reject", () => {
  const files = readerFiles();
  const notObject = "DOHC_ENGINE_READER_CONFIG is not a JSON object with only node, bundle and manifest";
  const cases: [string | undefined, string][] = [
    [undefined, "DOHC_ENGINE_READER_CONFIG is not set"],
    ["{", notObject],
    ["{}", notObject],
    ["null", notObject],
    [JSON.stringify(Object.values(files)), notObject],
    [JSON.stringify({ ...files, extra: files.node }), notObject],
    [JSON.stringify({ ...files, node: 1 }), "DOHC_ENGINE_READER_CONFIG's node is not an absolute path"],
    // This file exists in the package folder, where the relay and these tests run.
    [JSON.stringify({ ...files, node: "package.json" }), "DOHC_ENGINE_READER_CONFIG's node is not an absolute path"],
    ...(["node", "bundle", "manifest"] as const).map((key): [string, string] =>
      [JSON.stringify({ ...files, [key]: `${files[key]}.missing` }), `DOHC_ENGINE_READER_CONFIG's ${key} names no file: ${files[key]}.missing`]),
    [JSON.stringify({ ...files, bundle: join(files.bundle, "..") }), `DOHC_ENGINE_READER_CONFIG's bundle names no file: ${join(files.bundle, "..")}`],
  ];
  for (const [value, problem] of cases) expect(checkReaderConfig(value), value).toEqual({ problem });
});
