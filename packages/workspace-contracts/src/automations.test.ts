import { describe, expect, it } from "vitest";
import {
  AUTOMATION_DIAGNOSTIC_CODES,
  MAX_AUTOMATION_ID_LENGTH,
  MAX_AUTOMATION_NAME_LENGTH,
  MAX_AUTOMATION_STEPS,
  MAX_AUTOMATION_TEXT_LENGTH,
  MAX_AUTOMATIONS,
  MAX_AUTOMATIONS_FILE_BYTES,
  MAX_EXPRESSION_LENGTH,
  MAX_IF_DEPTH,
  MAX_INLINE_CODE_LENGTH,
  MAX_REFERENCE_LENGTH,
  automationTextParts,
  parseAutomationsFile,
  writeAutomationsFile,
  type Automation,
  type AutomationDiagnostic,
  type AutomationDiagnosticCode,
  type AutomationEntry,
} from "./automations";

function dedent(text: string): string {
  const lines = text.replace(/^\n/u, "").trimEnd().split("\n");
  const margin = Math.min(
    ...lines.filter((line) => line.trim().length > 0).map((line) => /^ */u.exec(line)![0].length),
  );
  return lines.map((line) => line.slice(margin)).join("\n");
}

function automationsFile(...items: string[]): string {
  const list = items.map((item) =>
    dedent(item)
      .split("\n")
      .map((line, index) => `${index === 0 ? "  - " : "    "}${line}`)
      .join("\n"),
  );
  return `version: 1\nautomations:\n${list.join("\n")}\n`;
}

function withStep(step: string, when = "record-added"): string {
  const stepLines = dedent(step)
    .split("\n")
    .map((line, index) => `${index === 0 ? "  - " : "    "}${line}`)
    .join("\n");
  return `id: a\nname: A\nwhen: ${when}\ndo:\n${stepLines}`;
}

function entries(text: string): AutomationEntry[] {
  const result = parseAutomationsFile(text);
  if (result.status !== "read") throw new Error(`unreadable: ${JSON.stringify(result.diagnostic)}`);
  return result.entries;
}

function diagnosticsOf(item: string): AutomationDiagnostic[] {
  const [entry] = entries(automationsFile(item));
  return entry?.status === "invalid" ? entry.diagnostics : [];
}

function validAutomations(text: string): Automation[] {
  return entries(text).map((entry) => {
    if (entry.status !== "valid") throw new Error(JSON.stringify(entry.diagnostics));
    return entry.automation;
  });
}

// Rebuilds every object with its keys in reverse order, so the writer is
// checked against models built in any property order.
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    ) as T;
  }
  return value;
}

// Every trigger and step kind, in the writer's own form.
const EVERY_KIND = `version: 1
automations:
  - id: stamp-finish-date
    name: Stamp the finish date
    when:
      field-changed: Status
      to: Done
    do:
      - set:
          Finished on: '=today()'

  - id: welcome
    name: Welcome new sign-ups
    when: record-added
    do:
      - notify: New sign-up {record.Name}
        to:
          - '=record.Owner'
          - user_ana

  - id: review-changes
    name: Review changed estimates
    when:
      record-changed:
        - Estimate
        - Due
    if: record.Estimate > 8
    do:
      - direct-message: '{record.Name} grew to {record.Estimate} hours'
        to:
          - '=record.Owner'

  - id: archive
    name: Log removed tasks
    when: record-removed
    do:
      - add-record:
          Task: '=record.Name'
          Removed on: '=today()'
        collection: Archive/Removed tasks
        as: logged

  - id: late
    name: Flag late tasks
    when:
      starts-matching: record.Due < today() && record.Status != "Done"
    do:
      - set:
          Late: true

  - id: standup
    name: Weekday stand-up
    enabled: false
    when:
      schedule: weekday
      at: '09:00'
      timezone: Europe/London
    do:
      - find: record.Status == "Doing"
        as: doing
      - if: doing.length > 0
        do:
          - set:
              Nudged: true
            records: doing
          - post: '{doing.length} tasks in progress'
            group: Team
        otherwise:
          - post: Nothing in progress
            group: Team

  - id: monthly-invoice
    name: Monthly invoice
    when:
      schedule: month
      at: '08:30'
      days:
        - 1
        - 15
      timezone: America/New_York
    do:
      - add-record:
          Name: Invoice
          Amount: 100
          Sent: false
          Notes: null

  - id: mark-paid
    name: Mark paid
    when:
      button: Mark paid
    do:
      - set:
          Paid: true
          Paid on: '=today()'
      - run: |
          return { total: record.Amount * 2 };
        as: totals

  - id: task-from-chat
    name: Tasks from chat
    when:
      group-message: Trip
      starts-with: /task
    do:
      - add-record:
          Name: '=message.text.slice(6)'
      - wake-agent: Plan {message.text}
        person: user_ana
      - run-file: scripts/summarize.js
`;

