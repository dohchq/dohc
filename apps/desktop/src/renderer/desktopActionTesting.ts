import { settledTasks, type DesktopTask } from "./desktopAction";

/** Resolves after delivery or suppression, without exposing the result. */
export function whenSettled(task: DesktopTask): Promise<void> {
  return settledTasks.get(task) ?? Promise.resolve();
}
