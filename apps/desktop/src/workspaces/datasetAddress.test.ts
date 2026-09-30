import { expect, it, vi } from "vitest";
import { describeApprovedDataset, type DatasetDefinition } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { addressDatasets, resolveDatasetAddress, invalidateDatasetAddresses } from "./datasetAddress";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Equipment", schemaPath: "data/schema.sql", operationsPath: "data/actions.js",
  tables: [{ tableId: id(2), name: "Equipment", sqlName: "equipment", primaryKey: "id", fields: [{ fieldId: id(3), name: "ID", type: "text", sqlColumn: "id", required: true, unique: true }] }],
  operations: [{ operationId: id(4), tableId: id(2), name: "list", label: "List", kind: "read", readOnly: true, access: "owner", fieldIds: [id(3)] }] };
const signal = new AbortController().signal;

it("keeps concurrent callers independent when the first caller cancels", async () => {
  const adapter = sourceCaptureAdapter(new Map([["data/dataset.json", JSON.stringify({ datasetId: id(99) })]]));
  const list = adapter.listTextFileMetadata.bind(adapter);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const listing = vi.spyOn(adapter, "listTextFileMetadata").mockImplementation(async args => { await waiting; return list(args); });
  const cancelled = new AbortController();
  const first = resolveDatasetAddress(adapter, "w", "data/dataset.json", cancelled.signal);
  const firstResult = expect(first).rejects.toThrow("cancelled lookup");
  const second = resolveDatasetAddress(adapter, "w", "data/dataset.json", signal);
  cancelled.abort(new Error("cancelled lookup"));
  release();
  await firstResult;
  await expect(second).resolves.toBe(id(99));
  expect(listing).toHaveBeenCalledTimes(1);
});

it("resolves a renamed dataset through engine source while the old address reports a broken reference", async () => {
  const sources = new Map([["data/dataset.json", JSON.stringify(definition)]]);
  const adapter = sourceCaptureAdapter(sources);
  const description = describeApprovedDataset(describeDatasetRevision({ definition, revision: 1, schemaSql: "schema", operationSource: "actions" }), definition.operations);
  expect(await resolveDatasetAddress(adapter, "w", "data/dataset.json", signal)).toBe(id(1));
  sources.set("renamed/dataset.json", sources.get("data/dataset.json")!);
  sources.delete("data/dataset.json");
  invalidateDatasetAddresses({ workspaceId: "w" });
  expect(await resolveDatasetAddress(adapter, "w", "renamed/dataset.json", signal)).toBe(id(1));
  await expect(resolveDatasetAddress(adapter, "w", "data/dataset.json", signal)).rejects.toThrow("Collection reference broken: data/dataset.json. Choose its current dataset.json path.");
  expect(await addressDatasets(adapter, "w", [description], signal)).toEqual([{ ...description, datasetPath: "renamed/dataset.json", datasetAddressStatus: "available" }]);
});

it("rejects unknown, invalid, and cross-workspace source captures", async () => {
  const adapter = sourceCaptureAdapter(new Map([["data/dataset.json", JSON.stringify(definition)], ["bad/dataset.json", "{}"]]));
  for (const path of ["unknown/dataset.json", "bad/dataset.json"]) await expect(resolveDatasetAddress(adapter, "w", path, signal)).rejects.toThrow(`Collection reference broken: ${path}`);
  await expect(resolveDatasetAddress(adapter, "other", "data/dataset.json", signal)).rejects.toThrow();
  for (const path of [id(1), "data", "/data/dataset.json", "../data/dataset.json", "data/../dataset.json", ".dohc/dataset.json", "data\\dataset.json"]) {
    await expect(resolveDatasetAddress(adapter, "w", path, signal)).rejects.toThrow("relative dataset.json path");
  }
});

