import { describe, expect, it } from "vitest";
import type { AutomationEvaluator, AutomationOutcome, JsonValue } from "@dohc/app-backend-runtime/automation";
import { deferred } from "../testing/deferred";
import { createAutomationFormulaEvaluator } from "./automationEvaluatorHost";

const scope = { trigger: { kind: "record-added" }, person: null, now: "2026-09-25T09:30:00.000+08:00" };
const formula = [{ kind: "expression" as const, source: "1" }];

function fake(evaluate: AutomationEvaluator["evaluate"]): () => AutomationEvaluator {
  return () => ({ evaluate, runCode: async () => { throw new Error("unused"); }, close: async () => undefined });
}

describe("the shared formula evaluator", () => {
  it("lets each automation have one request waiting, so one slow automation cannot fill the queue", async () => {
    const slow = deferred<AutomationOutcome<JsonValue>[]>();
    let calls = 0;
    const evaluator = createAutomationFormulaEvaluator(fake(async () => (calls += 1) === 1 ? await slow.promise : [{ ok: true, value: 1 }]));
    const first = evaluator.evaluate("collection:Tasks#slow", scope, formula);
    await expect(evaluator.evaluate("collection:Tasks#slow", scope, formula)).resolves.toBe("busy");
    await expect(evaluator.evaluate("collection:Tasks#other", scope, formula)).resolves.toEqual([{ ok: true, value: 1 }]);
    slow.resolve([{ ok: true, value: 2 }]);
    await expect(first).resolves.toEqual([{ ok: true, value: 2 }]);
    // Its request finished, so the automation can ask again.
    await expect(evaluator.evaluate("collection:Tasks#slow", scope, formula)).resolves.toEqual([{ ok: true, value: 1 }]);
  });

  it("answers busy when the evaluator's own queue is full", async () => {
    const evaluator = createAutomationFormulaEvaluator(fake(async () => [{ ok: false, error: { code: "busy", message: "Full." } }]));
    await expect(evaluator.evaluate("collection:Tasks#a", scope, formula)).resolves.toBe("busy");
  });
});
