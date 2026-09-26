import { describe, expect, it } from "vitest";
import type { DatasetDefinition, DatasetDescription } from "@dohc/security-contract/dataset";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import {
  datasetButtonAccess,
  datasetButtonRefusal,
  documentButtonAccess,
  resolveButton,
} from "./automationButtons";

const file = (...entries: string[]) => parseAutomationsFile(`version: 1\nautomations:\n${entries.join("\n")}\n`);
const entry = (id: string, when: string, extra = "") =>
  `  - id: ${id}\n    name: ${id}\n${extra}    when: ${when}\n    do: [{set: {Paid: true}}]`;
const documentTable = (table: string | null) => table === null;

describe("resolveButton", () => {
  it("runs the one switched-on automation that uses the button", () => {
    const resolved = resolveButton(file(entry("paid", "{button: Mark paid}"), entry("other", "{button: Archive}")), "Mark paid", documentTable, "Invoices");
    expect(resolved).toMatchObject({ kind: "one", automation: { id: "paid" } });
  });

  it("ignores a switched-off automation beside the one that is on", () => {
    const resolved = resolveButton(file(entry("old", "{button: Mark paid}", "    enabled: false\n"), entry("paid", "{button: Mark paid}")), "Mark paid", documentTable, "Invoices");
    expect(resolved).toMatchObject({ kind: "one", automation: { id: "paid" } });
  });

  it.each([
    ["no file", null, "No automation uses this button."],
    ["another button", file(entry("other", "{button: Archive}")), "No automation uses this button."],
    ["one that is off", file(entry("paid", "{button: Mark paid}", "    enabled: false\n")), "paid is off. Turn it on in Automations."],
    ["two", file(entry("a", "{button: Mark paid}"), entry("b", "{button: Mark paid}")), "Two automations use Mark paid. Keep one."],
    ["three", file(entry("a", "{button: Mark paid}"), entry("b", "{button: Mark paid}"), entry("c", "{button: Mark paid}")), "3 automations use Mark paid. Keep one."],
    ["one the file contract refused", file("  - id: broken\n    name: Broken\n    when: {button: Mark paid}\n    do: [{nonsense: true}]"),
      "The automation for Mark paid has a problem. Fix it in Automations."],
    ["an unreadable file", parseAutomationsFile("version: 2\n"), "dohc cannot read automations.yaml in Invoices. Fix it in Automations."],
  ])("names the state when it finds %s", (_name, parsed, reason) => {
    const resolved = resolveButton(parsed, "Mark paid", documentTable, "Invoices");
    expect(resolved).toEqual({ kind: "state", state: { kind: reason.startsWith("No automation") ? "no-automation" : "disabled", reason } });
  });

  it("matches a dataset button only in its table", () => {
    const parsed = file(entry("paid", "{button: Mark paid, table: Invoices}"));
    expect(resolveButton(parsed, "Mark paid", (table) => table === "Invoices", "Billing").kind).toBe("one");
    expect(resolveButton(parsed, "Mark paid", (table) => table === "Customers", "Billing").kind).toBe("state");
    expect(resolveButton(parsed, "Mark paid", documentTable, "Billing").kind).toBe("state");
  });
});

