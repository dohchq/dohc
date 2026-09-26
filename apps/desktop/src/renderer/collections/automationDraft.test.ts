import { describe, expect, it } from "vitest";
import {
  conditionFormula,
  conditionRows,
  idFor,
  literalFor,
  newAutomation,
  numberValue,
  reachPlaces,
  valueKindOf,
  valueKindsFor,
} from "./automationDraft";
import { automationSentence, sentenceText } from "./automationSentence";

describe("Only if as rows", () => {
  it("writes rows as one expression and reads that expression back as the same rows", () => {
    const rows = [
      { field: "Status", operator: "is" as const, value: "Done" },
      { field: "Finished on", operator: "is-not" as const, value: null },
      { field: "Tags", operator: "contains" as const, value: "urgent" },
      { field: "Points", operator: "is" as const, value: 3 },
    ];
    const expression = conditionFormula(rows);
    expect(expression).toBe(
      'record.Status == "Done" && record["Finished on"] != null && contains(record.Tags, "urgent") && record.Points == 3',
    );
    expect(conditionRows(expression)).toEqual(rows);
  });

  it("keeps any other expression a formula", () => {
    expect(conditionRows('record.Points > 3')).toBeNull();
    expect(conditionRows('record.Status == "Done" || record.Status == "Shipped"')).toBeNull();
    expect(conditionRows('record.Status == "Done" && ')).toBeNull();
    expect(conditionRows("")).toEqual([]);
  });
});

describe("values in the builder", () => {
  it("offers today and now only for dates, and any value only where a trigger can take it", () => {
    expect(valueKindsFor("date", false)).toEqual(["today", "now", "value", "empty", "formula"]);
    expect(valueKindsFor("select", true)).toEqual(["any", "value", "empty", "formula"]);
    expect(valueKindOf({ kind: "formula", expression: " today() " })).toBe("today");
    expect(valueKindOf({ kind: "formula", expression: "dateAdd(today(), 3, \"days\")" })).toBe("formula");
    expect(valueKindOf({ kind: "literal", value: null })).toBe("empty");
    expect(valueKindOf(null)).toBe("any");
  });

  it("keeps a number as typed until the automation is built, and stores the rest as the field's type does", () => {
    expect(literalFor("number", "-")).toEqual({ kind: "literal", value: "-" });
    expect(numberValue("number", "-")).toBeUndefined();
    expect(numberValue("number", "")).toBeUndefined();
    expect(numberValue("number", "-12.5")).toBe(-12.5);
    expect(numberValue("text", "12")).toBe("12");
    expect(literalFor("checkbox", "true")).toEqual({ kind: "literal", value: true });
    expect(literalFor("multi-select", "a, b ,")).toEqual({ kind: "literal", value: ["a", "b"] });
    expect(literalFor("text", "Done")).toEqual({ kind: "literal", value: "Done" });
  });
});

describe("a new automation", () => {
  it("starts a few choices away from the finish-date example", () => {
    const automation = newAutomation([
      { name: "Title", type: "text" },
      { name: "Status", type: "select", options: ["Doing", "Done"] },
      { name: "Finished on", type: "date" },
    ]);
    expect(sentenceText(automationSentence(automation))).toBe("When Status changes, set Finished on to today");
  });

  it("takes an id from its name that no other automation has", () => {
    expect(idFor("Stamp the finish date!", new Set())).toBe("stamp-the-finish-date");
    expect(idFor("Stamp the finish date", new Set(["stamp-the-finish-date"]))).toBe("stamp-the-finish-date-2");
    expect(idFor("✨", new Set())).toBe("automation");
    expect(idFor("x".repeat(80), new Set()).length).toBe(64);
  });
});

describe("each step's reach verdicts", () => {
  it("counts the steps that change or find records, an If's steps inside it", () => {
    const set = { kind: "set" as const, values: [], records: null, operation: null };
    const find = { kind: "find" as const, condition: "true", collection: null, as: "all", operation: null };
    expect(reachPlaces([
      set,
      { kind: "if", if: "true", do: [find, set], otherwise: [set] },
      { kind: "notify", text: "Hi", to: [] },
      find,
    ])).toEqual([[0], [1, 2, 3], [], [4]]);
  });
});

it("keeps chat recipients and nested record steps at their runtime reach indices", () => {
  const set = { kind: "set" as const, values: [], records: null, operation: null };
  expect(reachPlaces([
    { kind: "post", text: "Hi", group: "Trip" },
    { kind: "if", if: "true", do: [{ kind: "direct-message", text: "Hi", to: [
      { kind: "literal", value: "ana" }, { kind: "formula", expression: "Owner" },
      { kind: "literal", value: "ana" },
    ] }, set], otherwise: [set] },
    set,
  ])).toEqual([[0], [1, 2, 3, 4], [5]]);
});

it("counts named notice recipients before a record edit", () => {
  expect(reachPlaces([
    { kind: "notify", text: "Hi", to: [{ kind: "literal", value: "ana" }, { kind: "formula", expression: "Owner" }] },
    { kind: "set", values: [], records: null, operation: null },
  ])).toEqual([[0], [1]]);
});

it("counts an agent wake before a record edit", () => {
  expect(reachPlaces([
    { kind: "wake-agent", text: "Hi", person: "owner" },
    { kind: "set", values: [], records: null, operation: null },
  ])).toEqual([[0], [1]]);
});

it("leaves the Group trigger verdict before its step verdicts", () => {
  expect(reachPlaces([
    { kind: "post", text: "Hi", group: "Trip" },
    { kind: "set", values: [], records: null, operation: null },
  ], 1)).toEqual([[1], [2]]);
});
