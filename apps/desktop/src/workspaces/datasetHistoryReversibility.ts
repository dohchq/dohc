import {
  datasetColumnFields,
  type DatasetDefinition,
  type DatasetRevision,
} from "@dohc/security-contract/dataset";

// Tables without their names or buttons. A button has no column, so a change
// that only adds or removes buttons reverses without SQL.
export function datasetColumnShape(tables: DatasetDefinition["tables"]): string {
  return JSON.stringify(
    tables.map((table) => ({
      ...table,
      name: "",
      fields: datasetColumnFields(table).map((field) => ({ ...field, name: "" })),
    })),
  );
}

export function datasetOperationShape(operation: DatasetDefinition["operations"][number]): string {
  const { label: _label, access: _access, contract: _contract, ...rest } = operation;
  return JSON.stringify(rest);
}

export function datasetOperationsMatchForHistoryRestore(
  previous: DatasetDefinition["operations"],
  next: DatasetDefinition["operations"],
): boolean {
  return (
    previous.length === next.length &&
    previous.every((operation) => {
      const selected = next.find((item) => item.operationId === operation.operationId);
      return !!selected && datasetOperationShape(operation) === datasetOperationShape(selected);
    })
  );
}

export function datasetRevisionHistoryReversible(
  previous: DatasetRevision,
  next: DatasetRevision,
): boolean {
  return (
    previous.schemaSha256 === next.schemaSha256 &&
    datasetColumnShape(previous.definition.tables) === datasetColumnShape(next.definition.tables) &&
    datasetOperationsMatchForHistoryRestore(
      previous.definition.operations,
      next.definition.operations,
    ) &&
    previous.definition.operations.every((operation) => {
      const selected = next.definition.operations.find(
        (item) => item.operationId === operation.operationId,
      );
      return selected?.access === operation.access;
    })
  );
}