describe("documentButtonAccess", () => {
  const share = (grantedSelector: unknown, ended = false) => ({
    shareId: "share-1", granterEmail: "owner@example.com", genericChatWritable: false, grantedSelector, ...(ended ? { ended } : {}),
  });
  const edit = (paths: string[], versionId: string | null = null) => share({ paths, versionId, access: "edit" });

  it("lets anyone who can edit this workspace press", () => {
    expect(documentButtonAccess(undefined, "Invoices")).toBe("press");
  });

  it("says only the owner can press for an Edit grant on the Collection or a folder above it", () => {
    expect(documentButtonAccess(edit(["Invoices"]), "Invoices")).toBe("owner-only");
    expect(documentButtonAccess(edit(["Billing"]), "Billing/Invoices")).toBe("owner-only");
    expect(documentButtonAccess(edit([], "main"), "Billing/Invoices")).toBe("owner-only");
  });

  it.each([
    ["Edit on one record", edit(["Invoices/12.md"])],
    ["Edit on a sibling whose name starts the same", edit(["Invoice"])],
    ["Edit on a folder inside the Collection", edit(["Invoices/2026"])],
    ["View", share({ paths: ["Invoices"], versionId: null, access: "view" })],
    ["Comment", share({ paths: ["Invoices"], versionId: null, access: "comment" })],
    ["an ended share", share({ paths: ["Invoices"], versionId: null, access: "edit" }, true)],
    ["a damaged grant", share({ paths: [""], versionId: null, access: "edit" })],
    ["no grant at all", share(undefined)],
    ["a marker that lost its value", null],
  ])("refuses %s", (_name, shareView) => {
    expect(documentButtonAccess(shareView, "Invoices")).toBe("no-access");
  });
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Billing", schemaPath: "billing/schema.sql", operationsPath: "billing/operations.js",
  tables: [{ tableId: id(2), name: "Invoices", sqlName: "invoices", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Paid", sqlColumn: "paid", type: "checkbox", required: false, unique: false },
  ] }],
  operations: [
    { operationId: id(5), name: "list", label: "List", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3), id(4)] },
    { operationId: id(6), name: "markPaid", label: "Mark paid", tableId: id(2), kind: "edit", access: "helper", readOnly: false, fieldIds: [id(4)] },
  ],
};
const describedAs = (operationNames: string[]): DatasetDescription => ({
  datasetId: id(1), name: "Billing", revision: 1, revisionSha256: "a".repeat(64),
  tables: [{ tableId: id(2), name: "Invoices", fields: [
    { fieldId: id(3), name: "ID", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Paid", type: "checkbox", required: false, unique: false },
  ] }],
  operations: definition.operations.filter((operation) => operationNames.includes(operation.name)),
});

describe("datasetButtonAccess", () => {
  it("needs a writable operation on the table and every operation the steps invoke", () => {
    expect(datasetButtonAccess(describedAs(["list", "markPaid"]), "Invoices", ["markPaid"])).toBe(true);
    expect(datasetButtonAccess(describedAs(["markPaid"]), "Invoices", [])).toBe(true);
    // Reading alone is not enough.
    expect(datasetButtonAccess(describedAs(["list"]), "Invoices", [])).toBe(false);
    // A step invokes an operation this person is not given.
    expect(datasetButtonAccess(describedAs(["markPaid"]), "Invoices", ["markPaid", "list"])).toBe(false);
    expect(datasetButtonAccess(describedAs(["list", "markPaid"]), "Customers", [])).toBe(false);
  });
});

describe("datasetButtonRefusal", () => {
  const paid = file("  - id: paid\n    name: Paid\n    when: {button: Mark paid}\n    do: [{set: {Paid: true}, operation: markPaid}]");

  it("refuses someone who cannot edit the table before saying anything about the automation", () => {
    expect(datasetButtonRefusal({ definition, file: paid, description: describedAs(["list"]), field: "Mark paid", table: null }))
      .toBe("Only people who can edit Invoices can use this button.");
    expect(datasetButtonRefusal({ definition, file: null, description: describedAs(["list"]), field: "Mark paid", table: null }))
      .toBe("Only people who can edit Invoices can use this button.");
    expect(datasetButtonRefusal({ definition, file: paid, description: describedAs(["markPaid"]), field: "Mark paid", table: "Customers" }))
      .toBe("Only people who can edit Customers can use this button.");
  });

  it("stops a press that passes access, because dataset automations start only from a record change", () => {
    expect(datasetButtonRefusal({ definition, file: paid, description: describedAs(["markPaid"]), field: "Mark paid", table: null }))
      .toBe("dohc can run automations that start from a record change. Other triggers come later.");
    expect(datasetButtonRefusal({ definition, file: null, description: describedAs(["markPaid"]), field: "Mark paid", table: "Invoices" }))
      .toBe("No automation uses this button.");
  });
});
