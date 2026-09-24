import {
  createAutomationEvaluator,
  type AutomationEvaluator,
  type AutomationFormula,
  type AutomationOutcome,
  type AutomationScope,
  type JsonValue,
} from "@dohc/app-backend-runtime/automation";

/** One workspace's view of the shared evaluator. */
export interface AutomationFormulaEvaluator {
  evaluate(
    automationId: string,
    scope: AutomationScope,
    formulas: readonly AutomationFormula[],
  ): Promise<AutomationOutcome<JsonValue>[] | "busy">;
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

/**
 * Why each formula cannot be read, or null when it can: the builder checks
 * what a person types against the same evaluator the runs use. A formula
 * compiles before it runs, and only a syntax error counts here, so one that
 * reads a field the empty scope lacks is not a problem. A busy evaluator
 * reports nothing.
 */
export async function formulaSyntaxProblems(
  evaluator: AutomationFormulaEvaluator,
  sources: readonly string[],
  now: string,
): Promise<Array<string | null>> {
  if (sources.length === 0) return [];
  const results = await evaluator.evaluate(
    "builder:syntax",
    { trigger: { kind: "check" }, person: null, record: {}, previous: {}, bindings: {}, now },
    sources.map((source) => ({ kind: "expression" as const, source })),
  );
  if (results === "busy") return sources.map(() => null);
  return results.map((result) => (!result.ok && result.error.code === "syntax" ? result.error.message : null));
}

export function createAutomationFormulaEvaluator(
  create: () => AutomationEvaluator = () => createAutomationEvaluator(),
): SharedAutomationEvaluator {
  let evaluator: AutomationEvaluator | null = null;
  const waiting = new Set<string>();
  return {
    forWorkspace: (workspaceId) => ({
      async evaluate(automationId, scope, formulas) {
        const key = JSON.stringify([workspaceId, automationId]);
        if (waiting.has(key)) return "busy";
        waiting.add(key);
        try {
          evaluator ??= create();
          const results = await evaluator.evaluate(scope, formulas);
          return results.some((result) => !result.ok && result.error.code === "busy") ? "busy" : results;
        } finally {
          waiting.delete(key);
        }
      },
    }),
    async close() {
      await evaluator?.close();
      evaluator = null;
    },
  };
}
