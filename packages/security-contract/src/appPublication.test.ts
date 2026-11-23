import { describe, expect, it } from "vitest";
import { parseAppPublicationCandidate, type AppPublicationCandidate } from "./appPublication";
import { APP_DATASET_MAX_BINDINGS, parseDatasetAlias } from "./dataset";
import { parseAppBackendInvokeRequest, parseAppBackendUploadRequest } from "./appBackend";

const limits = { maxFiles: 512, maxMetadataBytes: 256 * 1024, maxBundleBytes: 32 * 1024 * 1024 };
const hash = "a".repeat(64);
const identity = (path: string) => ({ path, sha256: hash, byteLength: 1 });
function candidate(): AppPublicationCandidate {
  return {
    versionId: "main",
    appRoot: "app",
    entryPath: "app/main.ts",
    packageMap: {},
    sourceRevision: hash,
    sourceDigest: hash,
    dependencyLockDigest: hash,
    bundleDigest: hash,
    buildDigest: hash,
    compilerIdentity: { recipe: "dohc-closed-app-v3", version: "0.28.1", binarySha256: hash },
    inputs: [identity("app/main.ts")],
    dependencies: ["app/main.ts"],
    files: [{ ...identity("bundle.js"), contentType: "text/javascript; charset=utf-8" }],
    capabilities: [],
  };
}

describe("bundle files", () => {
  const page = { ...identity("page.json"), contentType: "application/json; charset=utf-8" };
  const style = { ...identity("bundle.css"), contentType: "text/css; charset=utf-8" };

  it("accepts a page record beside the script and styles", () => {
    const value = {
      ...candidate(),
      entryPath: "app/index.html",
      inputs: [identity("app/index.html")],
      dependencies: ["app/index.html"],
    };
    value.files = [...value.files, style, page];
    expect(parseAppPublicationCandidate(value, limits).files.map((file) => file.path)).toEqual([
      "bundle.css",
      "bundle.js",
      "page.json",
    ]);
  });

  it.each([
    [
      "a page record typed as a script",
      [{ ...page, contentType: "text/javascript; charset=utf-8" }],
    ],
    [
      "another bundle file",
      [{ ...identity("page.html"), contentType: "text/html; charset=utf-8" }],
    ],
    ["a duplicate page record", [page, page]],
  ])("rejects %s", (_name, extra) => {
    const value = candidate();
    value.files = [...value.files, ...extra];
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow();
  });
});

it("rejects retired app-owned backend capabilities", () => {
  expect(() =>
    parseAppPublicationCandidate(
      { ...candidate(), capabilities: [{ kind: "app-backend" }] },
      limits,
    ),
  ).toThrow();
});

