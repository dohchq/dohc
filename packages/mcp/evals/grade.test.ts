import { describe, expect, it } from "vitest";
import type { Expectation, RunRecord } from "./case";
import { casePasses, grade, matchesArgs } from "./grade";

const run: RunRecord = {
  calls: [
    { tool: "dohc_read_document", args: { path: "notes/plan.md" }, ok: true },
    { tool: "dohc_edit_document", args: { path: "notes/plan.md", find: "Tuesday", replacement: "Thursday" }, ok: false },
    { tool: "dohc_edit_document", args: { path: "notes/plan.md", find: "on Tuesday", replacement: "on Thursday" }, ok: true },
  ],
  text: "I moved the launch to Thursday in notes/plan.md.",
  files: { "notes/plan.md": "# Plan\n\nWe launch on Thursday.\n" },
};

function failures(expectation: Expectation): string[] {
  return grade(expectation, run).filter((check) => !check.pass).map((check) => check.name);
}

describe("eval grading", () => {
  it("passes a run that meets every kind of expectation", () => {
    expect(failures({
      calls: [
        { tool: "dohc_edit_document", args: { path: "notes/plan.md", replacement: "~thursday" }, ok: true },
        { tool: "dohc_edit_document", ok: false },
      ],
      notCalls: ["Write", { tool: "dohc_edit_document", args: { path: "todo.txt" } }],
      order: ["dohc_read_document", "dohc_edit_document"],
      maxCalls: { dohc_edit_document: 2 },
      text: ["thursday"],
      notText: ["could not"],
      files: { "notes/plan.md": { contains: ["Thursday"], lacks: ["Tuesday"], times: { Thursday: 1, Friday: 0 } }, "notes/plan (copy).md": { absent: true } },
    })).toEqual([]);
  });

  it("fails each expectation the run does not meet, and only that one", () => {
    expect(failures({ calls: [{ tool: "dohc_create_document" }] })).toEqual(["calls dohc_create_document"]);
    expect(failures({ calls: [{ tool: "dohc_read_document", ok: false }] })).toEqual(["calls dohc_read_document that was refused"]);
    expect(failures({ calls: [{ tool: "dohc_edit_document", args: { path: "todo.txt" } }] }))
      .toEqual(['calls dohc_edit_document {"path":"todo.txt"}']);
    expect(failures({ notCalls: ["dohc_read_document"] })).toEqual(["does not call dohc_read_document"]);
    expect(failures({ notCalls: ["dohc_*"] })).toEqual(["does not call dohc_*"]);
    expect(failures({ notCalls: ["Edit*", { tool: "dohc_*", args: { requestId: "*" } }] })).toEqual([]);
    expect(failures({ notCalls: [{ tool: "dohc_edit_document", args: { find: "*" } }] }))
      .toEqual(['does not call dohc_edit_document {"find":"*"}']);
    expect(failures({ notCalls: [{ tool: "dohc_edit_document", ok: false }] })).toEqual(["does not call dohc_edit_document that was refused"]);
    expect(failures({ order: ["dohc_edit_document", "dohc_read_document"] })).toEqual(["calls in order dohc_edit_document, dohc_read_document"]);
    expect(failures({ maxCalls: { dohc_edit_document: 1 } })).toEqual(["calls dohc_edit_document at most 1 times"]);
    expect(failures({ text: ["friday"] })).toEqual(["answer matches /friday/"]);
    expect(failures({ notText: ["thursday"] })).toEqual(["answer does not match /thursday/"]);
    expect(failures({ files: { "notes/plan.md": { contains: ["Friday"] } } })).toEqual(['notes/plan.md contains "Friday"']);
    expect(failures({ files: { "notes/plan.md": { lacks: ["Thursday"] } } })).toEqual(['notes/plan.md lacks "Thursday"']);
    expect(failures({ files: { "notes/plan.md": { absent: true } } })).toEqual(["notes/plan.md does not exist"]);
    expect(failures({ files: { "notes/plan.md": { times: { Thursday: 2 } } } })).toEqual(['notes/plan.md has "Thursday" 2 times']);
    expect(failures({ files: { "gone.md": { times: { x: 0 } } } })).toEqual(['gone.md has "x" 0 times']);
    // A file that is missing meets neither `contains` nor `lacks`: the run did not leave it to check.
    expect(failures({ files: { "gone.md": { lacks: ["x"] } } })).toEqual(['gone.md lacks "x"']);
  });

  it("matches arguments by dotted path, missing key, and text contained in any case", () => {
    const args = { path: "Notes/Plan.md", work: { status: "done" }, limit: 5 };
    expect(matchesArgs(args, { "work.status": "done", path: "~plan.md", requestId: null, limit: 5 })).toBe(true);
    expect(matchesArgs(args, { "work.status": "working" })).toBe(false);
    expect(matchesArgs(args, { path: null })).toBe(false);
    expect(matchesArgs(args, { work: "*", requestId: "*" })).toBe(false);
    expect(matchesArgs(args, { work: "*", limit: "*" })).toBe(true);
    expect(matchesArgs(args, { limit: "5" })).toBe(false);
    expect(matchesArgs(args, { "work.status.deeper": "done" })).toBe(false);
  });

  it("passes a case only when more than half of its samples pass", () => {
    expect(casePasses([true, true])).toBe(true);
    expect(casePasses([true, false, true])).toBe(true);
    expect(casePasses([true, false])).toBe(false);
    expect(casePasses([])).toBe(false);
  });
});
