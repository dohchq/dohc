import { describe, expect, it } from "vitest";
import { createAutomationEvaluator } from "@dohc/app-backend-runtime/automation";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { derivedRecordId } from "./recordIds";
import {
  collectionAutomationId,
  definitionHash,
  evaluationRequest,
  fieldWritesOf,
  expressionProblem,
  FIND_OVERFLOW_ERROR,
  findQueryOf,
  findValuesRequest,
  localIsoTime,
  runNowSkippedFrom,
  operationsOf,
  parseCollectionAutomationId,
  planRun,
  scheduleDueAt,
  scheduleHash,
  subscriptionFor,
  triggerMatches,
  unsupportedReason,
  type RunInputs,
} from "./automationPlan";
import { chatDirectoryOf } from "./automationChat";

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
  return { automation: definition, claim: claim(), record: task, found: new Map(), person: null, message: null, chat: null, ...overrides };
}

describe("automation ids", () => {
  it("names a Collection automation by its path and id, with the path's last # ending it", () => {
    const id = collectionAutomationId("Plans #1/Tasks", "stamp");
    expect(id).toBe("collection:Plans #1/Tasks#stamp");
    expect(parseCollectionAutomationId(id)).toEqual({ collectionPath: "Plans #1/Tasks", id: "stamp" });
    expect(parseCollectionAutomationId("other:tools/stamp")).toBeNull();
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

  it("compares with a formula that does not read the record it checks, such as a number a message names", () => {
    expect(findQueryOf("record.ID == message.body.slice(6)")).toEqual({
      match: "field", field: "ID", operator: "equals", value: { kind: "formula", expression: "message.body.slice(6)" },
    });
    expect(findQueryOf("contains(record.Tags, lower(person.name))")).toMatchObject({ operator: "contains", value: { kind: "formula", expression: "lower(person.name)" } });
    expect(findQueryOf("record.Status == today()")).toMatchObject({ value: { kind: "formula", expression: "today()" } });
    // The record a Find checks is no value to compare with, even as a property name's neighbor.
    for (const condition of ["record.Status == record.Other", "record.Status == ({ record }).record.Other", "record.Due == dateAdd(record.Start, 3)"]) {
      expect(findQueryOf(condition), condition).toEqual({ problem: expect.stringContaining("A Find can check one field") });
    }
    expect(findQueryOf("record.Owner == message.record")).toMatchObject({ value: { kind: "formula", expression: "message.record" } });
  });

  it("works out a Find's formulas in one request before it reads, where the trigger record is only trigger.record", () => {
    const definition = automation("id: a\nname: A\nwhen: record-added\ndo: [{find: 'true', as: all}]");
    const request = findValuesRequest(inputs(definition), [
      { ordinal: 0, values: [{ kind: "trigger-field", field: "Status" }] },
      { ordinal: 2, values: [{ kind: "literal", value: 1 }, { kind: "formula", expression: "trigger.record.Count + 1" }] },
    ], 0);
    expect(request.formulas).toEqual([{ kind: "expression", source: "trigger.record.Count + 1" }]);
    expect(request.slots).toEqual([{ ordinal: 2, index: 1 }]);
    expect(request.scope).not.toHaveProperty("record");
    expect(request.scope).toMatchObject({ trigger: { record: { Status: "Done", Count: 2 } }, bindings: {} });
  });

  it("refuses a condition the query cannot run, instead of scanning the Collection", () => {
    for (const condition of [
      'record.Status == "Doing" && record.Points > 3',
      "record.Points > 3",
      'record?.Status == "Doing"',
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
    expect(subscriptionFor({ kind: "schedule", every: "day", at: "09:00", timezone: "UTC" })).toBeNull();
    // A press claims a button's run; no change does.
    expect(subscriptionFor({ kind: "button", field: "Mark paid", table: null })).toBeNull();
  });

  it("runs a document Collection's button, and names the dataset operations a button's steps invoke", () => {
    expect(unsupportedReason(automation("id: a\nname: A\nwhen: {button: Mark paid}\ndo: [{set: {Paid: true}}]"))).toBeNull();
    expect(unsupportedReason(automation("id: a\nname: A\nwhen: {button: Mark paid, table: Invoices}\ndo: [{set: {Paid: true}}]"))).toMatch(/table/);
    const steps = automation([
      "id: a", "name: A", "when: {button: Mark paid, table: Invoices}", "do:",
      "  - set: {Paid: true}", "    operation: invoices.markPaid",
      "  - if: record.Total > 100", "    do: [{add-record: {Note: large}, collection: Log, operation: log.add}]",
      "  - set: {Paid: true}", "    operation: invoices.markPaid",
      "  - invoke: invoices.send",
    ].join("\n"));
    expect(operationsOf(steps)).toEqual(["invoices.markPaid", "log.add", "invoices.send"]);
  });

  it("names why it cannot run code or a Find the query cannot express", () => {
    const withStep = (step: string) => automation(`id: a\nname: A\nwhen: record-added\ndo: [${step}]`);
    expect(unsupportedReason(withStep("{set: {Done: true}}"))).toBeNull();
    expect(unsupportedReason(withStep("{notify: Hi, to: [user-1]}"))).toBeNull();
    expect(unsupportedReason(withStep("{wake-agent: Hi, person: user-1}"))).toBeNull();
    expect(unsupportedReason(withStep("{post: Hi, group: Trip}"))).toBeNull();
    expect(unsupportedReason(withStep("{direct-message: Hi, to: [user-1, '=trigger.record.Owner']}"))).toBeNull();
    expect(unsupportedReason(withStep("{run: 'return 1'}"))).toMatch(/code steps/);
    // A Group message starts an automation dohc can run.
    const fromGroup = (step: string) => automation(`id: a\nname: A\nwhen: {group-message: Trip}\ndo: [${step}]`);
    expect(unsupportedReason(fromGroup("{add-record: {Title: x}}"))).toBeNull();
    expect(unsupportedReason(withStep("{find: 'record.Points > 3', as: big}"))).toMatch(/one field/);
    expect(unsupportedReason(withStep("{set: {Done: true}, operation: tasks.edit}"))).toMatch(/Collection action/);
    expect(unsupportedReason(withStep("{invoke: tasks.archive}"))).toMatch(/Collection action/);
    expect(unsupportedReason(automation("id: a\nname: A\nwhen: {record-added: null, table: Tasks}\ndo: [{set: {Done: true}}]"))).toMatch(/table/);
    const scheduled = (step: string) => automation(`id: a\nname: A\nwhen: {schedule: day, timezone: UTC}\ndo: [${step}]`);
    expect(unsupportedReason(scheduled("{find: 'true', as: all}"))).toBeNull();
    expect(unsupportedReason(scheduled("{find: 'record.Owner == trigger.record.Owner', as: mine}"))).toMatch(/cannot compare with trigger\.record/);
    // A formula built on the trigger record has none to read either.
    for (const find of ["{find: 'record.Owner == trigger.record.Owner + \"\"', as: mine}", "{find: 'record.Owner == lower(trigger[\"record\"].Owner)', as: mine}", "{find: 'record.Owner == trigger[`record`].Owner', as: mine}"]) {
      expect(unsupportedReason(scheduled(find)), find).toMatch(/cannot compare with trigger\.record/);
      expect(unsupportedReason(fromGroup(find)), find).toMatch(/cannot compare with trigger\.record/);
      expect(unsupportedReason(withStep(find)), find).toBeNull();
    }
    expect(unsupportedReason(fromGroup("{find: 'record.Owner == \"ana\"', as: hers}"))).toBeNull();
    expect(unsupportedReason(fromGroup("{find: 'contains(record.Tags, trigger.record.Tag)', as: tagged}")))
      .toBe("A Group message starts this automation, so a Find cannot compare with trigger.record. Compare with a value instead.");
    expect(unsupportedReason(automation("id: a\nname: A\nwhen: {group-message: Team}\ndo: [{post: Hi, group: Team}]")))
      .toBeNull();
    // A Find's formula runs before the Find reads, so no step's result exists yet.
    expect(unsupportedReason(fromGroup("{find: 'record.ID == message.body.slice(6)', as: done}"))).toBeNull();
    expect(unsupportedReason(withStep("{find: 'true', as: all}, {find: 'record.Owner == all[0].Owner', as: same}")))
      .toBe("A Find cannot compare with all, another step's result. Compare with a value, the message, or a formula.");
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

describe("schedule claims", () => {
  const sweep = automation("id: sweep\nname: Sweep\nwhen: {schedule: day, at: '09:00', timezone: UTC}\ndo: [{add-record: {Title: '=today()'}}]");
  const due = Date.UTC(2026, 8, 25, 9);
  const scheduled = (key: string): AutomationClaim => ({
    ...claim(),
    automationId: "collection:Tasks#sweep",
    trigger: { key },
    recordId: null,
    change: { kind: "schedule", authorOriginId: null, actorKind: null, onBehalfOf: null, fields: [], fieldsOmitted: 0 },
  });

  it("reads the due time from the claim's key", () => {
    expect(scheduleDueAt(scheduled(`schedule:${due}`))).toBe(due);
    for (const key of ["press:1", "schedule:", "schedule:01", "schedule:-5", "schedule:99999999999999999"]) {
      expect(scheduleDueAt(scheduled(key)), key).toBeNull();
    }
    expect(scheduleDueAt(claim())).toBeNull();
  });

  it("matches only a schedule claim, and gives formulas the due time instead of a record", () => {
    const run = { person: null, message: null, chat: null, automation: sweep, claim: scheduled(`schedule:${due}`), record: null, found: new Map() };
    expect(triggerMatches(run)).toBe(true);
    expect(triggerMatches({ ...run, claim: claim() })).toBe(false);
    const request = evaluationRequest(run, due);
    expect(request.scope).not.toHaveProperty("record");
    // The due time reads in the schedule's own zone, whatever this computer's is.
    expect(request.scope.trigger).toEqual({ kind: "schedule", dueAt: "2026-09-25T09:00:00.000+00:00" });
    for (const [timezone, instant, dueAt] of [
      ["America/New_York", Date.UTC(2026, 8, 25, 13), "2026-09-25T09:00:00.000-04:00"],
      ["Asia/Kolkata", Date.UTC(2026, 8, 25, 3, 30), "2026-09-25T09:00:00.000+05:30"],
    ] as const) {
      const zoned = automation(`id: sweep\nname: Sweep\nwhen: {schedule: day, at: '09:00', timezone: ${timezone}}\ndo: [{add-record: {Title: x}}]`);
      const zonedRun = { ...run, automation: zoned, claim: scheduled(`schedule:${instant}`) };
      expect(evaluationRequest(zonedRun, instant).scope.trigger, timezone).toEqual({ kind: "schedule", dueAt });
    }
  });

  it("runs a Run now claim at its claim time, with when the skipped runs began", () => {
    const first = Date.UTC(2026, 8, 22, 9);
    const key = `run-now:schedule-skipped:ws-1:collection:Tasks#sweep:${first}`;
    expect(runNowSkippedFrom(scheduled(key))).toBe(first);
    for (const other of [`schedule:${first}`, "run-now:other:1", `run-now:schedule-skipped:${first}`]) {
      expect(runNowSkippedFrom(scheduled(other)), other).toBeNull();
    }
    const run = { person: null, message: null, chat: null, automation: sweep, claim: scheduled(key), record: null, found: new Map() };
    expect(triggerMatches(run)).toBe(true);
    expect(evaluationRequest(run, due).scope.trigger).toEqual({
      kind: "schedule",
      dueAt: "2026-09-25T09:00:00.000+00:00",
      skipped: "2026-09-22T09:00:00.000+00:00",
    });
  });

  it("hashes the schedule, so a changed time or zone starts a new mark", () => {
    const base = { kind: "schedule" as const, every: "day" as const, at: "09:00", timezone: "UTC" };
    expect(scheduleHash(base)).toBe(scheduleHash({ ...base }));
    expect(scheduleHash(base)).not.toBe(scheduleHash({ ...base, at: "10:00" }));
    expect(scheduleHash(base)).not.toBe(scheduleHash({ ...base, timezone: "Europe/London" }));
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
    const run = inputs(definition, { found: new Map([[1, [task]]]), unreadFinds: new Map([[1, { error: FIND_OVERFLOW_ERROR, timedOut: false }]]) });
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
    const run = inputs(definition, { found: new Map([[0, [task]]]), unreadFinds: new Map([[0, { error: FIND_OVERFLOW_ERROR, timedOut: false }]]) });
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

  it("runs a press for the record as it is now, naming the button, when it was pressed, and who pressed it", () => {
    const definition = automation("id: paid\nname: Paid\nwhen: {button: Mark paid}\ndo: [{set: {Paid by: '=person.name'}}]");
    const pressedAt = Date.UTC(2026, 8, 25, 2, 0);
    const press = { ...claim({ kind: "button", onBehalfOf: "user-ice", fields: [] }), trigger: { key: "press:p1" }, createdAtMs: pressedAt };
    const run = inputs(definition, { claim: press, person: { id: "user-ice", name: "Ice" } });
    expect(triggerMatches(run)).toBe(true);
    expect(triggerMatches(inputs(definition))).toBe(false);
    const request = evaluationRequest(run, pressedAt);
    expect(request.scope).toEqual({
      record: { Status: "Done", Count: 2, id: "rec_task" },
      previous: {},
      trigger: { kind: "button", field: "Mark paid", pressedAt: localIsoTime(pressedAt), record: { Status: "Done", Count: 2, id: "rec_task" } },
      person: { id: "user-ice", name: "Ice" },
      bindings: {},
      now: localIsoTime(pressedAt),
    });
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

describe("messages", () => {
  const directory = chatDirectoryOf(
    [{ id: "trip", name: "Trip", slug: "trip", kind: "channel", type: "both", wireId: "trip", runningThreadId: null }],
    { kind: "owner", ownerUserId: null, grants: [] },
  );
  const tell = automation("id: t\nname: T\nwhen: record-added\ndo: [{post: 'Hi {record.Status}', group: Trip}]");
  const key = { claimId: "atc_1", hash: "h" };

  it("posts the text the evaluator rendered, and refuses a message with no text", () => {
    const run = inputs(tell, { chat: directory });
    const request = evaluationRequest(run, 0);
    expect(request.formulas).toEqual([{
      kind: "text", parts: [{ kind: "text", text: "Hi " }, { kind: "expression", expression: "record.Status" }],
    }]);
    expect(planRun(run, request, [{ ok: true, value: "Hi Done  \r\n" }], key)).toMatchObject({
      kind: "plan",
      steps: [{ ordinal: 0, effects: [{
        kind: "message", effectId: "atc_1/h/0/post", to: { kind: "group", channelId: "trip", lane: "posts" }, body: "Hi Done",
      }] }],
    });
    expect(planRun(run, request, [{ ok: true, value: " \n" }], key))
      .toEqual({ kind: "failed", error: "The message in step 1 is empty.", timedOut: false });
    expect(planRun(run, request, [{ ok: true, value: 5 }], key))
      .toEqual({ kind: "failed", error: "The message in step 1 is not text.", timedOut: false });
  });
});
