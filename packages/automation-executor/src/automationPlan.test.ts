import { describe, expect, it } from "vitest";
import { createAutomationEvaluator, type AutomationFormula, type AutomationOutcome, type JsonValue } from "@dohc/app-backend-runtime/automation";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { createAutomationFormulaEvaluator, type AutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { derivedRecordId } from "./recordIds";
import {
  answersOf,
  bindingsIn,
  codeChangesOf,
  codeFilesOf,
  codeRecordKey,
  collectionAutomationId,
  conditionsHold,
  conditionsRequest,
  definitionHash,
  evaluateRequest,
  fieldWritesOf,
  filterValues,
  formulaProblems,
  findQueryOf,
  findRequest,
  localIsoTime,
  MAX_CODE_RECORD_CHANGES,
  namesUsed,
  orderSteps,
  runNowSkippedFrom,
  operationsOf,
  parseCollectionAutomationId,
  planStep,
  scheduleDueAt,
  scheduleHash,
  stepRequest,
  subscriptionFor,
  triggerMatches,
  unavailableTo,
  unsupportedReason,
  type Bound,
  type EvaluationRequest,
  type OrderedStep,
  type RunContext,
  type RunRecord,
  type StepInputs,
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

/** A request's formulas, for a run without code steps. */
const formulasOf = (request: EvaluationRequest) => request.items.filter((item): item is AutomationFormula => item.kind !== "code");

function claim(change: Partial<RecordChange> = {}): AutomationClaim & { collectionPath: string } {
  return {
    claimId: "atc_one",
    automationId: "collection:Tasks#stamp",
    trigger: { historyId: 7 },
    recordId: "rec_task",
    collectionPath: "Tasks",
    depth: 0,
    change: {
      kind: "changed", authorOriginId: null, actorKind: "human", onBehalfOf: null, sharedAuthor: null, liveCursor: null,
      fields: [{ field: "Status", historyId: 7, previous: { value: "Doing" }, next: { value: "Done" } }],
      fieldsOmitted: 0,
      ...change,
    },
    state: "running", attempts: 1, run: 1, createdAtMs: Date.UTC(2026, 8, 25, 1, 30), updatedAtMs: 0,
  };
}

const task = { id: "rec_task", path: "Tasks/one.md", values: { Status: "Done", Count: 2 } };


describe("automation ids", () => {
  it("names a Collection automation by its Collection id, never a path, and its own id", () => {
    const id = collectionAutomationId("object-3f9a", "stamp");
    expect(id).toBe("collection:object-3f9a#stamp");
    expect(parseCollectionAutomationId(id)).toEqual({ collectionId: "object-3f9a", id: "stamp" });
    expect(parseCollectionAutomationId("other:tools/stamp")).toBeNull();
    expect(parseCollectionAutomationId("collection:Plans/Tasks#stamp"), "a path is not a Collection id").toBeNull();
    expect(parseCollectionAutomationId("collection:#stamp")).toBeNull();
    expect(parseCollectionAutomationId("collection:object-3f9a#")).toBeNull();
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

  it("runs code steps, and names why it cannot run a Find the query cannot express", () => {
    const withStep = (step: string) => automation(`id: a\nname: A\nwhen: record-added\ndo: [${step}]`);
    expect(unsupportedReason(withStep("{set: {Done: true}}"))).toBeNull();
    expect(unsupportedReason(withStep("{notify: Hi, to: [user-1]}"))).toBeNull();
    expect(unsupportedReason(withStep("{wake-agent: Hi, person: user-1}"))).toBeNull();
    expect(unsupportedReason(withStep("{post: Hi, group: Trip}"))).toBeNull();
    expect(unsupportedReason(withStep("{direct-message: Hi, to: [user-1, '=trigger.record.Owner']}"))).toBeNull();
    expect(unsupportedReason(withStep("{run: 'return {}'}"))).toBeNull();
    expect(unsupportedReason(withStep("{run-file: scripts/total.js, as: total}"))).toBeNull();
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
    // A Find's formula can read the message, and an earlier step's result.
    expect(unsupportedReason(fromGroup("{find: 'record.ID == message.body.slice(6)', as: done}"))).toBeNull();
    expect(unsupportedReason(withStep("{find: 'true', as: all}, {find: 'record.Owner == all[0].Owner', as: same}"))).toBeNull();
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
  const due = Date.UTC(2026, 8, 25, 9);
  const scheduled = (key: string): AutomationClaim & { collectionPath: string } => ({
    ...claim(),
    automationId: "collection:Tasks#sweep",
    trigger: { key },
    recordId: null,
    change: { kind: "schedule", authorOriginId: null, actorKind: null, onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
  });

  it("reads the due time from the claim's key", () => {
    expect(scheduleDueAt(scheduled(`schedule:${due}`))).toBe(due);
    for (const key of ["press:1", "schedule:", "schedule:01", "schedule:-5", "schedule:99999999999999999"]) {
      expect(scheduleDueAt(scheduled(key)), key).toBeNull();
    }
    expect(scheduleDueAt(claim())).toBeNull();
  });

  it("hashes the schedule, so a changed time or zone starts a new mark", () => {
    const base = { kind: "schedule" as const, every: "day" as const, at: "09:00", timezone: "UTC" };
    expect(scheduleHash(base)).toBe(scheduleHash({ ...base }));
    expect(scheduleHash(base)).not.toBe(scheduleHash({ ...base, at: "10:00" }));
    expect(scheduleHash(base)).not.toBe(scheduleHash({ ...base, timezone: "Europe/London" }));
  });
});
describe("a formula's syntax, for the builder", () => {
  const syntax = (automation: Partial<Automation>) => formulaProblems({
    id: "a", name: "A", enabled: true, when: { kind: "record-added", table: null }, if: null, do: [], ...automation,
  });

  it("parses without running, so a loop costs nothing, and names what is wrong", () => {
    expect(syntax({ if: 'record.Status == "Done"' })).toEqual([]);
    expect(syntax({ if: "(() => { while (true) {} })()" })).toEqual([]);
    expect(syntax({ if: "record.Status ==" })).toEqual([{ path: "/if", problem: "Unexpected token." }]);
    expect(syntax({ if: "1 2" })).toEqual([{ path: "/if", problem: "Unexpected text at character 3." }]);
  });

  it("finds every formula at the path the file contract gives it, inside If branches too, and leaves empty ones", () => {
    const bad = { kind: "formula" as const, expression: "1 +" };
    expect(syntax({
      when: { kind: "field-changed", field: "Status", to: bad, table: null },
      if: " ",
      do: [
        { kind: "set", values: [{ field: "a/b~c", value: bad }, { field: "Ok", value: { kind: "formula", expression: "1" } }], records: null, operation: null },
        { kind: "if", if: "1 +", do: [
          { kind: "find", condition: "1 +", collection: null, as: "found", operation: null },
        ], otherwise: [
          { kind: "invoke", operation: "a.b", input: [{ key: "id", value: bad }] },
          { kind: "notify", text: "Hi {record.Title", to: [{ kind: "literal", value: "ana" }, bad] },
          { kind: "post", text: "Hi {record.Title} {{ok}}", group: "Trip" },
          { kind: "wake-agent", text: "{record?.of / 2}", person: "owner" },
          { kind: "add-record", values: [{ field: "Title", value: bad }], collection: null, as: null, operation: null },
        ] },
      ],
    }).map(({ path }) => path)).toEqual([
      "/when/to",
      "/do/0/set/a~1b~0c",
      "/do/1/if",
      "/do/1/do/0/find",
      "/do/1/otherwise/0/input/id",
      "/do/1/otherwise/1/notify",
      "/do/1/otherwise/1/to/1",
      "/do/1/otherwise/3/wake-agent",
      "/do/1/otherwise/4/add-record/Title",
    ]);
    // Code parses as the strict body the guest runs, and never runs here.
    expect(syntax({ do: [{ kind: "run", code: "const total = 1;\nreturn { total: total + };", as: null }] }))
      .toEqual([{ path: "/do/0/run", problem: "Unexpected token on line 2." }]);
    expect(syntax({ do: [{ kind: "run", code: "while (true) {}\nreturn 1;", as: "one" }] })).toEqual([]);
    expect(syntax({ do: [{ kind: "run", code: "with (ctx) {}", as: null }] })).toEqual([
      { path: "/do/0/run", problem: "'with' in strict mode on line 1." },
    ]);
    // It is the body of a function of ctx, as the guest builds it.
    expect(syntax({ do: [{ kind: "run", code: "const ctx = 1;\nreturn ctx;", as: null }] })).toEqual([
      { path: "/do/0/run", problem: "Identifier 'ctx' has already been declared on line 1." },
    ]);
    expect(syntax({ do: [{ kind: "run", code: "return new.target;", as: null }] })).toEqual([]);
    // A block the code never closes is on its last line, not the line after.
    expect(syntax({ do: [{ kind: "run", code: "if (true) {\n  return 1;", as: null }] })).toEqual([
      { path: "/do/0/run", problem: "Unexpected token on line 2." },
    ]);
    // Every JavaScript line break counts as one.
    expect(syntax({ do: [{ kind: "run", code: "if (true) {\r  return 1;\u2028", as: null }] })).toEqual([
      { path: "/do/0/run", problem: "Unexpected token on line 3." },
    ]);
    for (const code of ["return 1; }); (function () {", "return 1; }, function () {"]) {
      expect(syntax({ do: [{ kind: "run", code, as: null }] })).toEqual([
        { path: "/do/0/run", problem: "The code ends the step's function early. Remove the extra closing brace." },
      ]);
    }
    expect(syntax({ do: [{ kind: "notify", text: "Hi {1 +}", to: [{ kind: "literal", value: "ana" }] }] }))
      .toEqual([{ path: "/do/0/notify", code: "invalid-template" }]);
    expect(syntax({ do: [{ kind: "post", text: "{record?.of / 2}", group: "Trip" }] }))
      .toEqual([{ path: "/do/0/post", code: "optional-chain-needs-parentheses" }]);
    expect(syntax({ when: { kind: "starts-matching", condition: "a ==", table: null } })).toEqual([
      { path: "/when/starts-matching", problem: "Unexpected token." },
    ]);
  });
});

const key = { claimId: "atc_one", hash: "0123456789abcdef" };

function context(definition: Automation, overrides: Partial<RunContext> = {}): RunContext {
  return { automation: definition, claim: claim(), person: null, message: null, chat: null, nowMs: 0, key, ...overrides };
}

const inputsOf = (record: RunRecord | null = task, bound: ReadonlyMap<string, Bound> = new Map()): StepInputs => ({ record, bound, unavailable: {} });

/** The step at `ordinal`, as the executor walks it. */
function entryAt(definition: Automation, ordinal: number): OrderedStep {
  const walk = (entries: readonly OrderedStep[]): OrderedStep | undefined => {
    for (const entry of entries) {
      if (entry.ordinal === ordinal) return entry;
      const inner = "then" in entry ? walk([...entry.then, ...entry.otherwise]) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  const found = walk(orderSteps(definition.do));
  if (!found) throw new Error(`No step ${ordinal}.`);
  return found;
}

const ok = (...values: JsonValue[]): AutomationOutcome<JsonValue>[] => values.map((value) => ({ ok: true, value }));

/** Plans the step at `ordinal` from the evaluator's answers to its request. */
function planAt(
  ctx: RunContext,
  ordinal: number,
  inputs: StepInputs,
  results: readonly AutomationOutcome<JsonValue>[],
  extra: { codeRecords?: ReadonlyMap<string, RunRecord> } = {},
) {
  const entry = entryAt(ctx.automation, ordinal);
  const request = stepRequest(ctx, entry, inputs);
  const answers = answersOf(request, results);
  if ("error" in answers) return answers;
  const codeChanges = codeChangesOf(request, results, ctx.claim.collectionPath);
  if ("problem" in codeChanges) return codeChanges;
  return planStep(ctx, entry, inputs, answers, { chat: ctx.chat, codeChanges, codeRecords: extra.codeRecords ?? new Map() });
}

describe("schedule and press scopes", () => {
  const sweep = automation("id: sweep\nname: Sweep\nwhen: {schedule: day, at: '09:00', timezone: UTC}\ndo: [{add-record: {Title: '=today()'}}]");
  const due = Date.UTC(2026, 8, 25, 9);
  const scheduled = (claimKey: string): AutomationClaim & { collectionPath: string } => ({
    ...claim(),
    automationId: "collection:Tasks#sweep",
    trigger: { key: claimKey },
    recordId: null,
    change: { kind: "schedule", authorOriginId: null, actorKind: null, onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 },
  });

  it("matches only a schedule claim, and gives formulas the due time instead of a record", () => {
    expect(triggerMatches(sweep, scheduled(`schedule:${due}`), null)).toBe(true);
    expect(triggerMatches(sweep, claim(), null)).toBe(false);
    const request = stepRequest(context(sweep, { claim: scheduled(`schedule:${due}`), nowMs: due }), entryAt(sweep, 0), inputsOf(null));
    expect(request.scope).not.toHaveProperty("record");
    // The due time reads in the schedule's own zone, whatever this computer's is.
    expect(request.scope.trigger).toEqual({ kind: "schedule", dueAt: "2026-09-25T09:00:00.000+00:00" });
    for (const [timezone, instant, dueAt] of [
      ["America/New_York", Date.UTC(2026, 8, 25, 13), "2026-09-25T09:00:00.000-04:00"],
      ["Asia/Kolkata", Date.UTC(2026, 8, 25, 3, 30), "2026-09-25T09:00:00.000+05:30"],
    ] as const) {
      const zoned = automation(`id: sweep\nname: Sweep\nwhen: {schedule: day, at: '09:00', timezone: ${timezone}}\ndo: [{add-record: {Title: x}}]`);
      const scope = stepRequest(context(zoned, { claim: scheduled(`schedule:${instant}`), nowMs: instant }), entryAt(zoned, 0), inputsOf(null)).scope;
      expect(scope.trigger, timezone).toEqual({ kind: "schedule", dueAt });
    }
  });

  it("runs a Run now claim at its claim time, with when the skipped runs began", () => {
    const first = Date.UTC(2026, 8, 22, 9);
    const claimKey = `run-now:schedule-skipped:ws-1:collection:Tasks#sweep:${first}`;
    expect(runNowSkippedFrom(scheduled(claimKey))).toBe(first);
    for (const other of [`schedule:${first}`, "run-now:other:1", `run-now:schedule-skipped:${first}`]) {
      expect(runNowSkippedFrom(scheduled(other)), other).toBeNull();
    }
    expect(triggerMatches(sweep, scheduled(claimKey), null)).toBe(true);
    expect(stepRequest(context(sweep, { claim: scheduled(claimKey), nowMs: due }), entryAt(sweep, 0), inputsOf(null)).scope.trigger).toEqual({
      kind: "schedule",
      dueAt: "2026-09-25T09:00:00.000+00:00",
      skipped: "2026-09-22T09:00:00.000+00:00",
    });
  });

  it("runs a press for the record as it is now, naming the button, when it was pressed, and who pressed it", () => {
    const definition = automation("id: paid\nname: Paid\nwhen: {button: Mark paid}\ndo: [{set: {Paid by: '=person.name'}}]");
    const pressedAt = Date.UTC(2026, 8, 25, 2, 0);
    const press = { ...claim({ kind: "button", onBehalfOf: "user-ice", fields: [] }), trigger: { key: "press:p1" }, createdAtMs: pressedAt };
    expect(triggerMatches(definition, press, task)).toBe(true);
    expect(triggerMatches(definition, claim(), task)).toBe(false);
    const request = stepRequest(context(definition, { claim: press, person: { id: "user-ice", name: "Ice" }, nowMs: pressedAt }), entryAt(definition, 0), inputsOf());
    expect(request.scope).toEqual({
      record: { Status: "Done", Count: 2, id: "rec_task" },
      previous: {},
      trigger: { kind: "button", field: "Mark paid", pressedAt: localIsoTime(pressedAt), record: { Status: "Done", Count: 2, id: "rec_task" } },
      person: { id: "user-ice", name: "Ice" },
      bindings: {},
      now: localIsoTime(pressedAt),
    });
  });
});

describe("trigger facts", () => {
  const becomesDone = automation("id: stamp\nname: Stamp\nwhen: {field-changed: Status, to: Done}\ndo: [{set: {Done: true}}]");

  it("matches a literal value against the change without the evaluator", () => {
    expect(triggerMatches(becomesDone, claim(), task)).toBe(true);
    const toBlocked = claim({ fields: [{ field: "Status", historyId: 7, previous: null, next: { value: "Blocked" } }] });
    expect(triggerMatches(becomesDone, toBlocked, task)).toBe(false);
    expect(triggerMatches(becomesDone, claim({ kind: "added" }), task)).toBe(false);
  });

  it("reads a value too large for the claim from the record", () => {
    const truncated = claim({ fields: [{ field: "Status", historyId: 7, previous: null, next: { truncated: true, bytes: 9000 } }] });
    expect(triggerMatches(becomesDone, truncated, task)).toBe(true);
  });
});

describe("who a change came through", () => {
  it("names who the relay accepted a live change from as trigger.author, and never as the person", () => {
    const definition = automation(["id: stamp", "name: Stamp", "when: {field-changed: Status}", "do: [{set: {Note: '=trigger.author.kind'}}]"].join("\n"));
    const scope = (change: Partial<RecordChange>) => stepRequest(context(definition, { claim: claim(change) }), entryAt(definition, 0), inputsOf()).scope;
    const link = { kind: "link" as const, grantId: "grant-link", grantGeneration: 2, principalId: "holder-1" };
    expect(scope({ sharedAuthor: link }).trigger).toMatchObject({ kind: "field-changed", author: link });
    expect(scope({ sharedAuthor: link }).person).toBeNull();
    const named = { kind: "named" as const, userId: "user-ana", grantId: "grant-ana", grantGeneration: 1 };
    expect(scope({ sharedAuthor: named }).trigger).toMatchObject({ author: named });
    expect(scope({ sharedAuthor: named }).person).toBeNull();
    // The owner's own change names no shared author.
    expect(scope({}).trigger).toMatchObject({ author: null });
  });
});

describe("conditions", () => {
  it("checks a large formula-to value against the record the claim left it out of", async () => {
    const definition = automation("id: large\nname: Large\nwhen: {field-changed: Status, to: '=record.Status'}\ndo: [{set: {F: 1}}]");
    const value = "x".repeat(24 * 1024);
    const record = { ...task, values: { Status: value } };
    const ctx = context(definition, { claim: claim({ fields: [{ field: "Status", historyId: 7, previous: null, next: { truncated: true, bytes: value.length } }] }) });
    const request = conditionsRequest(ctx, record);
    const evaluator = createAutomationEvaluator();
    try {
      const results = await evaluator.evaluate(request.scope, formulasOf(request));
      expect(results).toEqual([{ ok: true, value }]);
      expect(conditionsHold(ctx, record, request, results)).toBe("go");
    } finally { await evaluator.close(); }
  });

  it.each([
    'when: {starts-matching: record.Status == "Done"}',
    `when: {field-changed: Status, to: '= "Done"'}`,
  ])("skips Only if when the trigger criterion does not match: %s", async (when) => {
    const definition = automation(["id: trigger", "name: Trigger", when, "if: record.Details.name", "do: [{set: {Note: '=record.Details.name'}}]"].join("\n"));
    const record = { ...task, values: { Status: "Doing", Details: null } };
    const ctx = context(definition, { claim: claim({ fields: [{ field: "Status", historyId: 7, previous: { value: "Todo" }, next: { value: "Doing" } }] }) });
    const request = conditionsRequest(ctx, record);
    const evaluator = createAutomationEvaluator();
    try {
      const results = await evaluator.evaluate(request.scope, formulasOf(request));
      expect(conditionsHold(ctx, record, request, results)).toBe("skip");
      expect(results.at(-1)).toEqual({ ok: true, value: null });
    } finally { await evaluator.close(); }
  });

  it.each([
    { next: { first: 1, second: [2, 3] }, go: true },
    { next: { first: 1, second: [3, 2] }, go: false },
    { next: [1, { nested: true }], go: true },
    { next: [1, { nested: false }], go: false },
  ])("matches a formula-to value with deep JSON equality: $next", async ({ next, go }) => {
    const target = Array.isArray(next) ? "[1, {nested: true}]" : "({second: [2, 3], first: 1})";
    const definition = automation(["id: trigger", "name: Trigger", `when: {field-changed: Status, to: '= ${target}'}`, "do: [{set: {Note: matched}}]"].join("\n"));
    const ctx = context(definition, { claim: claim({ fields: [{ field: "Status", historyId: 7, previous: null, next: { value: next } }] }) });
    const request = conditionsRequest(ctx, task);
    const evaluator = createAutomationEvaluator();
    try {
      const results = await evaluator.evaluate(request.scope, formulasOf(request));
      expect(conditionsHold(ctx, task, request, results)).toBe(go ? "go" : "skip");
    } finally { await evaluator.close(); }
  });

  it("reports a failing trigger before a false Only if condition", async () => {
    const definition = automation("id: trigger\nname: Trigger\nwhen: {starts-matching: record.Details.name}\nif: 'false'\ndo: [{set: {Note: 1}}]");
    const record = { ...task, values: { Details: null } };
    const ctx = context(definition, { claim: claim({ kind: "added" }) });
    const request = conditionsRequest(ctx, record);
    const evaluator = createAutomationEvaluator();
    try {
      const results = await evaluator.evaluate(request.scope, formulasOf(request));
      expect(conditionsHold(ctx, record, request, results)).toMatchObject({ error: expect.stringContaining("The condition this automation waits for failed.") });
      expect(results.slice(1)).toEqual([{ ok: true, value: null }]);
    } finally { await evaluator.close(); }
  });

  it("runs a starts-matching automation only when the record did not match before the change", () => {
    const definition = automation("id: a\nname: A\nwhen: {starts-matching: record.Status == \"Done\"}\ndo: [{set: {X: 1}}]");
    const ctx = context(definition);
    const request = conditionsRequest(ctx, task);
    expect(formulasOf(request)[0]).toEqual({ kind: "expression", source: '((record) => (record.Status == "Done"\n))(__dohc_before)' });
    expect(request.scope.bindings).toEqual({ __dohc_before: { Status: "Doing", Count: 2, id: "rec_task" } });
    expect(conditionsHold(ctx, task, request, ok(false, true))).toBe("go");
    expect(conditionsHold(ctx, task, request, ok(true, true))).toBe("skip");
  });

  it("asks nothing when the automation has no condition", () => {
    const definition = automation("id: a\nname: A\nwhen: record-added\ndo: [{set: {X: 1}}]");
    expect(conditionsRequest(context(definition), task).items).toEqual([]);
  });
});

describe("steps", () => {
  it("evaluates one step's formulas against the record as the step read it, reading now as the time of the change", () => {
    const definition = automation("id: stamp\nname: Stamp\nwhen: {field-changed: Status}\ndo:\n  - set: {Finished on: '=today()', Note: literal}");
    const ctx = context(definition, { nowMs: Date.UTC(2026, 8, 25, 1, 30) });
    const request = stepRequest(ctx, entryAt(definition, 0), inputsOf());
    expect(formulasOf(request)).toEqual([{ kind: "expression", source: "today()" }]);
    expect(request.scope).toMatchObject({
      record: { Status: "Done", Count: 2, id: "rec_task" },
      previous: { Status: "Doing" },
      trigger: { kind: "field-changed", change: "changed", fields: ["Status"], record: { id: "rec_task" } },
      now: localIsoTime(Date.UTC(2026, 8, 25, 1, 30)),
    });
    expect(planAt(ctx, 0, inputsOf(), ok("2026-09-25"))).toEqual({ step: {
      ordinal: 0,
      effects: [{
        kind: "set",
        target: { recordId: "rec_task", collectionPath: "Tasks", path: "Tasks/one.md" },
        fields: [{ field: "Finished on", before: null, after: "2026-09-25" }, { field: "Note", before: null, after: "literal" }],
      }],
    } });
  });

  it("takes each field's before value from the record as this step read it, after the steps before it landed", () => {
    const definition = automation("id: count\nname: Count\nwhen: record-added\ndo: [{set: {Count: '=record.Count + 1'}}, {set: {Count: '=record.Count + 1'}}]");
    const ctx = context(definition);
    const later = { ...task, values: { Count: 3 } };
    expect(planAt(ctx, 1, inputsOf(later), ok(4))).toMatchObject({ step: { effects: [{ fields: [{ field: "Count", before: 3, after: 4 }] }] } });
  });

  it("decides an If's branch as its result, with no effects", () => {
    const definition = automation("id: route\nname: Route\nwhen: record-added\ndo:\n  - if: record.Count > 5\n    do: [{set: {Size: big}}]\n    otherwise: [{set: {Size: small}}]");
    const ctx = context(definition);
    expect(formulasOf(stepRequest(ctx, entryAt(definition, 0), inputsOf()))).toEqual([{ kind: "expression", source: "record.Count > 5" }]);
    expect(planAt(ctx, 0, inputsOf(), ok(false))).toEqual({ step: { ordinal: 0, effects: [], output: { kind: "if", branch: false } } });
  });

  it("names an added record from the claim and step, and sets fields on it as a later step read it", () => {
    const definition = automation([
      "id: route", "name: Route", "when: record-added", "do:",
      "  - add-record: {Title: '=\"Follow up \" + record.Status'}", "    collection: Follow ups", "    as: follow",
      "  - set: {Owner: '=follow.Title + \"!\"'}", "    records: follow",
    ].join("\n"));
    const ctx = context(definition);
    const recordId = derivedRecordId("atc_one/0123456789abcdef/0");
    expect(planAt(ctx, 0, inputsOf(), ok("Follow up Done"))).toEqual({ step: { ordinal: 0, effects: [{
      kind: "add", collectionPath: "Follow ups", recordId, name: `route-${recordId.slice(4, 12)}`, fields: [{ field: "Title", value: "Follow up Done" }],
    }] } });
    const added = { id: "rec_added", path: "Follow ups/route.md", values: { Title: "Follow up Done", Owner: null } };
    const bound = new Map<string, Bound>([["follow", { kind: "add", record: added }]]);
    const request = stepRequest(ctx, entryAt(definition, 1), inputsOf(task, bound));
    expect(request.scope.bindings).toEqual({ follow: { Title: "Follow up Done", Owner: null, id: "rec_added" } });
    expect(planAt(ctx, 1, inputsOf(task, bound), ok("Follow up Done!"))).toEqual({ step: { ordinal: 1, effects: [{
      kind: "set", target: { recordId: "rec_added", collectionPath: "Follow ups", path: "Follow ups/route.md" },
      fields: [{ field: "Owner", before: null, after: "Follow up Done!" }],
    }] } });
    // An added record someone removed since leaves nothing to change.
    expect(planAt(ctx, 1, inputsOf(task, new Map([["follow", { kind: "add", record: null }]])), ok("x"))).toEqual({ step: { ordinal: 1, effects: [] } });
  });

  it("maps a formula over each record a Find returned, as this step read them, with record bound to that record", () => {
    const definition = automation([
      "id: bump", "name: Bump", "when: record-added", "do:",
      "  - find: record.Project == trigger.record.Project", "    as: siblings",
      "  - set: {Count: '=record.Count + 1', Seen: true}", "    records: siblings",
    ].join("\n"));
    const siblings = [{ id: "rec_a", path: "Tasks/a.md", values: { Count: 1 } }, { id: "rec_b", path: "Tasks/b.md", values: { Count: 4 } }];
    const ctx = context(definition);
    const inputs = inputsOf(task, new Map([["siblings", { kind: "find", records: siblings }]]));
    const request = stepRequest(ctx, entryAt(definition, 1), inputs);
    expect(formulasOf(request)).toEqual([{ kind: "expression", source: "(siblings).map((record) => (record.Count + 1\n))" }]);
    expect(request.scope.bindings).toEqual({ siblings: [{ Count: 1, id: "rec_a" }, { Count: 4, id: "rec_b" }] });
    expect(planAt(ctx, 1, inputs, ok([2, 5]))).toMatchObject({ step: { ordinal: 1, effects: [
      { target: { recordId: "rec_a" }, fields: [{ field: "Count", before: 1, after: 2 }, { field: "Seen", before: null, after: true }] },
      { target: { recordId: "rec_b" }, fields: [{ field: "Count", before: 4, after: 5 }, { field: "Seen", before: null, after: true }] },
    ] } });
    expect(planAt(ctx, 1, inputs, ok([2]))).toEqual({ problem: expect.stringContaining("did not give one value for each record") });
  });

  it("asks a Find's formulas with earlier results in scope and the trigger record only as trigger.record", () => {
    const definition = automation([
      "id: a", "name: A", "when: record-added", "do:",
      "  - run: 'return { output: 3 }'", "    as: limit",
      "  - find: record.Count == limit + trigger.record.Count", "    as: matched",
    ].join("\n"));
    const ctx = context(definition);
    const values = [{ kind: "formula" as const, expression: "limit + trigger.record.Count" }];
    const request = findRequest(ctx, 1, inputsOf(task, new Map([["limit", { kind: "code", value: 3 }]])), values);
    expect(formulasOf(request)).toEqual([{ kind: "expression", source: "limit + trigger.record.Count" }]);
    expect(request.scope).not.toHaveProperty("record");
    expect(request.scope).toMatchObject({ trigger: { record: { Count: 2 } }, bindings: { limit: 3 } });
    const answers = answersOf(request, ok(5));
    expect(answers instanceof Map && filterValues([{ kind: "literal", value: 1 }, { kind: "trigger-field", field: "Count" }, ...values], task,
      new Map([["find:2", 5]]))).toEqual([1, 2, 5]);
  });

  it("fails a step with the formula's own words, and marks a timeout", () => {
    const definition = automation("id: a\nname: A\nwhen: record-added\ndo: [{set: {X: '=loop()'}}]");
    expect(planAt(context(definition), 0, inputsOf(), [{ ok: false, error: { code: "timeout", message: "It ran too long." } }]))
      .toEqual({ error: 'The formula for "X" in step 1 failed. It ran too long.', timedOut: true });
  });

  it("keeps a timed-out formula's failure when another formula in the same step failed before it", () => {
    const definition = automation(["id: a", "name: A", "when: record-added", "do: [{set: {X: '=a()', Y: '=b()', Z: '=1'}}]"].join("\n"));
    const request = stepRequest(context(definition), entryAt(definition, 0), inputsOf());
    expect(answersOf(request, [
      { ok: false, error: { code: "runtime", message: "It threw." } },
      { ok: false, error: { code: "timeout", message: "It ran out of time." } },
      { ok: true, value: 1 },
    ])).toEqual({ error: 'The formula for "Y" in step 1 failed. It ran out of time.', timedOut: true });
  });

  it("fails a Set with no record to change", () => {
    // Someone removed the trigger record after an earlier step ran.
    const definition = automation("id: a\nname: A\nwhen: record-added\ndo: [{set: {X: 1}}]");
    expect(planAt(context(definition), 0, inputsOf(null), [])).toEqual({ problem: "The record was removed, so the automation has no record to change." });
  });
});

describe("what a step can read", () => {
  const definition = automation([
    "id: a", "name: A", "when: record-added", "do:",
    "  - set: {Note: '=later.length'}",
    "  - if: record.Count > 5",
    "    do: [{find: 'true', as: big}]",
    "  - set: {Note: '=big.length'}",
    "  - find: 'true'", "    as: later",
    "  - run: 'return {}'",
  ].join("\n"));
  const bindings = bindingsIn(definition);

  it("names the earlier results a step's formulas read, and every result for code", () => {
    expect([...(namesUsed(entryAt(definition, 0).step) as Set<string>)]).toEqual(["later"]);
    expect(namesUsed(entryAt(definition, 5).step)).toBe("all");
    const indirect = automation(["id: g", "name: G", "when: record-added", "do: [{find: 'true', as: team}, {set: {X: '=globalThis.team.length'}}]"].join("\n"));
    // A result a formula reaches without naming it is not read, and reading it that way says so.
    expect([...(namesUsed(entryAt(indirect, 1).step) as Set<string>)]).toEqual(["globalThis"]);
    expect(unavailableTo(1, bindingsIn(indirect), new Set(["team"]), new Set(["globalThis"]))).toEqual({
      team: "team is step 1's result, and a formula gets it only by naming it. Write team in the formula.",
    });
    expect(unavailableTo(1, bindingsIn(indirect), new Set(["team"]), "all")).toEqual({});
    // A result named __proto__ is kept as a name of its own.
    const odd = automation(["id: o", "name: O", "when: record-added", "do: [{set: {X: 1}}, {find: 'true', as: __proto__}]"].join("\n"));
    expect(Object.keys(unavailableTo(0, bindingsIn(odd), new Set(), "all"))).toEqual(["__proto__"]);
    const set = automation("id: s\nname: S\nwhen: record-added\ndo: [{find: 'true', as: all}, {set: {X: 1}, records: all}, {post: 'Hi {all.length}', group: Trip}]");
    expect([...(namesUsed(entryAt(set, 1).step) as Set<string>)]).toEqual(["all"]);
    expect([...(namesUsed(entryAt(set, 2).step) as Set<string>)]).toEqual(["all"]);
  });

  it("says why a step cannot read a result a later step makes, or one a branch the run did not take makes", () => {
    expect(unavailableTo(0, bindings, new Set(), "all")).toEqual({
      big: "big is step 3's result, and step 3 comes after step 1.",
      later: "later is step 5's result, and step 5 comes after step 1.",
    });
    expect(unavailableTo(3, bindings, new Set(["later"]), new Set(["later"]))).toEqual({ big: "big is step 3's result, and step 3 did not run." });
    // The evaluator stops a formula that reads one with that text.
    const inputs = { ...inputsOf(), unavailable: unavailableTo(0, bindings, new Set(), "all") };
    expect(stepRequest(context(definition), entryAt(definition, 0), inputs).scope.unavailable).toEqual(inputs.unavailable);
  });

  it("gives the conditions no step's result, since they are checked before any step runs", () => {
    expect(conditionsRequest(context(definition), task).scope.unavailable).toMatchObject({
      big: "big is step 3's result, and steps run only once this automation's conditions hold. Check it in an If step instead.",
    });
  });
});

describe("messages", () => {
  const directory = chatDirectoryOf(
    [{ id: "trip", name: "Trip", slug: "trip", kind: "channel", type: "both", wireId: "trip", runningThreadId: null }],
    { kind: "owner", ownerUserId: null, grants: [] },
  );
  const tell = automation("id: t\nname: T\nwhen: record-added\ndo: [{post: 'Hi {record.Status}', group: Trip}]");

  it("posts the text the evaluator rendered, and refuses a message with no text", () => {
    const ctx = context(tell, { chat: directory, key: { claimId: "atc_1", hash: "h" } });
    expect(formulasOf(stepRequest(ctx, entryAt(tell, 0), inputsOf()))).toEqual([{
      kind: "text", parts: [{ kind: "text", text: "Hi " }, { kind: "expression", expression: "record.Status" }],
    }]);
    expect(planAt(ctx, 0, inputsOf(), ok("Hi Done  \r\n"))).toMatchObject({ step: { ordinal: 0, effects: [{
      kind: "message", effectId: "atc_1/h/0/post", to: { kind: "group", channelId: "trip", lane: "posts" }, body: "Hi Done",
    }] } });
    expect(planAt(ctx, 0, inputsOf(), ok(" \n"))).toEqual({ problem: "The message in step 1 is empty." });
    expect(planAt(ctx, 0, inputsOf(), ok(5))).toEqual({ problem: "The message in step 1 is not text." });
  });

  it("refuses to post in a Group this computer may only read", () => {
    const readOnly = chatDirectoryOf(
      [{ id: "trip", name: "Trip", slug: "trip", kind: "channel", type: "both", wireId: "trip", runningThreadId: null, readOnly: true }],
      { kind: "owner", ownerUserId: null, grants: [] },
    );
    const ctx = context(tell, { chat: readOnly, key: { claimId: "atc_1", hash: "h" } });
    expect(planAt(ctx, 0, inputsOf(), ok("Hi Done"))).toEqual({
      problem: "This computer can only read this Group, so an automation cannot post in it.",
    });
  });
});

describe("code steps", () => {
  it("runs code alone in its step, and gives later steps the value it returned", async () => {
    const definition = automation("id: total\nname: Total\nwhen: record-added\ndo:\n  - run: 'return { output: ctx.record.Count * 10 }'\n    as: total");
    const ctx = context(definition);
    const request = stepRequest(ctx, entryAt(definition, 0), inputsOf());
    expect(request.slots.map((slot) => slot.kind)).toEqual(["code"]);
    const shared = createAutomationFormulaEvaluator();
    try {
      // The run's one budget carries earlier steps' time and adds this step's,
      // which a short step on a coarse clock may measure as 0 ms.
      const spent = { prepareMs: 0, runMs: 5 };
      const results = await evaluateRequest(shared.forWorkspace("trip"), "collection:Tasks#total", request, spent);
      expect(results).toEqual(ok({ output: 20 }));
      expect(spent.runMs).toBeGreaterThanOrEqual(5);
      expect(planAt(ctx, 0, inputsOf(), results as AutomationOutcome<JsonValue>[])).toEqual({ step: { ordinal: 0, effects: [], output: { kind: "code", value: 20 } } });
    } finally { await shared.close(); }
  });

  it("fails a step whose code fails, and marks a timeout", async () => {
    const failing: AutomationFormulaEvaluator = {
      evaluate: async () => { throw new Error("A code step asks no formulas."); },
      runCode: async () => ({ ok: false, error: { code: "timeout", message: "The code ran longer than 1000 ms, so it stopped." } }),
    };
    const definition = automation("id: c\nname: C\nwhen: record-added\ndo: [{run: 'return {}'}]");
    const ctx = context(definition);
    const request = stepRequest(ctx, entryAt(definition, 0), inputsOf());
    const results = await evaluateRequest(failing, "a", request, { prepareMs: 0, runMs: 0 });
    expect(results).toHaveLength(1);
    expect(planAt(ctx, 0, inputsOf(), results as AutomationOutcome<JsonValue>[]))
      .toEqual({ error: "The code in step 1 failed. The code ran longer than 1000 ms, so it stopped.", timedOut: true });
  });

  it("turns the changes code returns into Set fields and Add record effects, one write per record", () => {
    const definition = automation("id: c\nname: C\nwhen: record-added\ndo: [{run: 'return {}'}]");
    const other = { id: "rec_other", path: "Tasks/other.md", values: { Count: 7 } };
    const answer: JsonValue = {
      set: { Count: 3 },
      records: [
        { action: "add", collection: "Log", fields: { Title: "One" } },
        { action: "change", collection: "Tasks", id: "rec_other", fields: { Count: 8 } },
        { action: "change", collection: "Tasks", id: "rec_task", fields: { Note: "same record" } },
        { action: "add", collection: "Log", fields: { Title: "Two" } },
      ],
    };
    const ctx = context(definition, { key: { claimId: "atc_1", hash: "h" } });
    const planned = planAt(ctx, 0, inputsOf(), ok(answer), { codeRecords: new Map([
      [codeRecordKey("Tasks", "rec_other"), other],
      [codeRecordKey("Tasks", "rec_task"), task],
    ]) });
    const added = (index: number) => {
      const recordId = derivedRecordId(`atc_1/h/0/${index}`);
      return { recordId, name: `c-${recordId.slice(4, 12)}` };
    };
    expect(planned).toEqual({ step: { ordinal: 0, effects: [
      { kind: "set", target: { recordId: "rec_task", collectionPath: "Tasks", path: "Tasks/one.md" }, fields: [
        { field: "Count", before: 2, after: 3 }, { field: "Note", before: null, after: "same record" },
      ] },
      { kind: "add", collectionPath: "Log", ...added(1), fields: [{ field: "Title", value: "One" }] },
      { kind: "set", target: { recordId: "rec_other", collectionPath: "Tasks", path: "Tasks/other.md" }, fields: [{ field: "Count", before: 7, after: 8 }] },
      { kind: "add", collectionPath: "Log", ...added(4), fields: [{ field: "Title", value: "Two" }] },
    ] } });
  });

  it("fails a step whose code changes a record it cannot find, sets fields with no record, or breaks the contract", () => {
    const definition = automation("id: c\nname: C\nwhen: record-added\ndo: [{set: {Seen: true}}, {run: 'return {}'}]");
    const plan = (answer: JsonValue) => planAt(context(definition), 1, inputsOf(), ok(answer));
    expect(plan({ records: [{ action: "change", collection: "Tasks", id: "rec_gone", fields: { Count: 1 } }] }))
      .toEqual({ problem: "The code in step 2 changes record rec_gone, which is not in Tasks." });
    const scheduled = automation("id: c\nname: C\nwhen: {schedule: day, timezone: UTC}\ndo: [{run: 'return {}'}]");
    expect(planAt(context(scheduled), 0, inputsOf(null), ok({ set: { Count: 1 } })))
      .toEqual({ problem: 'The code in step 1 returned "set", but a schedule starts this automation, so it has no record to set fields on. Change records by id in "records" instead.' });
    expect(plan({ set: { id: "rec_new" } })).toEqual({ problem: "The code in step 2 sets id. A record's id cannot change." });
    const many = Array.from({ length: MAX_CODE_RECORD_CHANGES + 1 }, () => ({ action: "add", collection: "Log", fields: {} }));
    expect(plan({ records: many })).toEqual({ problem: expect.stringMatching(/^The code in step 2 changes more than 50 records/) });
  });

  it("reads each code file a step runs once, and counts it among the automation's sources", () => {
    const definition = automation("id: c\nname: C\nwhen: record-added\ndo: [{run-file: scripts/a.js}, {run-file: scripts/a.js, as: again}, {run: 'return {}'}]");
    expect(codeFilesOf(definition, "Trip/Tasks")).toEqual(["Trip/Tasks/scripts/a.js"]);
    const ctx = context(definition);
    expect([0, 1, 2].map((ordinal) => stepRequest(ctx, entryAt(definition, ordinal), inputsOf(), "return { output: 1 }").items)).toEqual([
      [{ kind: "code", source: "return { output: 1 }" }], [{ kind: "code", source: "return { output: 1 }" }], [{ kind: "code", source: "return {}" }],
    ]);
  });
});
