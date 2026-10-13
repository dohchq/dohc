import { serverAccountOperations } from "./bridgeContract";
import { registerOperations, type OperationBoundary } from "./operationTable";
import type { ServerAccountDeletion } from "../workspaces/serverAccountDeletion";

export function registerServerAccountIpc<Event, Operation>(
  boundary: OperationBoundary<Event, Operation>,
  deletion: ServerAccountDeletion,
): void {
  registerOperations(boundary, serverAccountOperations, {
    previewServerAccountDeletion: () => deletion.preview(),
    deleteServerAccount: (input) => deletion.delete(input),
  });
}
