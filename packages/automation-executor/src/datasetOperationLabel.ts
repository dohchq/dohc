/** Include the operation's unique name when another operation shares its label. */
export function datasetOperationLabel(
  operation: { name: string; label: string },
  operations: readonly { label: string }[],
): string {
  return operations.filter((candidate) => candidate.label === operation.label).length > 1
    ? `${operation.label} (${operation.name})`
    : operation.label;
}
