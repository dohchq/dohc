import { QUIT_ASK_TIMEOUT_MS, WILL_QUIT_BUDGET_MS } from "../../apps/desktop/src/shutdownBudgets.ts";
import { PROCESS_EXIT_ALLOWANCE_MS } from "./close-electron.mjs";

export const DESKTOP_CLOSE_GRACE_MS = QUIT_ASK_TIMEOUT_MS + WILL_QUIT_BUDGET_MS + PROCESS_EXIT_ALLOWANCE_MS;
