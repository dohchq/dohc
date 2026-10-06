import { whenSettled } from "./desktopActionTesting";
export async function A(task: unknown) { await whenSettled(task); }
