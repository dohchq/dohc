import { describe, expect, it } from "vitest";
import {
  parseDatasetDefinition,
  type DatasetOperationContract,
} from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { datasetRevisionHistoryReversible } from "./datasetHistoryReversibility";
import { generateDatasetHistoryRestore } from "./datasetHistoryRestore";

const revision = (number: number, contract?: DatasetOperationContract) =>
  describeDatasetRevision({
    definition: parseDatasetDefinition(
      {
        formatVersion: 2,
        datasetId: "11111111-1111-4111-8111-111111111101",
        name: "Tasks",
        tables: [
          { sqlName: "tasks", primaryKey: "id", fields: [{ sqlColumn: "id", type: "text" }] },
        ],
        operations: [
          {
            name: "close",
            table: "tasks",
            kind: "action",
            readOnly: false,
            ...(contract && { contract }),
          },
        ],
      },
      { descriptorPath: "tasks/dataset.json" },
    ),
    revision: number,
    schemaSql: "CREATE TABLE tasks(id TEXT PRIMARY KEY);",
    operationSource: "export default {};",
  });
const saved = (number: number, contract?: DatasetOperationContract) => ({
  revision: revision(number, contract),
  schemaSql: "CREATE TABLE tasks(id TEXT PRIMARY KEY);",
  operationSource: "export default {};",
});
const later = { input: { object: { id: "string" } }, output: "boolean" } as const;

describe("dataset history reversibility", () => {
  it("can undo a revision that changed only an action's contract", () => {
    expect(
      datasetRevisionHistoryReversible(revision(1, { input: "string" }), revision(2, later)),
    ).toBe(true);
  });

  it("puts back the contract an action had before the reversed change", () => {
    const restored = (before?: DatasetOperationContract) =>
      generateDatasetHistoryRestore(saved(2, later), saved(1, before), saved(2, later)).definition
        .operations[0]!;
    expect(restored({ input: "string" }).contract).toEqual({ input: "string" });
    expect(restored()).not.toHaveProperty("contract");
    expect(() =>
      generateDatasetHistoryRestore(saved(3, { output: "string" }), saved(1), saved(2, later)),
    ).toThrow("The contract of close changed again.");
  });
});
