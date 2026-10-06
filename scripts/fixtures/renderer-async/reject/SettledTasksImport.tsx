import { settledTasks } from "./desktopAction";
export async function A(task: object) { await (settledTasks as WeakMap<object, Promise<void>>).get(task); }
