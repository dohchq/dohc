import { describe, expect, it } from "vitest";
import type { DatasetRevision } from "@dohc/security-contract/dataset";
import { createAutomationTargets, type AutomationTargetDependencies } from "./automationTargets";

function revision(path: string, datasetId = path): DatasetRevision {
  return {
    datasetId, revision: 1, revisionSha256: "a".repeat(64), definitionSha256: "b".repeat(64), schemaSha256: "c".repeat(64), operationsSha256: "d".repeat(64),
    definition: {
      formatVersion: 1, datasetId, name: path, schemaPath: `${path}/schema.sql`, operationsPath: `${path}/operations.ts`,
      tables: [{ tableId: "table", name: "Records", sqlName: "records", primaryKey: "id", fields: [] }],
      operations: [{ operationId: `${datasetId}-read`, name: "records.read", label: "Read", tableId: "table", kind: "read", access: "helper", readOnly: true, fieldIds: [] }],
    },
  };
}

function workspace() {
  const files = new Map<string, string>([["Budget/dataset.json", JSON.stringify({ datasetId: "Budget" })]]);
  const approved = new Map([["Budget", revision("Budget")]]);
  const requests: string[] = [];
  const collections = new Set(["Tasks", "Budget"]);
  const schemas = new Map<string, ReadonlySet<string> | string>();
  let grants = { workspaceId: "workspace", grants: [] as Array<{ principalKey: string; operationIds: string[] }> };
  let online = true;
  let generated = true;
  let revisionError: Error | null = null;
  const dependencies: AutomationTargetDependencies = {
    readText: async (path) => {
      requests.push(path);
      return files.has(path) ? { text: files.get(path)!, truncated: false } : null;
    },
    isCollection: (path) => collections.has(path),
    readSchemaFields: async (path) => schemas.get(path) ?? null,
    withHost: async (work) => online ? await work({
      revision: (id) => { if (revisionError !== null) throw revisionError; const found = approved.get(id); if (!found) throw new Error("No approval"); return found; },
      generated: () => generated,
      dataGrants: () => grants,
    }) : null,
  };
  return {
    targets: createAutomationTargets(dependencies), dependencies, files, approved, requests, collections, schemas,
    setGrants: (next: typeof grants) => { grants = next; },
    setOnline: (next: boolean) => { online = next; },
    setGenerated: (next: boolean) => { generated = next; },
    setRevisionError: (next: Error | null) => { revisionError = next; },
  };
}

