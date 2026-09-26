import { describe, expect, it } from "vitest";
import { createAutomationEvaluator } from "@dohc/app-backend-runtime/automation";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { derivedRecordId } from "../workspaces/collectionRecordEdits";
import {
  collectionAutomationId,
  definitionHash,
  evaluationRequest,
  fieldWritesOf,
  expressionProblem,
  findQueryOf,
  localIsoTime,
  parseCollectionAutomationId,
  planRun,
  subscriptionFor,
  triggerMatches,
  unsupportedReason,
  type RunInputs,
} from "./automationPlan";

type RecordChange = Exclude<AutomationClaim["change"], { kind: "message" }>;

function automation(yaml: string): Automation {
  const [first, ...rest] = yaml.split("\n");
  const item = [`  - ${first}`, ...rest.map((line) => `    ${line}`)].join("\n");
  const parsed = parseAutomationsFile(`version: 1\nautomations:\n${item}\n`);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") {
    throw new Error(`Not a valid automation: ${JSON.stringify(parsed)}`);
  }
  return parsed.entries[0].automation;
}

function claim(change: Partial<RecordChange> = {}): AutomationClaim {
  return {
    claimId: "atc_one",
    automationId: "collection:Tasks#stamp",
    trigger: { historyId: 7 },
    recordId: "rec_task",
    collectionPath: "Tasks",
    depth: 0,
    change: {
      kind: "changed", authorOriginId: null, actorKind: "human", onBehalfOf: null,
      fields: [{ field: "Status", historyId: 7, previous: { value: "Doing" }, next: { value: "Done" } }],
      fieldsOmitted: 0,
      ...change,
    },
    state: "running", attempts: 1, run: 1, createdAtMs: Date.UTC(2026, 8, 25, 1, 30), updatedAtMs: 0,
  };
}

const task = { id: "rec_task", path: "Tasks/one.md", values: { Status: "Done", Count: 2 } };

function inputs(definition: Automation, overrides: Partial<RunInputs> = {}): RunInputs {
  return { automation: definition, claim: claim(), record: task, found: new Map(), ...overrides };
}

describe("automation ids", () => {
  it("names a Collection automation by its path and id, with the path's last # ending it", () => {
    const id = collectionAutomationId("Plans #1/Tasks", "stamp");
    expect(id).toBe("collection:Plans #1/Tasks#stamp");
    expect(parseCollectionAutomationId(id)).toEqual({ collectionPath: "Plans #1/Tasks", id: "stamp" });
    expect(parseCollectionAutomationId("plugin:tools/stamp")).toBeNull();
  });

  it("hashes what an automation does, not its name or switch", () => {
    const base = automation("id: stamp\nname: Stamp\nwhen: record-added\ndo: [{set: {Done: true}}]");
    expect(definitionHash({ ...base, name: "Renamed", enabled: false })).toBe(definitionHash(base));
    expect(definitionHash({ ...base, if: "record.Done" })).not.toBe(definitionHash(base));
  });
});

describe("find conditions", () => {
  it("reads one field test as the query's one filter", () => {
    expect(findQueryOf('record.Status == "Doing"')).toEqual({
      match: "field", field: "Status", operator: "equals", value: { kind: "literal", value: "Doing" },
    });
    expect(findQueryOf('"Doing" === record["Due date"]')).toMatchObject({ field: "Due date", operator: "equals" });
    expect(findQueryOf("record.Points == -3")).toMatchObject({ value: { kind: "literal", value: -3 } });
    expect(findQueryOf('contains(record.Tags, "urgent")')).toMatchObject({ field: "Tags", operator: "contains" });
    expect(findQueryOf("record.Project == trigger.record.Project")).toMatchObject({
      field: "Project", value: { kind: "trigger-field", field: "Project" },
    });
    expect(findQueryOf("(true)")).toEqual({ match: "all" });
  });

  it("refuses a condition the query cannot run, instead of scanning the Collection", () => {
    for (const condition of [
      'record.Status == "Doing" && record.Points > 3',
      "record.Points > 3",
      'record?.Status == "Doing"',
      "record.Status == today()",
      'record.Status == "a"), ("b"',
    ]) {
      expect(findQueryOf(condition)).toEqual({ problem: expect.stringContaining("A Find can check one field") });
    }
  });
});

