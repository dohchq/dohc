import { describe, expect, it } from "vitest";
import { automationSentence, sentenceText, type Automation } from "./automationSentence";

const automation = (overrides: Partial<Automation>): Automation => ({
  id: "stamp",
  name: "Stamp the finish date",
  enabled: true,
  when: { kind: "field-changed", field: "Status", to: { kind: "literal", value: "Done" }, table: null },
  if: null,
  do: [{ kind: "set", values: [{ field: "Finished on", value: { kind: "formula", expression: "today()" } }], records: null, operation: null }],
  ...overrides,
});

describe("an automation in plain words", () => {
  it("reads the Notion-style example as a sentence", () => {
    expect(sentenceText(automationSentence(automation({})))).toBe(
      "When Status becomes Done, set Finished on to today",
    );
  });

  it("shows formulas as code and counts the steps it does not list", () => {
    const parts = automationSentence(automation({
      when: { kind: "record-added", table: null },
      if: 'record.Priority == "High"',
      do: [
        { kind: "set", values: [{ field: "Due", value: { kind: "formula", expression: 'dateAdd(today(), 3, "days")' } }], records: null, operation: null },
        { kind: "add-record", values: [], collection: "Projects/Log", as: null, operation: null },
        { kind: "set", values: [{ field: "Owner", value: { kind: "literal", value: null } }], records: null, operation: null },
      ],
    }));
    expect(sentenceText(parts)).toBe(
      'When a record is added, only if record.Priority == "High", set Due to dateAdd(today(), 3, "days"), then add a record to Log, and 1 more step',
    );
    expect(parts.filter((part) => part.kind === "code").map((part) => part.text)).toEqual([
      'record.Priority == "High"',
      'dateAdd(today(), 3, "days")',
    ]);
  });

  it("names a cleared field and a change to any of several fields", () => {
    expect(sentenceText(automationSentence(automation({
      when: { kind: "record-changed", fields: ["Status", "Owner", "Due"], table: null },
      do: [{ kind: "set", values: [{ field: "Done on", value: { kind: "literal", value: null } }], records: null, operation: null }],
    })))).toBe("When Status, Owner or Due changes, clear Done on");
    // The builder names no field until someone ticks one.
    expect(sentenceText(automationSentence(automation({ when: { kind: "record-changed", fields: [], table: null } }))))
      .toBe("When a chosen field changes, set Finished on to today");
  });

  it("names the action a button runs", () => {
    expect(sentenceText(automationSentence(automation({
      when: { kind: "button", field: "Mark paid", table: "Invoices" },
      do: [{ kind: "invoke", operation: "invoices.markPaid", input: [{ key: "id", value: { kind: "formula", expression: "record.id" } }] }],
    })))).toBe("When someone clicks Mark paid, run invoices.markPaid");
  });
});
