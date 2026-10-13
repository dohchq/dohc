import { systemMotionOperations } from "./bridgeContract";
import { registerOperations, type OperationBoundary } from "./operationTable";

export function registerSystemMotionIpc<Event, Operation>(
  boundary: OperationBoundary<Event, Operation>,
  getAnimationSettings: () => { prefersReducedMotion: boolean },
): void {
  registerOperations(boundary, systemMotionOperations, {
    getSystemReducedMotion: () => getAnimationSettings().prefersReducedMotion,
  });
}