describe("automations.yaml round trip", () => {
  it("reads every trigger and step kind and writes the same text back", () => {
    const parsed = entries(EVERY_KIND);
    expect(parsed.map((entry) => entry.status)).toEqual(parsed.map(() => "valid"));
    expect(writeAutomationsFile(parsed)).toBe(EVERY_KIND);
  });

  it("reads the model each kind describes", () => {
    const [stamp, welcome, review, archive, late, standup, invoice, markPaid, chat] =
      validAutomations(EVERY_KIND);
    expect(stamp).toEqual({
      id: "stamp-finish-date",
      name: "Stamp the finish date",
      enabled: true,
      when: { kind: "field-changed", field: "Status", to: { kind: "literal", value: "Done" } },
      if: null,
      do: [
        {
          kind: "set",
          values: [{ field: "Finished on", value: { kind: "formula", expression: "today()" } }],
          records: null,
        },
      ],
    });
    expect(welcome?.when).toEqual({ kind: "record-added" });
    expect(welcome?.do[0]).toEqual({
      kind: "notify",
      text: "New sign-up {record.Name}",
      to: [
        { kind: "formula", expression: "record.Owner" },
        { kind: "literal", value: "user_ana" },
      ],
    });
    expect(review?.when).toEqual({ kind: "record-changed", fields: ["Estimate", "Due"] });
    expect(review?.if).toBe("record.Estimate > 8");
    expect(archive?.when).toEqual({ kind: "record-removed" });
    expect(archive?.do[0]).toMatchObject({ collection: "Archive/Removed tasks", as: "logged" });
    expect(late?.when).toEqual({
      kind: "starts-matching",
      condition: 'record.Due < today() && record.Status != "Done"',
    });
    expect(standup?.enabled).toBe(false);
    expect(standup?.do[1]).toMatchObject({ kind: "if", if: "doing.length > 0" });
    expect(invoice?.when).toEqual({
      kind: "schedule",
      every: "month",
      at: "08:30",
      days: [1, 15],
      timezone: "America/New_York",
    });
    expect(invoice?.do[0]).toMatchObject({
      values: [
        { field: "Name", value: { kind: "literal", value: "Invoice" } },
        { field: "Amount", value: { kind: "literal", value: 100 } },
        { field: "Sent", value: { kind: "literal", value: false } },
        { field: "Notes", value: { kind: "literal", value: null } },
      ],
    });
    expect(markPaid?.when).toEqual({ kind: "button", field: "Mark paid" });
    expect(markPaid?.do[1]).toEqual({
      kind: "run",
      code: "return { total: record.Amount * 2 };\n",
      as: "totals",
    });
    expect(chat?.when).toEqual({ kind: "group-message", group: "Trip", startsWith: "/task" });
    expect(chat?.do.slice(1)).toEqual([
      { kind: "wake-agent", text: "Plan {message.text}", person: "user_ana" },
      { kind: "run-file", file: "scripts/summarize.js", as: null },
    ]);
  });

  it("writes the same text whatever order the model's keys are in", () => {
    const shuffled = entries(EVERY_KIND).map(reverseKeys);
    expect(writeAutomationsFile(shuffled)).toBe(EVERY_KIND);
  });

  it("changes only the lines of the automation that changed", () => {
    const parsed = entries(EVERY_KIND);
    const [first] = parsed;
    if (first?.status !== "valid") throw new Error("expected a valid automation");
    const edited = [{ ...first, automation: { ...first.automation, enabled: false } }, ...parsed.slice(1)];
    const before = writeAutomationsFile(parsed).split("\n\n");
    const after = writeAutomationsFile(edited).split("\n\n");
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(after[0]).toContain("    enabled: false\n");
  });

  it("writes a hand-edited file in the writer's form", () => {
    const text = automationsFile(`
      id: a
      name: A
      when: {schedule: week, days: [fri, mon], timezone: UTC}
      do: [{add-record: {"2024": 1, "__proto__": x}}]
    `);
    expect(writeAutomationsFile(entries(text))).toBe(`version: 1
automations:
  - id: a
    name: A
    when:
      schedule: week
      at: '00:00'
      days:
        - mon
        - fri
      timezone: UTC
    do:
      - add-record:
          '2024': 1
          __proto__: x
`);
  });

  it("keeps an invalid automation when it writes the others", () => {
    const text = automationsFile(
      `
      id: broken
      name: Broken
      when: record-added
      colour: blue
      do: [{set: {Done: true}}]
      `,
      "id: fine\nname: Fine\nwhen: record-added\ndo: [{set: {Done: true}}]",
    );
    const parsed = entries(text);
    expect(parsed[0]).toMatchObject({ status: "invalid", id: "broken", name: "Broken" });
    const written = writeAutomationsFile(parsed);
    expect(written).toContain("    colour: blue\n");
    const reread = entries(written);
    expect(reread).toEqual(parsed);
    expect(writeAutomationsFile(reread)).toBe(written);
  });

  it("writes an empty list", () => {
    const text = writeAutomationsFile([]);
    expect(text).toBe("version: 1\nautomations: []\n");
    expect(entries(text)).toEqual([]);
  });

  it("reads a file with no automations", () => {
    for (const text of ["", "# nothing yet\n", "---\n", "version: 1\n", "version: 1\nautomations:\n"]) {
      expect(entries(text)).toEqual([]);
    }
  });
});