it("batches discovery, reuses unchanged descriptors, and rejects duplicate IDs", async () => {
  const sources = new Map([["data/dataset.json", JSON.stringify(definition)], ["other/dataset.json", JSON.stringify({ datasetId: id(9), name: "batch-only" })]]);
  const onRequest = vi.fn();
  const adapter = sourceCaptureAdapter(sources, { onRequest });
  expect(await resolveDatasetAddress(adapter, "w", "data/dataset.json", signal)).toBe(id(1));
  expect(onRequest.mock.calls.filter(([method]) => method === "versionedText.captureSources")).toHaveLength(1);
  await resolveDatasetAddress(adapter, "w", "data/dataset.json", signal);
  expect(onRequest.mock.calls.filter(([method]) => method === "versionedText.captureSources")).toHaveLength(1);
  expect(onRequest.mock.calls.filter(([method]) => method === "versionedText.list")).toHaveLength(1);
  sources.set("copy/dataset.json", JSON.stringify(definition));
  invalidateDatasetAddresses({ workspaceId: "w" });
  await expect(resolveDatasetAddress(adapter, "w", "copy/dataset.json", signal)).rejects.toThrow("Collection address ambiguous");
  expect(await addressDatasets(adapter, "w", [{ ...definition, revision: 1, revisionSha256: "a".repeat(64) }], signal)).toMatchObject([{ datasetPath: null, datasetAddressStatus: "ambiguous" }]);
  sources.delete("copy/dataset.json");
  sources.set("data/dataset.json", JSON.stringify({ datasetId: id(1), tables: "unfinished edit" }));
  invalidateDatasetAddresses({ workspaceId: "w" });
  expect(await resolveDatasetAddress(adapter, "w", "data/dataset.json", signal)).toBe(id(1));
  invalidateDatasetAddresses({ workspaceId: "w" });
  vi.spyOn(adapter, "listTextFileMetadata").mockRejectedValue(new Error("Engine connection lost"));
  await expect(resolveDatasetAddress(adapter, "w", "data/dataset.json", signal)).rejects.toThrow("Engine connection lost");
});


it("does not repeat a large workspace listing until workspace activity invalidates it", async () => {
  const sources = new Map(Array.from({ length: 2000 }, (_, index) => [`notes/${index}.txt`, "note"]));
  sources.set("data/dataset.json", JSON.stringify(definition));
  const onRequest = vi.fn(), adapter = sourceCaptureAdapter(sources, { onRequest });
  await resolveDatasetAddress(adapter, "w", "data/dataset.json", signal);
  const pages = onRequest.mock.calls.filter(([method]) => method === "versionedText.list").length;
  expect(pages).toBe(5);
  for (let index = 0; index < 10; index++) await resolveDatasetAddress(adapter, "w", "data/dataset.json", signal);
  expect(onRequest.mock.calls.filter(([method]) => method === "versionedText.list")).toHaveLength(pages);
  invalidateDatasetAddresses({ workspaceId: "other" });
  await resolveDatasetAddress(adapter, "w", "data/dataset.json", signal);
  expect(onRequest.mock.calls.filter(([method]) => method === "versionedText.list")).toHaveLength(pages);
  invalidateDatasetAddresses({ workspaceId: "w" });
  await resolveDatasetAddress(adapter, "w", "data/dataset.json", signal);
  expect(onRequest.mock.calls.filter(([method]) => method === "versionedText.list")).toHaveLength(pages * 2);
});

it("excludes live documents before capture even when their content hash is cached", async () => {
  const sources = new Map([["plain/dataset.json", JSON.stringify({ datasetId: id(70) })], ["live/dataset.json", JSON.stringify({ datasetId: id(71) })]]);
  const adapter = sourceCaptureAdapter(sources);
  await resolveDatasetAddress(adapter, "w", "live/dataset.json", signal);
  invalidateDatasetAddresses({ workspaceId: "w" });
  const list = adapter.listTextFileMetadata.bind(adapter);
  vi.spyOn(adapter, "listTextFileMetadata").mockImplementation(async input => (await list(input)).map(file => ({ ...file, hasYdocMarker: file.path.startsWith("live/") })));
  const capture = vi.spyOn(adapter, "captureSourceMetadata");
  sources.set("plain/dataset.json", JSON.stringify({ datasetId: id(72) }));
  await expect(resolveDatasetAddress(adapter, "w", "plain/dataset.json", signal)).resolves.toBe(id(72));
  await expect(resolveDatasetAddress(adapter, "w", "live/dataset.json", signal)).rejects.toThrow("Collection reference broken");
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture.mock.calls[0]![0].paths).toEqual(["plain/dataset.json"]);
});
