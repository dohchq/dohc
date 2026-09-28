import {
  createAutomationEvaluator,
  type AutomationEvaluator,
  type AutomationFormula,
  type AutomationOutcome,
  type AutomationScope,
  type AutomationTimeSpent,
  type CodeStepReturn,
  type JsonValue,
} from "@dohc/app-backend-runtime/automation";

/**
 * One workspace's view of the shared evaluator. A run that makes several
 * requests passes the same `spent` to each, so its time budgets cover them all.
 */
export interface AutomationFormulaEvaluator {
  evaluate(
    automationId: string,
    scope: AutomationScope,
    formulas: readonly AutomationFormula[],
    spent?: AutomationTimeSpent,
  ): Promise<AutomationOutcome<JsonValue>[] | "busy">;
  /** Runs one code step. It says what to change; nothing is written. */
  runCode(automationId: string, scope: AutomationScope, source: string, spent?: AutomationTimeSpent): Promise<AutomationOutcome<CodeStepReturn> | "busy">;
}

/**
 * The one formula evaluator in main, shared by every open workspace. Its
 * worker thread starts on the first request and stops when idle.
 *
 * Fairness is this layer's job: an automation in a workspace has at most one
 * request waiting at a time, so one slow or hostile automation cannot fill
 * the evaluator's queue and keep every other automation busy. A second
 * request for the same automation, like a full queue, answers "busy", and
 * the executor runs that claim again on its next drain.
 */
export interface SharedAutomationEvaluator {
  forWorkspace(workspaceId: string): AutomationFormulaEvaluator;
  close(): Promise<void>;
}

export function createAutomationFormulaEvaluator(
  create: () => AutomationEvaluator = () => createAutomationEvaluator(),
): SharedAutomationEvaluator {
  let evaluator: AutomationEvaluator | null = null;
  const waiting = new Set<string>();
  const isBusy = (result: AutomationOutcome<unknown>) => !result.ok && result.error.code === "busy";
  const alone = async <T>(workspaceId: string, automationId: string, work: (evaluator: AutomationEvaluator) => Promise<T>): Promise<T | "busy"> => {
    const key = JSON.stringify([workspaceId, automationId]);
    if (waiting.has(key)) return "busy";
    waiting.add(key);
    try {
      evaluator ??= create();
      return await work(evaluator);
    } finally {
      waiting.delete(key);
    }
  };
  return {
    forWorkspace: (workspaceId) => ({
      async evaluate(automationId, scope, formulas, spent) {
        const results = await alone(workspaceId, automationId, (shared) => shared.evaluate(scope, formulas, spent));
        return results === "busy" || results.some(isBusy) ? "busy" : results;
      },
      async runCode(automationId, scope, source, spent) {
        const result = await alone(workspaceId, automationId, (shared) => shared.runCode(scope, source, spent));
        return result === "busy" || isBusy(result) ? "busy" : result;
      },
    }),
    async close() {
      await evaluator?.close();
      evaluator = null;
    },
  };
}