describe("values, conditions, and templates", () => {
  it("reads text that starts with = as a formula, however the YAML quotes it", () => {
    const [automation] = validAutomations(
      automationsFile(withStep(`set: {A: =x, B: "=y", C: '= z ', D: x, E: 1.5, F: true, G: null, H: ""}`)),
    );
    expect(automation?.do[0]).toMatchObject({
      values: [
        { field: "A", value: { kind: "formula", expression: "x" } },
        { field: "B", value: { kind: "formula", expression: "y" } },
        { field: "C", value: { kind: "formula", expression: " z " } },
        { field: "D", value: { kind: "literal", value: "x" } },
        { field: "E", value: { kind: "literal", value: 1.5 } },
        { field: "F", value: { kind: "literal", value: true } },
        { field: "G", value: { kind: "literal", value: null } },
        { field: "H", value: { kind: "literal", value: "" } },
      ],
    });
  });

  it("writes literal text that starts with = as a formula that returns it", () => {
    const automation: Automation = {
      id: "a",
      name: "A",
      enabled: true,
      when: { kind: "field-changed", field: "Code", to: { kind: "literal", value: "=5" } },
      if: null,
      do: [{ kind: "set", values: [{ field: "Code", value: { kind: "literal", value: "=5" } }], records: null }],
    };
    const text = writeAutomationsFile([{ status: "valid", automation }]);
    expect(text).toContain(`Code: '="=5"'`);
    const [reread] = validAutomations(text);
    expect(reread?.when).toEqual({
      kind: "field-changed",
      field: "Code",
      to: { kind: "formula", expression: '"=5"' },
    });
  });

  it("tells a cleared field from any change", () => {
    const text = automationsFile(
      "id: a\nname: A\nwhen: {field-changed: Due, to: null}\ndo: [{set: {X: 1}}]",
      "id: b\nname: B\nwhen: {field-changed: Due}\ndo: [{set: {X: 1}}]",
    );
    const [cleared, anyChange] = validAutomations(text);
    expect(cleared?.when).toMatchObject({ to: { kind: "literal", value: null } });
    expect(anyChange?.when).toMatchObject({ to: null });
    expect(validAutomations(writeAutomationsFile(entries(text)))).toEqual([cleared, anyChange]);
  });

  it("splits message templates into text and expressions", () => {
    expect(automationTextParts("Hi {record.Name}, {{literal}} }} done")).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "expression", expression: "record.Name" },
      { kind: "text", text: ", {literal} } done" },
    ]);
    expect(automationTextParts("{ ({a: 1}).a }")).toEqual([
      { kind: "expression", expression: " ({a: 1}).a " },
    ]);
    for (const broken of ["{unclosed", "stray }", "{}", "{  }", "{a}}"]) {
      expect(automationTextParts(broken)).toBeNull();
    }
  });

  it("quotes clock times so YAML 1.1 readers keep them as text", () => {
    const text = writeAutomationsFile(
      entries(automationsFile("id: a\nname: A\nwhen: {schedule: day, at: '12:30', timezone: UTC}\ndo: [{post: Hi, group: Team}]")),
    );
    expect(text).toContain("at: '12:30'\n");
  });
});