describe("what the executor can run", () => {
  it("subscribes each record trigger to the changes it names", () => {
    expect(subscriptionFor({ kind: "record-added", table: null })).toEqual({ kinds: ["added"] });
    expect(subscriptionFor({ kind: "field-changed", field: "Status", to: null, table: null })).toEqual({ kinds: ["changed"], fields: ["Status"] });
    expect(subscriptionFor({ kind: "record-changed", fields: null, table: null })).toEqual({ kinds: ["changed"] });
    expect(subscriptionFor({ kind: "starts-matching", condition: "record.Late", table: null })).toEqual({ kinds: ["added", "changed"] });
  });

  it("names why it cannot run messages, code, schedules, or a Find the query cannot express", () => {
    const withStep = (step: string) => automation(`id: a\nname: A\nwhen: record-added\ndo: [${step}]`);
    expect(unsupportedReason(withStep("{set: {Done: true}}"))).toBeNull();
    expect(unsupportedReason(withStep("{notify: Hi, to: [user-1]}"))).toMatch(/messages/);
    expect(unsupportedReason(withStep("{run: 'return 1'}"))).toMatch(/code steps/);
    expect(unsupportedReason(withStep("{find: 'record.Points > 3', as: big}"))).toMatch(/one field/);
    expect(unsupportedReason(withStep("{set: {Done: true}, operation: tasks.edit}"))).toMatch(/dataset/);
    expect(unsupportedReason(automation("id: a\nname: A\nwhen: {record-added: null, table: Tasks}\ndo: [{set: {Done: true}}]"))).toMatch(/dataset/);
    expect(unsupportedReason(automation("id: a\nname: A\nwhen: {schedule: day, timezone: UTC}\ndo: [{find: 'true', as: all}]")))
      .toMatch(/record change/);
    const finds = Array.from({ length: 6 }, (_, index) => `{find: 'true', as: f${index}}`).join(", ");
    expect(unsupportedReason(withStep(finds))).toMatch(/at most 5 Find steps/);
  });
});

describe("field writes", () => {
  it("names each field a step sets, in the Collection the step changes", () => {
    const log = automation([
      "id: log", "name: Log", "when: record-added", "do:",
      "  - set: {Seen: true}",
      "  - add-record: {Task: '=record.Name', Logged on: '=today()'}",
      "    collection: Archive",
      "    as: logged",
      "  - set: {Filed: true}",
      "    records: logged",
      "  - find: 'record.Status == \"Doing\"'",
      "    as: doing",
      "  - if: doing.length > 0",
      "    do:",
      "      - set: {Nudged: true}",
      "        records: doing",
    ].join("\n"));
    expect(fieldWritesOf(log)).toEqual([
      { collection: null, field: "Seen" },
      { collection: "Archive", field: "Task" },
      { collection: "Archive", field: "Logged on" },
      { collection: "Archive", field: "Filed" },
      { collection: null, field: "Nudged" },
    ]);
  });
});

describe("trigger facts", () => {
  const becomesDone = automation("id: stamp\nname: Stamp\nwhen: {field-changed: Status, to: Done}\ndo: [{set: {Done: true}}]");

  it("matches a literal value against the change without the evaluator", () => {
    expect(triggerMatches(inputs(becomesDone))).toBe(true);
    const toBlocked = claim({ fields: [{ field: "Status", historyId: 7, previous: null, next: { value: "Blocked" } }] });
    expect(triggerMatches(inputs(becomesDone, { claim: toBlocked }))).toBe(false);
    expect(triggerMatches(inputs(becomesDone, { claim: claim({ kind: "added" }) }))).toBe(false);
  });

  it("reads a value too large for the claim from the record", () => {
    const truncated = claim({ fields: [{ field: "Status", historyId: 7, previous: null, next: { truncated: true, bytes: 9000 } }] });
    expect(triggerMatches(inputs(becomesDone, { claim: truncated }))).toBe(true);
  });
});

