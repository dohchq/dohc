import { describe, expect, it } from "vitest";
import {
  parseDatasetDefinition,
  type DatasetOperationContract,
} from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { datasetRevisionHistoryReversible } from "./datasetHistoryReversibility";

const revision = (number: number, contract: DatasetOperationContract) =>
  describeDatasetRevision({
    definition: parseDatasetDefinition(
      {
        formatVersion: 2,
        datasetId: "11111111-1111-4111-8111-111111111101",
        name: "Tasks",
        tables: [
          { sqlName: "tasks", primaryKey: "id", fields: [{ sqlColumn: "id", type: "text" }] },
        ],
        operations: [{ name: "close", table: "tasks", kind: "action", readOnly: false, contract }],
      },
      { descriptorPath: "tasks/dataset.json" },
    ),
    revision: number,
    schemaSql: "CREATE TABLE tasks(id TEXT PRIMARY KEY);",
    operationSource: "export default {};",
  });

describe("dataset history reversibility", () => {
  it("can undo a revision that changed only an action's contract", () => {
    expect(
      datasetRevisionHistoryReversible(
        revision(1, { input: "string" }),
        revision(2, { input: { object: { id: "string" } }, output: "boolean" }),
      ),
    ).toBe(true);
  });
});