interface FileCase {
  name: string;
  text: string;
  expected: AutomationDiagnostic;
}

const FILE_CASES: FileCase[] = [
  {
    name: "broken YAML, with its line",
    text: "version: 1\nautomations:\n  - id: a\n   name: A\n",
    expected: { code: "invalid-yaml", path: "", line: 4 },
  },
  {
    name: "a duplicate key, which YAML forbids",
    text: "version: 1\nversion: 1\n",
    expected: { code: "invalid-yaml", path: "", line: 2 },
  },
  {
    name: "an alias",
    text: "version: 1\nautomations:\n  - &a {id: a}\n  - *a\n",
    expected: { code: "invalid-yaml", path: "", line: 4 },
  },
  {
    name: "a file over the size bound",
    text: `version: 1\n# ${"x".repeat(MAX_AUTOMATIONS_FILE_BYTES)}\n`,
    expected: { code: "file-too-large", path: "" },
  },
  { name: "a list at the root", text: "- a\n", expected: { code: "root-not-mapping", path: "" } },
  {
    name: "no version",
    text: "automations: []\n",
    expected: { code: "unsupported-version", path: "/version" },
  },
  {
    name: "a newer version",
    text: "version: 2\nautomations: []\n",
    expected: { code: "unsupported-version", path: "/version" },
  },
  {
    name: "an unknown top-level key",
    text: "version: 1\nautomation: []\n",
    expected: { code: "unknown-property", path: "/automation" },
  },
  {
    name: "automations that are not a list",
    text: "version: 1\nautomations: {}\n",
    expected: { code: "expected-sequence", path: "/automations" },
  },
];

interface AutomationCase {
  name: string;
  item: string;
  expected: AutomationDiagnostic[];
}

const at = (path: string) => `/automations/0${path}`;