describe("dataset publication inventory", () => {
  const datasetId = "00000000-0000-4000-8000-000000000001";
  const operationId = "00000000-0000-4000-8000-000000000002";
  function datasetCandidate(): AppPublicationCandidate {
    const value = candidate();
    value.inputs = [identity("app/main.ts")];
    value.dependencies = ["app/main.ts"];
    value.files = value.files.filter((file) => file.path === "bundle.js");
    value.capabilities = [
      {
        kind: "dataset",
        name: "Orders",
        datasetId,
        revision: 1,
        revisionSha256: hash,
        operationIds: [operationId],
        operations: [{ operationId, name: "submit", access: "link", readOnly: false }],
      },
    ];
    return value;
  }

  it("accepts a frontend-only bundle bound to an independent dataset", () => {
    const value = datasetCandidate();
    expect(parseAppPublicationCandidate(value, limits)).toEqual(value);
  });

  it.each(["backend.js", "schema.sql"])(
    "rejects consumer-provided %s replacement rules",
    (path) => {
      const value = datasetCandidate();
      value.files.push({
        ...identity(path),
        contentType:
          path === "schema.sql"
            ? "application/sql; charset=utf-8"
            : "text/javascript; charset=utf-8",
      });
      expect(() => parseAppPublicationCandidate(value, limits)).toThrow(/bundle path/);
    },
  );

  it("refuses Review app's display words in a candidate, which is what an approval binds", () => {
    const value = datasetCandidate();
    const shown = {
      ...value,
      capabilities: value.capabilities.map((capability) =>
        capability.kind === "dataset"
          ? {
              ...capability,
              operations: capability.operations.map((operation) => ({
                ...operation,
                display: { kind: "create" as const, label: "Submit", fields: ["Name"] },
              })),
            }
          : capability,
      ),
    };
    expect(() => parseAppPublicationCandidate(shown, limits)).toThrow(/capability/);
  });

  it("rejects combined dataset and document collection authority", () => {
    const value = datasetCandidate();
    value.capabilities.push({
      kind: "collection-create",
      collectionPath: "app/responses",
      schemaSha256: hash,
      allowedFields: ["name"],
      requiredFields: [],
      readFields: [],
    });
    expect(() => parseAppPublicationCandidate(value, limits)).toThrow(/capabilities/);
  });

  it("supports up to 16 aliased dataset capabilities sorted deterministically by datasetId", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const makeCap = (n: number, alias?: string) => ({
      kind: "dataset" as const,
      ...(alias === undefined ? {} : { alias }),
      name: `Collection ${n}`,
      datasetId: id(n),
      revision: 1,
      revisionSha256: hash,
      operationIds: [operationId],
      operations: [{ operationId, name: "submit", access: "owner" as const, readOnly: false }],
    });
    const value = datasetCandidate();
    value.capabilities = [makeCap(20, "workouts"), makeCap(10, "expenses")];
    const parsed = parseAppPublicationCandidate(value, limits);
    expect(
      parsed.capabilities.map((cap) => (cap.kind === "dataset" ? [cap.alias, cap.datasetId] : [])),
    ).toEqual([
      ["expenses", id(10)],
      ["workouts", id(20)],
    ]);

    // Missing alias on multi-dataset capability is refused.
    const missingAlias = datasetCandidate();
    missingAlias.capabilities = [makeCap(10, "expenses"), makeCap(20)];
    expect(() => parseAppPublicationCandidate(missingAlias, limits)).toThrow(/capabilities/);

    // Duplicate alias or duplicate datasetId is refused.
    const dupAlias = datasetCandidate();
    dupAlias.capabilities = [makeCap(10, "expenses"), makeCap(20, "expenses")];
    expect(() => parseAppPublicationCandidate(dupAlias, limits)).toThrow(/capabilities/);

    const dupDataset = datasetCandidate();
    dupDataset.capabilities = [makeCap(10, "a"), makeCap(10, "b")];
    expect(() => parseAppPublicationCandidate(dupDataset, limits)).toThrow(/capabilities/);

    // More than APP_DATASET_MAX_BINDINGS is refused.
    const tooMany = datasetCandidate();
    tooMany.capabilities = Array.from({ length: APP_DATASET_MAX_BINDINGS + 1 }, (_, index) =>
      makeCap(index + 1, `c${index + 1}`),
    );
    expect(() => parseAppPublicationCandidate(tooMany, limits)).toThrow(/capabilities/);

    // Alias validation rejects uppercase, leading digits, and prototype keys.
    expect(parseDatasetAlias("expenses_2026-q1")).toBe("expenses_2026-q1");
    for (const bad of ["Expenses", "1bad", "prototype", "constructor", "__proto__", "a.b"]) {
      expect(() => parseDatasetAlias(bad)).toThrow();
    }

    // Optional dataset alias on invoke & upload requests preserves omission when absent.
    const plainInvoke = parseAppBackendInvokeRequest({
      authorityRevision: 1,
      operation: "list",
      idempotencyKey: "k1",
      input: {},
    });
    expect("dataset" in plainInvoke).toBe(false);
    expect(
      parseAppBackendInvokeRequest({
        authorityRevision: 1,
        dataset: "expenses",
        operation: "list",
        idempotencyKey: "k1",
        input: {},
      }).dataset,
    ).toBe("expenses");
    expect(() =>
      parseAppBackendInvokeRequest({
        authorityRevision: 1,
        dataset: "BadAlias",
        operation: "list",
        idempotencyKey: "k1",
        input: {},
      }),
    ).toThrow(/alias/);
    expect(
      parseAppBackendUploadRequest({
        authorityRevision: 1,
        dataset: "expenses",
        idempotencyKey: "u1",
        name: "a.txt",
        contentType: "text/plain",
        bytesBase64: "QQ==",
      }).dataset,
    ).toBe("expenses");
  });
});
