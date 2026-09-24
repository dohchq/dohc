import {
  createAutomationEvaluator,
  type AutomationEvaluator,
  type AutomationFormula,
  type AutomationOutcome,
  type AutomationScope,
  type JsonValue,
} from "@dohc/app-backend-runtime/automation";

/**
 * The one formula evaluator in main, shared by every open workspace. Its
 * worker thread starts on the first request and stops when idle.
 *
 * Fairness is this layer's job: an automation has at most one request
 * waiting at a time, so one slow or hostile automation cannot fill the
 * evaluator's queue and keep every other automation busy. A second request
 * for the same automation, like a full queue, answers "busy", and the
 * executor runs that claim again on its next drain.
 */
export interface AutomationFormulaEvaluator {
  evaluate(
    automationId: string,
    scope: AutomationScope,
    formulas: readonly AutomationFormula[],
  ): Promise<AutomationOutcome<JsonValue>[] | "busy">;
  close(): Promise<void>;
}

export function createAutomationFormulaEvaluator(
  create: () => AutomationEvaluator = () => createAutomationEvaluator(),
): AutomationFormulaEvaluator {
  let evaluator: AutomationEvaluator | null = null;
  const waiting = new Set<string>();
  return {
    async evaluate(automationId, scope, formulas) {
      if (waiting.has(automationId)) return "busy";
      waiting.add(automationId);
      try {
        evaluator ??= create();
        const results = await evaluator.evaluate(scope, formulas);
        return results.some((result) => !result.ok && result.error.code === "busy") ? "busy" : results;
      } finally {
        waiting.delete(automationId);
      }
    },
    async close() {
      await evaluator?.close();
      evaluator = null;
    },
  };
}