const AUTOMATION_CASES: AutomationCase[] = [
  {
    name: "an unknown key",
    item: "id: a\nname: A\ncolour: blue\nwhen: record-added\ndo: [{set: {X: 1}}]",
    expected: [{ code: "unknown-property", path: at("/colour") }],
  },
  {
    name: "a missing name",
    item: "id: a\nwhen: record-added\ndo: [{set: {X: 1}}]",
    expected: [{ code: "missing-property", path: at("/name") }],
  },
  { name: "an entry that is not a mapping", item: "just text", expected: [{ code: "expected-mapping", path: at("") }] },
  {
    name: "steps that are not a list",
    item: "id: a\nname: A\nwhen: record-added\ndo: {set: {X: 1}}",
    expected: [{ code: "expected-sequence", path: at("/do") }],
  },
  {
    name: "a name that is not text",
    item: "id: a\nname: 5\nwhen: record-added\ndo: [{set: {X: 1}}]",
    expected: [{ code: "expected-text", path: at("/name") }],
  },
  {
    name: "enabled that is not a boolean",
    item: "id: a\nname: A\nenabled: yes\nwhen: record-added\ndo: [{set: {X: 1}}]",
    expected: [{ code: "expected-boolean", path: at("/enabled") }],
  },
  {
    name: "enabled with no value",
    item: "id: a\nname: A\nenabled:\nwhen: record-added\ndo: [{set: {X: 1}}]",
    expected: [{ code: "expected-boolean", path: at("/enabled") }],
  },
  {
    name: "a list as a value",
    item: withStep("set: {X: [1, 2]}"),
    expected: [{ code: "expected-scalar", path: at("/do/0/set/X") }],
  },
  {
    name: "an argument to record-added",
    item: "id: a\nname: A\nwhen: {record-added: 1}\ndo: [{set: {X: 1}}]",
    expected: [{ code: "expected-empty", path: at("/when/record-added") }],
  },
  {
    name: "no steps",
    item: "id: a\nname: A\nwhen: record-added\ndo: []",
    expected: [{ code: "empty-value", path: at("/do") }],
  },
  {
    name: "a name over the bound",
    item: `id: a\nname: ${"n".repeat(MAX_AUTOMATION_NAME_LENGTH + 1)}\nwhen: record-added\ndo: [{set: {X: 1}}]`,
    expected: [{ code: "too-long", path: at("/name") }],
  },
  {
    name: "an id over the bound",
    item: `id: ${"a".repeat(MAX_AUTOMATION_ID_LENGTH + 1)}\nname: A\nwhen: record-added\ndo: [{set: {X: 1}}]`,
    expected: [{ code: "too-long", path: at("/id") }],
  },
  {
    name: "a field name over the bound",
    item: `id: a\nname: A\nwhen: {button: ${"f".repeat(MAX_REFERENCE_LENGTH + 1)}}\ndo: [{set: {X: 1}}]`,
    expected: [{ code: "too-long", path: at("/when/button") }],
  },
  {
    name: "message text over the bound",
    item: withStep(`notify: ${"t".repeat(MAX_AUTOMATION_TEXT_LENGTH + 1)}\nto: [user_ana]`),
    expected: [{ code: "too-long", path: at("/do/0/notify") }],
  },
  {
    name: "a formula over the bound",
    item: withStep(`set: {X: "=${"1".repeat(MAX_EXPRESSION_LENGTH + 1)}"}`),
    expected: [{ code: "too-long", path: at("/do/0/set/X") }],
  },
  {
    name: "inline code over the bound",
    item: withStep(`run: "${"x".repeat(MAX_INLINE_CODE_LENGTH + 1)}"`),
    expected: [{ code: "too-long", path: at("/do/0/run") }],
  },
  {
    name: "a field listed twice",
    item: "id: a\nname: A\nwhen: {record-changed: [Due, Due]}\ndo: [{set: {X: 1}}]",
    expected: [{ code: "duplicate-value", path: at("/when/record-changed/1") }],
  },
  {
    name: "a name with a control character",
    item: 'id: a\nname: "Pay\\u202Edone"\nwhen: record-added\ndo: [{set: {X: 1}}]',
    expected: [{ code: "control-characters", path: at("/name") }],
  },
  {
    name: "an id that is not a slug",
    item: "id: Not A Slug\nname: A\nwhen: record-added\ndo: [{set: {X: 1}}]",
    expected: [{ code: "invalid-id", path: at("/id") }],
  },
  {
    name: "a trigger with no known kind",
    item: "id: a\nname: A\nwhen: {field-change: Status}\ndo: [{set: {X: 1}}]",
    expected: [{ code: "missing-kind", path: at("/when") }],
  },
  {
    name: "a step with two kinds",
    item: withStep("set: {X: 1}\nnotify: Hi"),
    expected: [{ code: "multiple-kinds", path: at("/do/0") }],
  },
  {
    name: "a condition written as a formula",
    item: "id: a\nname: A\nwhen: record-added\nif: =record.Done\ndo: [{set: {X: 1}}]",
    expected: [{ code: "unexpected-formula-marker", path: at("/if") }],
  },
  {
    name: "an infinite number",
    item: withStep("set: {X: .inf}"),
    expected: [{ code: "number-not-finite", path: at("/do/0/set/X") }],
  },
  {
    name: "an unclosed template expression",
    item: withStep('notify: "Hi {record.Name"\nto: [user_ana]'),
    expected: [{ code: "invalid-template", path: at("/do/0/notify") }],
  },
  {
    name: "a code file outside the Collection",
    item: withStep("run-file: ../shared/tally.js"),
    expected: [{ code: "invalid-path", path: at("/do/0/run-file") }],
  },
  {
    name: "a record's id as a field",
    item: withStep("set: {id: rec_x}"),
    expected: [{ code: "reserved-field-name", path: at("/do/0/set/id") }],
  },
  {
    name: "a binding name that formulas cannot use",
    item: withStep("find: 'true'\nas: open-tasks"),
    expected: [{ code: "invalid-binding-name", path: at("/do/0/as") }],
  },
  {
    name: "records that no earlier step found",
    item: withStep("set: {X: 1}\nrecords: open"),
    expected: [{ code: "unknown-binding", path: at("/do/0/records") }],
  },
  {
    name: "a set step without a triggering record",
    item: withStep("set: {X: 1}", "{schedule: day, timezone: UTC}"),
    expected: [{ code: "step-needs-record", path: at("/do/0") }],
  },
  {
    name: "an unknown frequency",
    item: withStep("post: Hi\ngroup: Team", "{schedule: fortnight, timezone: UTC}"),
    expected: [{ code: "invalid-frequency", path: at("/when/schedule") }],
  },
  {
    name: "a time that is not HH:MM",
    item: withStep("post: Hi\ngroup: Team", "{schedule: day, at: 9am, timezone: UTC}"),
    expected: [{ code: "invalid-time", path: at("/when/at") }],
  },
  {
    name: "a day that is not a weekday",
    item: withStep("post: Hi\ngroup: Team", "{schedule: week, days: [monday], timezone: UTC}"),
    expected: [{ code: "invalid-day", path: at("/when/days/0") }],
  },
  {
    name: "an unknown time zone",
    item: withStep("post: Hi\ngroup: Team", "{schedule: day, timezone: Mars/Olympus}"),
    expected: [{ code: "invalid-timezone", path: at("/when/timezone") }],
  },
];

