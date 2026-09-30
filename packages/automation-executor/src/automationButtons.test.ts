import { describe, expect, it } from "vitest";
import type { DatasetDefinition, DatasetDescription } from "@dohc/security-contract/dataset";
import { parseAutomationsFile } from "@dohc/workspace-contracts/automations";
import {
  datasetButtonAccess,
  relayedButtonState,
  relayedButtonTarget,
  relayedDatasetReason,
  resolveButton,
  sharedDatasetButtonState,
  UNVERIFIED_SHARED_DATASET_ACCESS,
} from "./automationButtons";

const file = (...entries: string[]) => parseAutomationsFile(`version: 1\nautomations:\n${entries.join("\n")}\n`);
const entry = (id: string, when: string, extra = "") =>
  `  - id: ${id}\n    name: ${id}\n${extra}    when: ${when}\n    do: [{set: {Paid: true}}]`;
const documentTable = (table: string | null) => table === null;

describe("shared document button readiness", () => {
  const parsed = (steps: string) => file(`  - id: send\n    name: Send\n    when: {button: Send}\n    do:\n${steps}`);
  const disabled = { kind: "disabled", reason: UNVERIFIED_SHARED_DATASET_ACCESS };
  const destinationKind = async (path: string) => path === "Log" || path === "Notes" ? "document" as const : path === "Budget" ? "dataset" as const : null;

  it.each([
    ["Find", "      - find: 'true'\n        collection: Budget\n        operation: invoices.list\n        as: matches"],
    ["Find without a pinned operation", "      - find: 'true'\n        collection: Budget\n        as: matches"],
    ["action", "      - invoke: invoices.settle\n        collection: Budget\n        input: {id: destination}"],
    ["nested action", "      - if: 'false'\n        do: [{set: {Status: Done}}]\n        otherwise:\n          - invoke: invoices.settle\n            collection: Budget\n            input: {id: destination}"],
    ["implicit reads on bound records", "      - add-record: {Status: Open}\n        collection: Budget\n        operation: invoices.create\n        as: added\n      - set: {Status: Done}\n        records: added\n        operation: invoices.edit"],
    ["unresolved destination", "      - find: 'true'\n        collection: Missing\n        as: matches"],
  ])("disables listing and admission for %s with the same reason", async (_name, steps) => {
    const automationFile = parsed(steps);
    expect(await relayedButtonState(automationFile, "log-id", "Send", "Log", "Log", destinationKind)).toEqual(disabled);
    expect(await relayedButtonTarget(automationFile, "log-id", "Send", "Log", "Log", destinationKind)).toEqual({ state: disabled });
  });

  it("fails closed when destination metadata cannot be read", async () => {
    expect(await relayedButtonState(parsed("      - set: {Status: Done}"), "log-id", "Send", "Log", "Log", async () => { throw new Error("Offline"); }))
      .toEqual(disabled);
  });

  it("keeps the existing reason for an invalid document-only action", async () => {
    const automationFile = parsed("      - invoke: invoices.settle\n        collection: Notes\n        input: {id: destination}");
    const state = { kind: "disabled", reason: "This document Collection's automations cannot name a table or a Collection action. Remove those names from the automation." };
    expect(await relayedButtonState(automationFile, "log-id", "Send", "Log", "Log", destinationKind)).toEqual(state);
    expect(await relayedButtonTarget(automationFile, "log-id", "Send", "Log", "Log", destinationKind)).toEqual({ state });
  });

  it("follows nested record bindings to their dataset", async () => {
    const resolved = resolveButton(parsed("      - if: 'true'\n        do:\n          - find: 'true'\n            collection: Budget\n            operation: invoices.list\n            as: matches\n          - set: {Status: Done}\n            records: matches\n            operation: invoices.edit"), "Send", documentTable, "Log");
    if (resolved.kind !== "one") throw new Error("Expected a valid button automation");
    const paths: string[] = [];
    expect(await relayedDatasetReason(resolved.automation, "Log", async (path) => { paths.push(path); return await destinationKind(path); }))
      .toBe(UNVERIFIED_SHARED_DATASET_ACCESS);
    expect(paths).toEqual(["Log", "Budget"]);
  });

  it("keeps document-only steps ready, including nested steps and code", async () => {
    const automationFile = parsed("      - find: 'true'\n        collection: Notes\n        as: matches\n      - if: 'true'\n        do:\n          - set: {Status: Done}\n            records: matches\n      - run: 'return []'");
    expect(await relayedButtonState(automationFile, "log-id", "Send", "Log", "Log", destinationKind))
      .toEqual({ kind: "ready", automationId: "collection:log-id#send" });
    expect(await relayedButtonTarget(automationFile, "log-id", "Send", "Log", "Log", destinationKind))
      .toMatchObject({ automationId: "collection:log-id#send" });
  });
});

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

describe("sharedDatasetButtonState", () => {
  it("tells someone who cannot edit the table that, and anyone else that shared datasets run no buttons yet", () => {
    expect(sharedDatasetButtonState(describedAs(["list"]), "Invoices")).toEqual({ kind: "disabled", reason: "Only people who can edit Invoices can use this button." });
    expect(sharedDatasetButtonState(describedAs(["markPaid"]), "Customers")).toEqual({ kind: "disabled", reason: "Only people who can edit Customers can use this button." });
    expect(sharedDatasetButtonState(describedAs(["markPaid"]), "Invoices")).toEqual({ kind: "disabled", reason: "dohc can't run buttons on shared dataset Collections yet." });
  });
});