describe("automation destinations", () => {
  it.each(["Acme Inc.", "Aux", "Notes: Q1", "Trailing "])("resolves the engine's exact document and dataset path %s", async (path) => {
    const w = workspace();
    w.collections.add(path);
    w.schemas.set(path, new Set(["Name"]));
    expect(await w.targets.resolve(path)).toEqual({ kind: "document", collection: { path, name: path }, fields: new Set(["Name"]) });
    w.files.set(`${path}/dataset.json`, JSON.stringify({ datasetId: "named" }));
    w.approved.set("named", revision(path, "named"));
    expect(await w.targets.resolve(path)).toMatchObject({ kind: "dataset", approved: { datasetId: "named" } });
  });

  it("loads a destination without automations, including its generated status and current grants", async () => {
    const w = workspace();
    const grants = { workspaceId: "workspace", grants: [{ principalKey: "ana", operationIds: ["Budget-read"] }] };
    w.setGrants(grants);
    expect(await w.targets.resolve("Budget")).toMatchObject({ kind: "dataset", generated: true, grants });
    expect(w.requests).toEqual(["Budget/dataset.json"]);
    w.setGrants({ workspaceId: "workspace", grants: [] });
    w.setGenerated(false);
    expect(await w.targets.resolve("Budget")).toMatchObject({ kind: "dataset", generated: false, grants: { grants: [] } });
  });

  it.each(["budget", "Budget/", "Budget/../Tasks"])("rejects %s unless the engine lists that exact document path or approved rules name it", async (path) => {
    const w = workspace();
    expect(await w.targets.resolve(path)).toMatchObject({ kind: "problem", code: "missing" });
    w.files.set(`${path}/dataset.json`, JSON.stringify({ datasetId: "Budget" }));
    expect(await w.targets.resolve(path)).toMatchObject({ kind: "problem", code: "descriptor-mismatch" });
  });

  it("distinguishes missing Collections, invalid descriptors and unavailable hosts, and propagates revision errors", async () => {
    const w = workspace();
    expect(await w.targets.resolve("Missing")).toMatchObject({ kind: "problem", code: "missing" });
    w.files.set("Budget/dataset.json", "{ broken");
    expect(await w.targets.resolve("Budget")).toMatchObject({ kind: "problem", code: "invalid-descriptor" });
    w.files.set("Budget/dataset.json", JSON.stringify({ datasetId: "unapproved" }));
    await expect(w.targets.resolve("Budget")).rejects.toThrow("No approval");
    w.setOnline(false);
    expect(await w.targets.resolve("Budget")).toMatchObject({ kind: "problem", code: "host-unavailable" });
    expect(w.requests.some((path) => path === "Budget/collection.yaml")).toBe(false);
  });

  it("rejects a descriptor pointing at approved rules in another Collection", async () => {
    const w = workspace();
    w.approved.set("Elsewhere", revision("Elsewhere"));
    w.files.set("Budget/dataset.json", JSON.stringify({ datasetId: "Elsewhere" }));
    expect(await w.targets.resolve("Budget")).toMatchObject({ kind: "problem", code: "descriptor-mismatch" });
  });

  it("propagates a transient revision error and resolves when the host recovers", async () => {
    const w = workspace();
    const error = new Error("The dataset store is temporarily busy.");
    w.setRevisionError(error);
    await expect(w.targets.resolve("Budget")).rejects.toBe(error);
    w.setRevisionError(null);
    expect(await w.targets.resolve("Budget")).toMatchObject({ kind: "dataset", approved: { datasetId: "Budget" } });
  });

  it("rejects received shares before reading their metadata", async () => {
    const w = workspace();
    expect(await w.targets.resolve("shared-with-me/Ana/Budget")).toMatchObject({ kind: "problem", code: "denied" });
    expect(w.requests).toEqual([]);
  });

  it.each(["revision", "definition"])("rejects a mismatched %s dataset ID", async (part) => {
    const w = workspace();
    const approved = w.approved.get("Budget")!;
    w.approved.set("Budget", part === "revision" ? { ...approved, datasetId: "Other" }
      : { ...approved, definition: { ...approved.definition, datasetId: "Other" } });
    expect(await w.targets.resolve("Budget")).toMatchObject({ kind: "problem", code: "descriptor-mismatch" });
  });

  it("rechecks descriptor associations and approvals on each resolution", async () => {
    const w = workspace();
    expect(await w.targets.resolve("Budget")).toMatchObject({ kind: "dataset" });
    w.files.set("Budget/dataset.json", JSON.stringify({ datasetId: "replacement" }));
    await expect(w.targets.resolve("Budget")).rejects.toThrow("No approval");
    w.approved.set("replacement", revision("Budget", "replacement"));
    expect(await w.targets.resolve("Budget")).toMatchObject({ kind: "dataset", approved: { datasetId: "replacement" } });
    w.approved.delete("replacement");
    await expect(w.targets.resolve("Budget")).rejects.toThrow("No approval");
  });

  it("uses the shared schema reader's fields and reports unreadable schemas", async () => {
    const w = workspace();
    w.schemas.set("Tasks", new Set(["Status"]));
    expect(await w.targets.resolve("Tasks")).toMatchObject({ kind: "document", fields: new Set(["Status"]) });
    w.schemas.set("Tasks", "dohc cannot read Tasks/collection.yaml.");
    expect(await w.targets.resolve("Tasks")).toMatchObject({ kind: "problem", code: "invalid-schema", problem: "dohc cannot read Tasks/collection.yaml." });
  });
});