function stepsItem(steps: string[]): string {
  return `id: a\nname: A\nwhen: record-added\ndo: [${steps.join(", ")}]`;
}

// `depth` if steps inside one another, with one set step in the innermost.
function nestedIfs(depth: number): string {
  let steps = "{set: {X: 1}}";
  for (let level = 0; level < depth; level += 1) steps = `{if: "true", do: [${steps}]}`;
  return stepsItem([steps]);
}

const BOUND_CASES: AutomationCase[] = [
  {
    name: "one step over the bound, counting nested steps",
    item: stepsItem([
      `{if: "true", do: [${Array.from({ length: MAX_AUTOMATION_STEPS - 1 }, () => "{set: {X: 1}}").join(", ")}]}`,
      "{set: {X: 1}}",
    ]),
    expected: [{ code: "too-many-steps", path: at("/do/1") }],
  },
  {
    name: "an if step one level too deep",
    item: nestedIfs(MAX_IF_DEPTH + 1),
    expected: [
      { code: "if-too-deep", path: at(`${"/do/0".repeat(MAX_IF_DEPTH + 1)}`) },
    ],
  },
];

describe("automations.yaml diagnostics", () => {
  it.each(FILE_CASES)("turns every automation off for $name", ({ text, expected }) => {
    expect(parseAutomationsFile(text)).toEqual({ status: "unreadable", diagnostic: expected });
  });

  it.each([...AUTOMATION_CASES, ...BOUND_CASES])("turns off one automation for $name", ({ item, expected }) => {
    expect(diagnosticsOf(item)).toEqual(expected);
  });

  it("accepts the bounds themselves", () => {
    expect(diagnosticsOf(stepsItem(Array.from({ length: MAX_AUTOMATION_STEPS }, () => "{set: {X: 1}}")))).toEqual([]);
    expect(diagnosticsOf(nestedIfs(MAX_IF_DEPTH))).toEqual([]);
  });

  it("keeps the other automations when one is invalid", () => {
    const parsed = entries(
      automationsFile(
        "id: a\nname: A\nwhen: record-added\ndo: [{set: {X: 1}}]",
        "id: b\nname: B\nwhen: record-added\nextra: 1\ndo: [{set: {X: 1}}]",
        "id: c\nname: C\nwhen: record-added\ndo: [{set: {X: 1}}]",
      ),
    );
    expect(parsed.map((entry) => entry.status)).toEqual(["valid", "invalid", "valid"]);
    expect(parsed[1]).toEqual({
      status: "invalid",
      id: "b",
      name: "B",
      diagnostics: [{ code: "unknown-property", path: "/automations/1/extra" }],
      raw: expect.any(Map),
    });
  });

  it("turns off a later automation that reuses an id", () => {
    const parsed = entries(
      automationsFile(
        "id: a\nname: First\nwhen: record-added\ndo: [{set: {X: 1}}]",
        "id: a\nname: Copy\nwhen: record-added\ndo: [{set: {X: 1}}]",
      ),
    );
    expect(parsed[0]?.status).toBe("valid");
    expect(parsed[1]).toMatchObject({
      status: "invalid",
      diagnostics: [{ code: "duplicate-value", path: "/automations/1/id" }],
    });
  });

  it("turns off automations past the bound", () => {
    const item = (index: number) => `id: a${index}\nname: A\nwhen: record-added\ndo: [{set: {X: 1}}]`;
    const parsed = entries(
      automationsFile(...Array.from({ length: MAX_AUTOMATIONS + 1 }, (_, index) => item(index))),
    );
    expect(parsed.slice(0, MAX_AUTOMATIONS).every((entry) => entry.status === "valid")).toBe(true);
    expect(parsed[MAX_AUTOMATIONS]).toMatchObject({
      status: "invalid",
      id: `a${MAX_AUTOMATIONS}`,
      diagnostics: [{ code: "too-many-automations", path: `/automations/${MAX_AUTOMATIONS}` }],
    });
  });

  it("scopes a name bound in a branch to that branch", () => {
    expect(
      diagnosticsOf(
        stepsItem([
          `{if: "true", do: [{find: "true", as: open}, {set: {X: 1}, records: open}]}`,
          "{set: {X: 1}, records: open}",
        ]),
      ),
    ).toEqual([{ code: "unknown-binding", path: at("/do/1/records") }]);
  });

  it("changes only records that a find or add-record step bound", () => {
    expect(
      diagnosticsOf(stepsItem(["{run: 'return 1', as: result}", "{set: {X: 1}, records: result}"])),
    ).toEqual([{ code: "unknown-binding", path: at("/do/1/records") }]);
    expect(
      diagnosticsOf(stepsItem(["{find: 'true', as: open}", "{find: 'true', as: open}"])),
    ).toEqual([{ code: "duplicate-value", path: at("/do/1/as") }]);
  });

  it("lets record-less triggers change found records", () => {
    const item = withStep("find: 'true'\nas: open", "{schedule: day, timezone: UTC}").replace(
      "do:\n",
      "do:\n  - set: {X: 1}\n    records: open\n",
    );
    expect(diagnosticsOf(item)).toEqual([{ code: "unknown-binding", path: at("/do/0/records") }]);
    const ordered = `id: a\nname: A\nwhen: {group-message: Team}\ndo: [{find: 'true', as: open}, {set: {X: 1}, records: open}]`;
    expect(diagnosticsOf(ordered)).toEqual([]);
    expect(diagnosticsOf(withStep("set: {X: 1}", "record-removed"))).toEqual([
      { code: "step-needs-record", path: at("/do/0") },
    ]);
  });

  it("checks schedule times and days against the frequency", () => {
    const schedule = (when: string) => diagnosticsOf(withStep("post: Hi\ngroup: Team", when));
    expect(schedule("{schedule: hour, at: ':15', timezone: UTC}")).toEqual([]);
    expect(schedule("{schedule: hour, at: '09:15', timezone: UTC}")).toEqual([
      { code: "invalid-time", path: at("/when/at") },
    ]);
    expect(schedule("{schedule: day, days: [mon], timezone: UTC}")).toEqual([
      { code: "unknown-property", path: at("/when/days") },
    ]);
    expect(schedule("{schedule: month, days: [0, 32], timezone: UTC}")).toEqual([
      { code: "invalid-day", path: at("/when/days/0") },
      { code: "invalid-day", path: at("/when/days/1") },
    ]);
    expect(schedule("{schedule: week}")).toEqual([
      { code: "missing-property", path: at("/when/timezone") },
    ]);
  });

  it("fills in schedule defaults", () => {
    const [weekly, monthly, hourly] = validAutomations(
      automationsFile(
        withStep("post: Hi\ngroup: Team", "{schedule: week, timezone: UTC}"),
        withStep("post: Hi\ngroup: Team", "{schedule: month, timezone: UTC}").replace("id: a", "id: b"),
        withStep("post: Hi\ngroup: Team", "{schedule: hour, timezone: UTC}").replace("id: a", "id: c"),
      ),
    );
    expect(weekly?.when).toEqual({ kind: "schedule", every: "week", at: "00:00", days: ["mon"], timezone: "UTC" });
    expect(monthly?.when).toEqual({ kind: "schedule", every: "month", at: "00:00", days: [1], timezone: "UTC" });
    expect(hourly?.when).toEqual({ kind: "schedule", every: "hour", at: ":00", timezone: "UTC" });
  });

  it("has a case for every diagnostic code", () => {
    const covered = new Set<AutomationDiagnosticCode>([
      ...FILE_CASES.map((testCase) => testCase.expected.code),
      ...[...AUTOMATION_CASES, ...BOUND_CASES].flatMap((testCase) =>
        testCase.expected.map((diagnostic) => diagnostic.code),
      ),
      "too-many-automations",
    ]);
    expect([...AUTOMATION_DIAGNOSTIC_CODES].filter((code) => !covered.has(code))).toEqual([]);
  });
});