describe("plans", () => {
  const key = { claimId: "atc_one", hash: "0123456789abcdef" };

  it("plans many formulas after matching a large formula-to value", async () => {
    const definition = automation([
      "id: large", "name: Large", "when: {field-changed: Status, to: '=record.Status'}",
      `do: [{set: {${Array.from({ length: 12 }, (_, index) => `F${index}: '= ${index}'`).join(", ")}}}]`,
    ].join("\n"));
    const value = "x".repeat(24 * 1024);
    const run = inputs(definition, {
      record: { ...task, values: { Status: value } },
      claim: claim({ fields: [{ field: "Status", historyId: 7, previous: null, next: { truncated: true, bytes: value.length } }] }),
    });
    const request = evaluationRequest(run, 0);
    const evaluator = createAutomationEvaluator();
    try {
      const results = await evaluator.evaluate(request.scope, request.formulas);
      expect(results).toEqual([value, ...Array.from({ length: 12 }, (_, index) => index)].map(value => ({ ok: true, value })));
      expect(planRun(run, request, results, key).kind).toBe("plan");
    } finally { await evaluator.close(); }
  });

  it("blocks formulas after an active overflowing Find and ignores an inactive Find", () => {
    const definition = automation([
      "id: find", "name: Find", "when: record-added", "do:",
      "  - if: record.Count > 5", "    do: [{find: 'true', as: items}]",
      "    otherwise: [{set: {Note: '=\"fallback\"'}}]",
      "  - set: {Seen: '=true'}",
    ].join("\n"));
    const run = inputs(definition, { found: new Map([[1, [task]]]), truncatedFinds: new Set([1]) });
    const request = evaluationRequest(run, 0);
    expect(request.scope.bindings).not.toHaveProperty("items");
    expect(request.formulas.map(formula => formula.when ?? [])).toEqual([
      [], [{ index: 0, truthy: true }],
      [{ index: 0, truthy: false }, { index: 1, truthy: false }], [{ index: 1, truthy: false }],
    ]);
    const active = [true, true, null, null].map(value => ({ ok: true as const, value }));
    expect(planRun(run, request, active, key)).toEqual({
      kind: "failed", error: "A Find matched more than 50 records. Narrow its condition, then try again.", timedOut: false,
    });
    const inactive = [false, null, "fallback", true].map(value => ({ ok: true as const, value }));
    const planned = planRun(run, request, inactive, key);
    expect(planned.kind === "plan" && planned.steps.map(step => step.ordinal)).toEqual([2, 3]);
  });

  it("refuses a pre-step condition that reads a truncated Find instead of supplying zero matches", async () => {
    const definition = automation([
      "id: find", "name: Find", "when: record-added", "if: items.length > 50", "do:",
      "  - find: 'true'", "    as: items", "  - set: {Seen: true}",
    ].join("\n"));
    const run = inputs(definition, { found: new Map([[0, [task]]]), truncatedFinds: new Set([0]) });
    const request = evaluationRequest(run, 0);
    const evaluator = createAutomationEvaluator();
    try {
      const results = await evaluator.evaluate(request.scope, request.formulas);
      expect(results[0]).toMatchObject({ ok: false, error: { code: "runtime" } });
      expect(planRun(run, request, results, key)).toMatchObject({
        kind: "failed", error: expect.stringContaining('The "Only if" condition failed.'),
      });
    } finally { await evaluator.close(); }
  });

  it.each([
    'when: {starts-matching: record.Status == "Done"}',
    `when: {field-changed: Status, to: '= "Done"'}`,
  ])("skips Only if and actions when the trigger criterion does not match: %s", async when => {
    const definition = automation([
      "id: trigger", "name: Trigger", when, "if: record.Details.name", "do: [{set: {Note: '=record.Details.name'}}]",
    ].join("\n"));
    const run = inputs(definition, {
      record: { ...task, values: { Status: "Doing", Details: null } },
      claim: claim({ fields: [{ field: "Status", historyId: 7, previous: { value: "Todo" }, next: { value: "Doing" } }] }),
    });
    const request = evaluationRequest(run, 0);
    const evaluator = createAutomationEvaluator();
    try {
      const results = await evaluator.evaluate(request.scope, request.formulas);
      expect(planRun(run, request, results, key)).toEqual({ kind: "skip" });
      expect(results.slice(-2)).toEqual([{ ok: true, value: null }, { ok: true, value: null }]);
    } finally { await evaluator.close(); }
  });

  it.each([
    { next: { first: 1, second: [2, 3] }, kind: "plan" },
    { next: { first: 1, second: [3, 2] }, kind: "skip" },
    { next: [1, { nested: true }], kind: "plan" },
    { next: [1, { nested: false }], kind: "skip" },
  ])("matches a formula-to value with deep JSON equality: $next", async ({ next, kind }) => {
    const target = Array.isArray(next) ? '[1, {nested: true}]' : '({second: [2, 3], first: 1})';
    const definition = automation([
      "id: trigger", "name: Trigger", `when: {field-changed: Status, to: '= ${target}'}`, "do: [{set: {Note: '=\"matched\"'}}]",
    ].join("\n"));
    const run = inputs(definition, { claim: claim({ fields: [{ field: "Status", historyId: 7, previous: null, next: { value: next } }] }) });
    const request = evaluationRequest(run, 0);
    const evaluator = createAutomationEvaluator();
    try {
      const results = await evaluator.evaluate(request.scope, request.formulas);
      expect(planRun(run, request, results, key).kind).toBe(kind);
      expect(results[1]).toEqual({ ok: true, value: kind === "plan" ? "matched" : null });
    } finally { await evaluator.close(); }
  });

  it("reports a failing trigger before a false Only if condition", async () => {
    const definition = automation([
      "id: trigger", "name: Trigger", "when: {starts-matching: record.Details.name}", "if: 'false'", "do: [{set: {Note: '=1'}}]",
    ].join("\n"));
    const run = inputs(definition, { record: { ...task, values: { Details: null } }, claim: claim({ kind: "added" }) });
    const request = evaluationRequest(run, 0);
    const evaluator = createAutomationEvaluator();
    try {
      const results = await evaluator.evaluate(request.scope, request.formulas);
      expect(planRun(run, request, results, key)).toMatchObject({ kind: "failed" });
      expect(results.slice(1)).toEqual([{ ok: true, value: null }, { ok: true, value: null }]);
    } finally { await evaluator.close(); }
  });

  it("guards nested conditions and both branches without changing step ordinals", () => {
    const definition = automation([
      "id: guarded", "name: Guarded", "when: record-added", "if: record.Count > 0", "do:",
      "  - if: record.Details != null", "    do:",
      "      - if: record.Details.ready", "        do: [{set: {Note: '=record.Details.name'}}]",
      "        otherwise: [{set: {Note: '=record.Details.fallback'}}]",
      "    otherwise: [{set: {Note: '=\"missing\"'}}]",
      "  - set: {Seen: '=true'}",
    ].join("\n"));
    const request = evaluationRequest(inputs(definition), 0);
    const yes = (index: number) => ({ index, truthy: true });
    const no = (index: number) => ({ index, truthy: false });
    expect(request.formulas.map(formula => formula.when ?? [])).toEqual([
      [], [yes(0)], [yes(0), yes(1)], [yes(0), yes(1), yes(2)],
      [yes(0), yes(1), no(2)], [yes(0), no(1)], [yes(0)],
    ]);
    const plan = planRun(inputs(definition), request,
      [true, false, null, null, null, "missing", true].map(value => ({ ok: true as const, value })), key);
    expect(plan.kind === "plan" && plan.steps.map(step => step.ordinal)).toEqual([4, 5]);
  });

  it("asks for every formula in one request, reading now as the time of the change", () => {
    const definition = automation([
      "id: stamp", "name: Stamp", "when: {field-changed: Status}", "if: record.Count > 1",
      "do:", "  - set: {Finished on: '=today()', Note: literal}",
    ].join("\n"));
    const request = evaluationRequest(inputs(definition), Date.UTC(2026, 8, 25, 1, 30));
    expect(request.formulas).toEqual([
      { kind: "expression", source: "record.Count > 1" },
      { kind: "expression", source: "today()", when: [{ index: 0, truthy: true }] },
    ]);
    expect(request.scope).toMatchObject({
      record: { Status: "Done", Count: 2, id: "rec_task" },
      previous: { Status: "Doing" },
      trigger: { kind: "field-changed", change: "changed", fields: ["Status"], record: { id: "rec_task" } },
      now: localIsoTime(Date.UTC(2026, 8, 25, 1, 30)),
    });
    expect(planRun(inputs(definition), request, [{ ok: true, value: true }, { ok: true, value: "2026-09-25" }], key)).toEqual({
      kind: "plan",
      steps: [{
        ordinal: 0,
        effects: [{
          kind: "set",
          target: { recordId: "rec_task", collectionPath: "Tasks", path: "Tasks/one.md" },
          fields: [
            { field: "Finished on", before: null, after: "2026-09-25" },
            { field: "Note", before: null, after: "literal" },
          ],
        }],
      }],
    });
    expect(planRun(inputs(definition), request, [{ ok: true, value: false }, { ok: true, value: "x" }], key)).toEqual({ kind: "skip" });
  });

  it("takes the branch its condition chose and names added records from the claim and step", () => {
    const definition = automation([
      "id: route", "name: Route", "when: record-added",
      "do:",
      "  - if: record.Count > 5",
      "    do: [{set: {Size: big}}]",
      "    otherwise:",
      "      - add-record: {Title: '=\"Follow up \" + record.Status'}",
      "        collection: Follow ups",
      "        as: follow",
      "      - set: {Owner: me}",
      "        records: follow",
    ].join("\n"));
    const request = evaluationRequest(inputs(definition), 0);
    expect(request.formulas.map((formula) => formula.kind === "expression" && formula.source)).toEqual([
      "record.Count > 5",
      '"Follow up " + record.Status',
    ]);
    const planned = planRun(inputs(definition), request, [{ ok: true, value: false }, { ok: true, value: "Follow up Done" }], key);
    const recordId = derivedRecordId("atc_one/0123456789abcdef/2");
    expect(planned).toEqual({
      kind: "plan",
      steps: [
        { ordinal: 2, effects: [{
          kind: "add", collectionPath: "Follow ups", recordId, name: `route-${recordId.slice(4, 12)}`,
          fields: [{ field: "Title", value: "Follow up Done" }],
        }] },
        { ordinal: 3, effects: [{ kind: "set", target: { addedBy: 2 }, fields: [{ field: "Owner", before: null, after: "me" }] }] },
      ],
    });
  });

  it("maps a formula over each record a Find returned, with record bound to that record", () => {
    const definition = automation([
      "id: bump", "name: Bump", "when: record-added",
      "do:",
      "  - find: record.Project == trigger.record.Project",
      "    as: siblings",
      "  - set: {Count: '=record.Count + 1', Seen: true}",
      "    records: siblings",
    ].join("\n"));
    const siblings = [
      { id: "rec_a", path: "Tasks/a.md", values: { Count: 1 } },
      { id: "rec_b", path: "Tasks/b.md", values: { Count: 4 } },
    ];
    const run = inputs(definition, { found: new Map([[0, siblings]]) });
    const request = evaluationRequest(run, 0);
    expect(request.formulas).toEqual([{ kind: "expression", source: "(siblings).map((record) => (record.Count + 1\n))" }]);
    expect(request.scope.bindings).toEqual({ siblings: [{ Count: 1, id: "rec_a" }, { Count: 4, id: "rec_b" }] });
    const planned = planRun(run, request, [{ ok: true, value: [2, 5] }], key);
    expect(planned).toMatchObject({ kind: "plan", steps: [{ ordinal: 1, effects: [
      { target: { recordId: "rec_a" }, fields: [{ field: "Count", before: 1, after: 2 }, { field: "Seen", before: null, after: true }] },
      { target: { recordId: "rec_b" }, fields: [{ field: "Count", before: 4, after: 5 }, { field: "Seen", before: null, after: true }] },
    ] }] });
    expect(planRun(run, request, [{ ok: true, value: [2] }], key)).toEqual({
      kind: "failed", error: expect.stringContaining("did not give one value for each record"), timedOut: false,
    });
  });

  it("expects each field to hold what the step before it wrote, on every record the run touches", () => {
    const definition = automation([
      "id: count", "name: Count", "when: record-added",
      "do:",
      "  - set: {Count: 1}",
      "  - set: {Count: 2}",
      "  - add-record: {Title: first}",
      "    as: log",
      "  - set: {Title: second}",
      "    records: log",
    ].join("\n"));
    const run = inputs(definition, { record: { ...task, values: { Count: 0 } } });
    const planned = planRun(run, evaluationRequest(run, 0), [], key);
    expect(planned).toMatchObject({ kind: "plan", steps: [
      { effects: [{ fields: [{ field: "Count", before: 0, after: 1 }] }] },
      { effects: [{ fields: [{ field: "Count", before: 1, after: 2 }] }] },
      { effects: [{ kind: "add", fields: [{ field: "Title", value: "first" }] }] },
      { effects: [{ target: { addedBy: 2 }, fields: [{ field: "Title", before: "first", after: "second" }] }] },
    ] });
  });

  it("refuses a run that would change more fields than one run may save", () => {
    const fields = Array.from({ length: 5 }, (_, index) => `F${index}: 1`).join(", ");
    const definition = automation(`id: wide\nname: Wide\nwhen: record-added\ndo: [{find: 'true', as: all}, {set: {${fields}}, records: all}]`);
    const found = Array.from({ length: 50 }, (_, index) => ({ id: `rec_${index}`, path: `Tasks/${index}.md`, values: {} }));
    const run = inputs(definition, { found: new Map([[0, found]]) });
    expect(planRun(run, evaluationRequest(run, 0), [], key)).toEqual({
      kind: "failed",
      error: "This run would change more than 200 fields. Narrow its Find steps, or split it into smaller automations.",
      timedOut: false,
    });
  });

  it("fails the run with the formula's own words, and marks a timeout", () => {
    const definition = automation("id: a\nname: A\nwhen: record-added\ndo: [{set: {X: '=loop()'}}]");
    const request = evaluationRequest(inputs(definition), 0);
    expect(planRun(inputs(definition), request, [{ ok: false, error: { code: "timeout", message: "It ran too long." } }], key))
      .toEqual({ kind: "failed", error: 'The formula for "X" in step 1 failed. It ran too long.', timedOut: true });
  });

  it("runs a starts-matching automation only when the record did not match before the change", () => {
    const definition = automation("id: a\nname: A\nwhen: {starts-matching: record.Status == \"Done\"}\ndo: [{set: {X: 1}}]");
    const request = evaluationRequest(inputs(definition), 0);
    expect(request.formulas[0]).toEqual({ kind: "expression", source: '((record) => (record.Status == "Done"\n))(__dohc_before)' });
    expect(request.scope.bindings).toEqual({ __dohc_before: { Status: "Doing", Count: 2, id: "rec_task" } });
    expect(planRun(inputs(definition), request, [{ ok: true, value: false }, { ok: true, value: true }], key).kind).toBe("plan");
    expect(planRun(inputs(definition), request, [{ ok: true, value: true }, { ok: true, value: true }], key)).toEqual({ kind: "skip" });
  });
});

describe("a formula's syntax, for the builder", () => {
  it("parses without running, so a loop costs nothing, and names what is wrong", () => {
    expect(expressionProblem('record.Status == "Done"')).toBeNull();
    expect(expressionProblem("(() => { while (true) {} })()")).toBeNull();
    expect(expressionProblem("record.Status ==")).toBe("Unexpected token.");
    expect(expressionProblem("1 2")).toBe("Unexpected text at character 3.");
  });
});
