import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_LIMITS, createAutomationEvaluator } from "./automation.ts";
import type { AutomationFormula, AutomationScope, AutomationTextPart, JsonObject, JsonValue } from "./automation.ts";
import { evaluateItem, newQuickJS } from "./automation-evaluate.ts";

const threads = vi.hoisted(() => ({ started: 0, terminated: 0 }));
vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class CountedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) { super(...args); threads.started++; }
    override terminate() { threads.terminated++; return super.terminate(); }
  }
  return { ...actual, Worker: CountedWorker };
});

const scope: AutomationScope = {
  record: { Name: "Ana Lopez", Status: "Done", Tags: ["trip", "urgent"], Price: 12.5, Quantity: 3, Due: "2026-09-30" },
  previous: { Status: "Doing" },
  trigger: { kind: "field-changed", field: "Status" },
  bindings: { total: 37.5, tasks: [{ id: "record-7", Name: "Book hotel" }, { id: "record-8", Name: "Pack" }] },
  person: { id: "person-1", name: "Ana" },
  now: "2026-09-24T09:30:00.000+08:00",
};
const expression = (source: string): AutomationFormula => ({ kind: "expression", source });
const nested = (depth: number): JsonValue => {
  let value: JsonValue = 1;
  for (let level = 0; level < depth; level++) value = [value];
  return value;
};
const tooLarge = { code: "too_large", message: "The record and step results are larger than 256 KiB." };
const tooDeep = { code: "too_large", message: "The record and step results nest lists or objects more than 64 levels deep." };
const evaluator = createAutomationEvaluator();
afterAll(() => evaluator.close());

async function value(source: string, input: AutomationScope = scope) {
  const [result] = await evaluator.evaluate(input, [expression(source)]);
  return result;
}
async function values(sources: string[]) {
  return (await evaluator.evaluate(scope, sources.map(expression))).map(result => result.ok ? result.value : result.error);
}

describe("formula helpers", () => {
  it("reads the run's date and time on the clock of now", async () => {
    expect(await values(["today()", "now()"])).toEqual(["2026-09-24", "2026-09-24T09:30:00.000+08:00"]);
    // 23:30 in New York is already the next day in UTC; today() stays on the automation's clock.
    const evening = { ...scope, now: "2026-09-24T23:30:00-05:00" };
    expect(await value("today()", evening)).toEqual({ ok: true, value: "2026-09-24" });
    expect(await value("now()", { ...scope, now: "2026-09-24T09:30Z" })).toEqual({ ok: true, value: "2026-09-24T09:30:00.000Z" });
  });

  it("adds calendar and clock units to dates", async () => {
    expect(await values([
      'dateAdd(today(), 3, "days")', 'dateAdd("2026-01-31", 1, "month")', 'dateAdd("2024-01-31", 1, "months")',
      'dateAdd("2026-09-24", 2, "weeks")', 'dateAdd("2026-09-24", -1, "years")', 'dateAdd("2026-11-30", 1, "quarter")',
      'dateAdd("2026-09-24", 90, "minutes")', 'dateAdd(now(), 2, "hours")', 'dateAdd("2026-09-24T23:00:00Z", 2, "hours")',
      'dateAdd("2026-09-24T10:00", 1, "day")',
    ])).toEqual([
      "2026-09-27", "2026-02-28", "2024-02-29", "2026-10-08", "2025-09-24", "2027-02-28",
      "2026-09-24T01:30:00.000+08:00", "2026-09-24T11:30:00.000+08:00", "2026-09-25T01:00:00.000Z", "2026-09-25T10:00:00.000+08:00",
    ]);
  });

  it("explains a date it cannot use", async () => {
    expect(await values([
      'dateAdd("2026-09-24", 1.5, "days")', 'dateAdd("2026-09-24", 1, "fortnights")', 'dateAdd("24/09/2026", 1, "days")',
      'dateAdd("2026-02-30", 1, "days")', 'dateAdd("9999-12-31", 1, "day")', 'dateAdd("2026-09-24", 1e20, "days")',
      'dateAdd("2026-09-24", -1e20, "days")', 'dateAdd("2026-09-24", 1e15, "months")', 'dateAdd(now(), -1e300, "hours")',
    ])).toEqual([
      { code: "runtime", message: "TypeError: dateAdd needs a whole number to add, such as 3." },
      { code: "runtime", message: "TypeError: dateAdd needs a unit: years, quarters, months, weeks, days, hours, or minutes." },
      { code: "runtime", message: "TypeError: dateAdd needs a date such as 2026-09-24 or 2026-09-24T09:30:00Z." },
      { code: "runtime", message: "RangeError: dateAdd needs a real date. 2026-02-30 is not one." },
      ...Array.from({ length: 5 }, () => ({ code: "runtime", message: "RangeError: dateAdd went outside the years 0000 to 9999." })),
    ]);
  });

  it("counts whole units between dates", async () => {
    expect(await values([
      'dateBetween("2026-09-30", today(), "days")', 'dateBetween(today(), "2026-09-30", "days")',
      'dateBetween("2026-10-08", "2026-09-24", "weeks")', 'dateBetween("2026-02-28", "2026-01-31", "months")',
      'dateBetween("2026-02-27", "2026-01-31", "months")', 'dateBetween("2027-09-23", "2026-09-24", "years")',
      'dateBetween("2027-09-24", "2026-09-24", "years")', 'dateBetween("2026-12-24", "2026-09-24", "quarters")',
      'dateBetween("2026-09-24T12:00:00Z", "2026-09-24T12:00:00+08:00", "hours")',
      'dateBetween("2026-09-25", "2026-09-24T12:00:00+08:00", "hours")', 'dateBetween(now(), "2026-09-24T09:00:00+08:00", "minutes")',
    ])).toEqual([6, -6, 2, 1, 0, 0, 1, 1, 8, 12, 30]);
  });

  it("formats dates with named parts", async () => {
    expect(await values([
      'formatDate("2026-09-24")', 'formatDate("2026-09-24", "ddd, MMM D YYYY")', 'formatDate(now(), "dddd h:mm A")',
      'formatDate("2026-09-24T21:05:09Z", "HH:mm:ss hh A")', 'formatDate("2026-09-04", "[Due] D/M/YY")', 'formatDate("2026-09-24", 7)',
    ])).toEqual([
      "September 24, 2026", "Thu, Sep 24 2026", "Thursday 9:30 AM", "21:05:09 09 PM", "Due 4/9/26",
      { code: "runtime", message: 'TypeError: formatDate needs a format such as "MMMM D, YYYY".' },
    ]);
  });

  it("changes and inspects text", async () => {
    expect(await values([
      'lower("Ana LOPEZ")', 'upper("ana")', 'trim("  hi  ")', "lower(null)", "upper(42)", "lower({})",
      'contains("Buy tickets", "tick")', 'contains(record.Tags, "urgent")', 'contains(["a"], "c")', 'contains(null, "a")',
      'join(["a", null, "", "b"])', 'join([1, 2], " / ")', "join(null)", 'join("a")',
      'length("héllo 👋")', "length([1, 2, 3])", "length(null)", "length(5)",
    ])).toEqual([
      "ana lopez", "ANA", "hi", "", "42", { code: "runtime", message: "TypeError: lower needs text." },
      true, true, false, false,
      "a, b", "1 / 2", "", { code: "runtime", message: "TypeError: join needs a list." },
      7, 3, 0, { code: "runtime", message: "TypeError: length needs text or a list." },
    ]);
  });

  it("totals and rounds numbers", async () => {
    expect(await values([
      "sum(1, 2, 3)", 'sum([1, 2], 3, null, "")', "sum()", 'sum("3")',
      "min(3, [1, 2])", "max(3, [1, 5])", "min()", "max(null)",
      "round(2.5)", "round(1.005, 2)", "round(1234, -2)", "round(-2.5)", "round(null)", 'round("1")', "round(1, 1.5)",
      "round(record.Price * record.Quantity, 2)", "round(1e308, 2)", "round(-1e308, 2)", "round(1.7976931348623157e308, 15)", "round(1e-320, 15)",
    ])).toEqual([
      6, 6, 0, { code: "runtime", message: "TypeError: sum needs numbers." },
      1, 5, null, null,
      3, 1.01, 1200, -2, null, { code: "runtime", message: "TypeError: round needs a number." },
      { code: "runtime", message: "RangeError: round needs a whole number of places from -15 to 15." },
      37.5, 1e308, -1e308, 1.7976931348623157e308, 0,
    ]);
  });
});

describe("formulas", () => {
  it("read the record, previous values, trigger, person, message, and bound step results", async () => {
    expect(await values([
      'record.Status == "Done" && previous.Status != "Done"', "trigger.kind", "trigger.field", "person.name", "record.Missing",
      "total", "tasks.length", "tasks[1].Name", "message",
    ])).toEqual([true, "field-changed", "Status", "Ana", null, 37.5, 2, "Pack", null]);
    const added = { record: { Name: "Ana" }, trigger: { kind: "record-added" }, person: null, now: scope.now };
    expect(await evaluator.evaluate(added, [expression("previous.Name"), expression("person"), expression("typeof total")])).toEqual([
      { ok: true, value: null }, { ok: true, value: null }, { ok: true, value: "undefined" },
    ]);
    const posted = { trigger: { kind: "group-message", group: "Trip" }, message: { text: "/task Buy tickets" }, person: null, now: scope.now };
    expect(await evaluator.evaluate(posted, [expression("message.text"), expression("record")])).toEqual([
      { ok: true, value: "/task Buy tickets" }, { ok: true, value: null },
    ]);
  });

  it("cannot change the scope", async () => {
    expect(await values(['record.Status = "Open"', 'record.Tags.push("x")', "record = {}", 'trigger.kind = "x"', "total = 0", 'tasks[0].Name = "x"']))
      .toEqual(Array.from({ length: 6 }, () => expect.objectContaining({ code: "runtime", message: expect.stringMatching(/^TypeError: /) })));
    expect(await value("record.Status")).toEqual({ ok: true, value: "Done" });
  });

  it("cannot change what later formulas in the run see", async () => {
    expect(await values([
      // Each formula has its own context, so a change to a prototype that no global reaches stays in its formula.
      "(Object.getPrototypeOf([][Symbol.iterator]()).next = function () { return { done: true }; }, 1)", "sum(1, 2, 3)", "[...record.Tags]",
      "(Object.getPrototypeOf(Uint8Array.prototype).fill = () => 0, 1)", "Array.from(new Uint8Array(2).fill(7))",
      // The global built-ins, their prototypes, and the global object are frozen.
      "(Array.prototype.first = 1, 1)", "(globalThis.leak = 1, 1)", "(JSON.stringify = () => 'x', 1)", "[].first", "typeof leak", "JSON.stringify([1])",
    ])).toEqual([
      1, 6, ["trip", "urgent"], 1, [7, 7],
      expect.objectContaining({ code: "runtime" }), expect.objectContaining({ code: "runtime" }), expect.objectContaining({ code: "runtime" }),
      null, "undefined", "[1]",
    ]);
  });

  it("fill message text with values", async () => {
    // The file contract splits "Hi {record.Name}!" into these parts.
    const text = (...parts: Array<string | { expression: string }>): AutomationFormula => ({ kind: "text", parts: parts.map(part =>
      typeof part === "string" ? { kind: "text", text: part } : { kind: "expression", expression: part.expression }) });
    expect(await evaluator.evaluate(scope, [
      text("Hi ", { expression: "record.Name" }, "!"), text("Tags: ", { expression: "record.Tags" }), text({ expression: "tasks[0]" }),
      text("[", { expression: "record.Missing" }, "]"), text("Due ", { expression: 'formatDate(record.Due, "MMM D")' }), text("{", { expression: "}" }),
    ])).toEqual([
      { ok: true, value: "Hi Ana Lopez!" }, { ok: true, value: "Tags: trip, urgent" }, { ok: true, value: '{"id":"record-7","Name":"Book hotel"}' },
      { ok: true, value: "[]" }, { ok: true, value: "Due Sep 30" }, { ok: false, error: expect.objectContaining({ code: "syntax" }) },
    ]);
  });

  it("return errors as data", async () => {
    expect(await values(["missing + 1", "let x = 1", "() => 1", "Promise.resolve(1)", "1n", "({ toJSON() {} })", 'undefined'])).toEqual([
      { code: "runtime", message: expect.stringMatching(/^ReferenceError: .*missing/) },
      { code: "syntax", message: expect.stringMatching(/^SyntaxError: /) },
      { code: "invalid_result", message: "The formula must produce text, a number, true or false, a list, or an object." },
      { code: "invalid_result", message: "The formula must finish without waiting. Remove async and await." },
      { code: "invalid_result", message: "The formula must produce text, a number, true or false, a list, or an object." },
      { code: "invalid_result", message: "The formula produced a value that cannot be saved." },
      null,
    ]);
  });

  it("refuse a batch or scope the executor must not send", async () => {
    await expect(evaluator.evaluate(scope, Array.from({ length: AUTOMATION_LIMITS.formulasPerBatch + 1 }, () => expression("1"))))
      .rejects.toThrow("at most 64 formulas");
    for (const now of ["2026-09-24T09:30:00", "2026-02-30T09:30:00Z", "2026-09-24T24:00:00Z", "2026-09-24T09:30:00+15:00"]) {
      await expect(evaluator.evaluate({ ...scope, now }, [expression("1")])).rejects.toThrow("`now` with a UTC offset");
    }
    await expect(evaluator.evaluate(scope, [{ kind: "code" as "expression", source: "1" }])).rejects.toThrow("not an expression or message text");
    await expect(evaluator.evaluate(scope, [{ kind: "text", parts: [{ kind: "expression", text: "1" } as unknown as AutomationTextPart] }]))
      .rejects.toThrow("not an expression or message text");
    for (const name of ["record", "today", "now", "message", "not-a-name"]) {
      await expect(evaluator.evaluate({ ...scope, bindings: { [name]: 1 } }, [expression("1")])).rejects.toThrow(`cannot bind the name "${name}"`);
    }
    for (const name of ["Math", "JSON", "Object", "Array", "undefined", "AggregateError", "globalThis"]) {
      await expect(evaluator.evaluate({ ...scope, bindings: { [name]: 1 } }, [expression("1")]))
        .rejects.toThrow(`The step result name "${name}" belongs to a JavaScript built-in.`);
    }
    expect(await evaluator.evaluate(scope, [])).toEqual([]);
  });
});

describe("code steps", () => {
  it("return field values, record changes, and output for the executor", async () => {
    const result = await evaluator.runCode(scope, `
      const due = ctx.dateAdd(ctx.today(), 1, "week");
      return {
        set: { "Finished on": ctx.today(), Due: due },
        records: [
          { action: "add", collection: "Trip/Tasks", fields: { Name: "Book hotel for " + ctx.person.name } },
          { action: "change", collection: "Trip/Tasks", id: "record-7", fields: { Status: "Open" } },
        ],
        output: { total: ctx.sum(ctx.record.Price, ctx.total), tags: ctx.record.Tags },
      };`);
    expect(result).toEqual({ ok: true, value: {
      set: { "Finished on": "2026-09-24", Due: "2026-10-01" },
      records: [
        { action: "add", collection: "Trip/Tasks", fields: { Name: "Book hotel for Ana" } },
        { action: "change", collection: "Trip/Tasks", id: "record-7", fields: { Status: "Open" } },
      ],
      output: { total: 50, tags: ["trip", "urgent"] },
    } });
    expect(await evaluator.runCode(scope, "if (ctx.record.Status !== 'Done') return { set: { Status: 'Done' } };")).toEqual({ ok: true, value: {} });
  });

  it("reject a result the executor cannot use", async () => {
    const invalid = async (source: string) => {
      const result = await evaluator.runCode(scope, source);
      return result.ok ? result.value : result.error;
    };
    expect(await invalid("return { sets: {} }")).toEqual({ code: "invalid_result", message: expect.stringContaining('"sets"') });
    expect(await invalid('return { records: [{ action: "change", collection: "Tasks", fields: {} }] }'))
      .toEqual({ code: "invalid_result", message: expect.stringContaining("records.0.id") });
    expect(await invalid('return { records: [{ action: "remove", collection: "Tasks", id: "a", fields: {} }] }'))
      .toEqual({ code: "invalid_result", message: expect.stringContaining("records.0.action") });
    expect(await invalid('return { set: { "": 1 } }')).toEqual({ code: "invalid_result", message: expect.stringContaining("set") });
    expect(await invalid("return 5")).toEqual({ code: "invalid_result", message: expect.stringContaining("expected object") });
    expect(await invalid("return (async () => ({}))()"))
      .toEqual({ code: "invalid_result", message: "The code must finish without waiting. Remove async and await." });
  });

  it("report thrown values, syntax errors, and attempts to change ctx", async () => {
    const error = async (source: string) => {
      const result = await evaluator.runCode(scope, source);
      return result.ok ? result.value : result.error;
    };
    expect(await error('throw "No due date"')).toEqual({ code: "runtime", message: "No due date" });
    expect(await error("return {")).toEqual({ code: "syntax", message: expect.stringMatching(/^SyntaxError: /) });
    expect(await error('ctx.record.Status = "Open"')).toEqual({ code: "runtime", message: expect.stringMatching(/^TypeError: /) });
    expect(await error("ctx.today = () => 'tomorrow'")).toEqual({ code: "runtime", message: expect.stringMatching(/^TypeError: /) });
  });
});

describe("limits", () => {
  it("stop a runaway formula and keep the worker", async () => {
    const started = threads.started;
    const [loop, next] = await evaluator.evaluate(scope, [expression("(() => { for (;;) {} })()"), expression("1 + 1")]);
    expect(loop).toEqual({ ok: false, error: { code: "timeout", message: expect.stringContaining(`${AUTOMATION_LIMITS.formulaMs} ms`) } });
    expect(next).toEqual({ ok: true, value: 2 });
    expect(await value("record.Name")).toEqual({ ok: true, value: "Ana Lopez" });
    expect(threads.started).toBe(started);
  });

  it("stop a runaway code step", async () => {
    expect(await evaluator.runCode(scope, "for (;;) {}")).toEqual({ ok: false, error: { code: "timeout", message: expect.stringContaining(`${AUTOMATION_LIMITS.codeMs} ms`) } });
    expect(await value("record.Name")).toEqual({ ok: true, value: "Ana Lopez" });
  });

  it("do not block the caller's thread", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      await evaluator.runCode(scope, "for (;;) {}");
    } finally { clearInterval(timer); }
    expect(ticks).toBeGreaterThan(0);
  });

  it("stop memory use at the limit", async () => {
    const memory = { code: "memory", message: "The formula used more memory than it is allowed, so it stopped." };
    const before = process.memoryUsage().rss;
    expect(await values([
      // Each allocation is under 16 MiB. Together they would take 1.5 GB without the worker's capped memory.
      "(() => { const k = []; for (let i = 0; i < 100; i++) k.push(new Uint8Array(15e6).fill(1)); return k.length })()",
      "(() => { const k = []; for (let i = 0; i < 1000; i++) k.push(new Uint8Array(1 << 20).fill(1)); return k.length })()",
      '"x".repeat(1 << 25).length', "new Array(1e7).fill(0).length", "(function f() { return f() })()",
      "new Uint8Array(12 << 20).fill(1).length",
    ])).toEqual([memory, memory, memory, memory, { code: "memory", message: "The formula nested its calls too deeply, so it stopped." }, 12 << 20]);
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
    expect(await evaluator.runCode(scope, "const rows = []; for (;;) rows.push({ rows });")).toEqual({ ok: false, error: expect.objectContaining({ code: "memory" }) });
    expect(await value('"x".repeat(1 << 20).length')).toEqual({ ok: true, value: 1 << 20 });
  });

  it("refuse source, scope, and results over their sizes", async () => {
    const tooLong = "1+".repeat(AUTOMATION_LIMITS.sourceBytes / 2) + "1";
    expect(await value(tooLong)).toEqual({ ok: false, error: { code: "too_large", message: "The formula is longer than 64 KiB." } });
    expect(await evaluator.runCode(scope, `return {}; // ${"x".repeat(AUTOMATION_LIMITS.sourceBytes)}`))
      .toEqual({ ok: false, error: { code: "too_large", message: "The code is longer than 64 KiB." } });
    const large = { ...scope, record: { Notes: "x".repeat(AUTOMATION_LIMITS.scopeBytes) } };
    expect(await evaluator.evaluate(large, [expression("1"), expression("2")])).toEqual(Array.from({ length: 2 }, () => (
      { ok: false, error: { code: "too_large", message: "The record and step results are larger than 256 KiB." } })));
    expect(await value(`"x".repeat(${AUTOMATION_LIMITS.resultBytes})`))
      .toEqual({ ok: false, error: { code: "too_large", message: "The formula produced more than 64 KiB." } });
    expect(await value(`"x".repeat(${AUTOMATION_LIMITS.resultBytes - 100})`)).toEqual({ ok: true, value: "x".repeat(AUTOMATION_LIMITS.resultBytes - 100) });
  });

  it("refuse results nested too deeply", async () => {
    const nested = (depth: number) => `(() => { let v = 1; for (let i = 0; i < ${depth}; i++) v = [v]; return v; })()`;
    const [deepest, tooDeep, crossing, crashing] = await evaluator.evaluate(scope, [64, 65, 3000, 12000].map(depth => expression(nested(depth))));
    expect(deepest!.ok).toBe(true);
    const tooDeepError = { code: "invalid_result", message: `The formula nested lists or objects more than ${AUTOMATION_LIMITS.resultDepth} levels deep.` };
    expect([tooDeep, crossing]).toEqual([{ ok: false, error: tooDeepError }, { ok: false, error: tooDeepError }]);
    expect(crashing!.ok).toBe(false);
    expect(await evaluator.runCode(scope, `return { output: ${nested(100)} };`)).toEqual({ ok: false, error: expect.objectContaining({ code: "invalid_result" }) });
  });

  it("stop native work that finishes past its limit", async () => {
    // QuickJS checks its interrupt handler between bytecodes, not while native code converts a huge BigInt.
    // The conversion takes about 500 ms, so its result arrives after the 100 ms limit and before the watchdog.
    expect(await value("String(1n << 500000n).length")).toEqual({ ok: false, error: expect.objectContaining({ code: "timeout" }) });
  });

  it("replace a worker that stops answering and finish the run on a new one", async () => {
    const started = threads.started;
    const [stuck, next, last] = await evaluator.evaluate(scope, [expression("Array(16).fill(1n << 1048000n).map(String).length"), expression("1 + 1"), expression("2 + 2")]);
    expect(stuck).toEqual({ ok: false, error: { code: "timeout", message: expect.stringContaining(`${AUTOMATION_LIMITS.formulaMs} ms`) } });
    expect([next, last]).toEqual([{ ok: true, value: 2 }, { ok: true, value: 4 }]);
    expect(threads.started).toBe(started + 1);
  }, 60_000);

  it("stop a run at its total time limit", async () => {
    const stuck = expression("Array(16).fill(1n << 1048000n).map(String).length");
    const results = await evaluator.evaluate(scope, [stuck, stuck, stuck, stuck, stuck, expression("1 + 1")]);
    expect(results.every(result => !result.ok && result.error.code === "timeout")).toBe(true);
    expect(results.at(-1)).toEqual({ ok: false, error: { code: "timeout", message: `The formula did not run because the run took longer than ${AUTOMATION_LIMITS.requestMs / 1000} s.` } });
  }, 60_000);
});

describe("memory between runs", () => {
  const marker = "dohc-marker-4111111111111111";
  const planted: AutomationScope = { ...scope, record: { Notes: marker.repeat(40) }, bindings: { card: marker } };
  // Fills freed memory with the marker: many copies of the record's text, then a large buffer of marker bytes.
  const plant = `const copies = []; for (let i = 0; i < 4000; i++) copies.push(ctx.record.Notes + i);
    const bytes = new Uint8Array(4 << 20); for (let i = 0; i < ${marker.length}; i++) bytes[i] = ctx.card.charCodeAt(i);
    for (let filled = ${marker.length}; filled < bytes.length; filled *= 2) bytes.copyWithin(filled, 0, filled);
    return { output: copies.length };`;
  const find = `(bytes => { const m = ${JSON.stringify(marker)}, first = m.charCodeAt(0);
    for (let i = bytes.indexOf(first); i >= 0; i = bytes.indexOf(first, i + 1)) {
      let j = 1; while (j < m.length && bytes[i + j] === m.charCodeAt(j)) j++;
      if (j === m.length) return true;
    }
    return false; })`;
  const size = 8 << 20;
  // Every way QuickJS hands out buffer memory: new, resized, grown, transferred, and copied.
  const probes = [
    `new Uint8Array(new ArrayBuffer(${size}))`,
    `new Uint8Array(${size})`,
    `new Uint8Array(new Float64Array(${size / 8}).buffer)`,
    `new Uint8Array(new DataView(new ArrayBuffer(${size})).buffer)`,
    `(() => { const b = new ArrayBuffer(16, { maxByteLength: ${size} }); b.resize(${size}); return new Uint8Array(b); })()`,
    `(() => { const b = new ArrayBuffer(16, { maxByteLength: ${size} }); const view = new Uint8Array(b); b.resize(${size}); return view; })()`,
    `new Uint8Array(new ArrayBuffer(16).transfer(${size}))`,
    `new Uint8Array(new ArrayBuffer(16).transferToFixedLength(${size}))`,
    `new Uint8Array(new ArrayBuffer(16, { maxByteLength: ${size} }).transfer(${size}))`,
    `new Uint8Array(new ArrayBuffer(${size / 2}).slice(0))`,
    `typeof SharedArrayBuffer === "undefined" ? new Uint8Array(0) : new Uint8Array(new SharedArrayBuffer(${size}))`,
    `typeof SharedArrayBuffer === "undefined" ? new Uint8Array(0) : (() => { const b = new SharedArrayBuffer(16, { maxByteLength: ${size} }); b.grow(${size}); return new Uint8Array(b); })()`,
  ];

  it("gives no formula or code step a SharedArrayBuffer", async () => {
    expect(await values(["typeof SharedArrayBuffer", "Object.getOwnPropertyNames(globalThis).includes('SharedArrayBuffer')"])).toEqual(["undefined", false]);
    expect(await evaluator.runCode(scope, "return { output: typeof SharedArrayBuffer };")).toEqual({ ok: true, value: { output: "undefined" } });
  });

  it.each(probes)("keeps one run's data out of a later run's buffer: %s", async probe => {
    expect(await evaluator.runCode(planted, plant)).toEqual({ ok: true, value: { output: 4000 } });
    expect(await evaluator.runCode(scope, `return { output: ${find}(${probe}) };`)).toEqual({ ok: true, value: { output: false } });
    // Formulas of one run share a memory; freed buffers still come back cleared.
    const [planting, found] = await evaluator.evaluate(planted, [
      expression("(() => { const copies = []; for (let i = 0; i < 4000; i++) copies.push(record.Notes + i); return copies.length; })()"),
      expression(`${find}(${probe})`),
    ]);
    expect([planting, found]).toEqual([{ ok: true, value: 4000 }, { ok: true, value: false }]);
  });
});

describe("scope preparation", () => {
  it("reads a large scope before each formula's time starts", async () => {
    const records = Array.from({ length: 900 }, (_, index) => ({ id: `record-${index}`, Name: `Task ${index} for the trip`, Status: index % 3 ? "Open" : "Done", Due: "2026-10-01", Price: index * 1.25, Tags: ["trip", "urgent"] }));
    const large: AutomationScope = { ...scope, bindings: { tasks: records } };
    expect(JSON.stringify(large).length).toBeGreaterThan(100 * 1024);
    const results = await evaluator.evaluate(large, Array.from({ length: 20 }, () => expression('tasks.filter(task => task.Status == "Done").length')));
    expect(results).toEqual(Array.from({ length: 20 }, () => ({ ok: true, value: 300 })));
    const many: AutomationScope = { ...scope, bindings: Object.fromEntries(Array.from({ length: 15_000 }, (_, index) => [`b${index}`, index])) };
    expect(await value("b14999 + 1", many)).toEqual({ ok: true, value: 15_000 });
  });

  it("counts the scope's size exactly before copying it", async () => {
    const fresh = createAutomationEvaluator();
    try {
      const rows = Array.from({ length: 1000 }, (_, index) => ({ a: index, b: index % 2 === 0, c: null, d: [], e: {}, f: [1.5, -2e-7, undefined], g: undefined }));
      const sized = (padding: number): AutomationScope => ({ ...scope, record: { Rows: rows as unknown as JsonObject[], Notes: "x".repeat(padding) } });
      const padding = AUTOMATION_LIMITS.scopeBytes - JSON.stringify(sized(0)).length;
      expect(JSON.stringify(sized(padding)).length).toBe(AUTOMATION_LIMITS.scopeBytes);
      expect(await fresh.evaluate(sized(padding + 1), [expression("1")]))
        .toEqual([{ ok: false, error: { code: "too_large", message: "The record and step results are larger than 256 KiB." } }]);
      expect(threads.started).toBe(0);
      expect(await fresh.evaluate(sized(padding), [expression("record.Rows.length")])).toEqual([{ ok: true, value: 1000 }]);
      // 30,000 small objects are 240 KB of JSON, under the limit.
      const small = { ...scope, record: { Rows: Array.from({ length: 30_000 }, () => ({ a: 1 })) } };
      expect(await fresh.evaluate(small, [expression("record.Rows.length")])).toEqual([{ ok: true, value: 30_000 }]);
    } finally { await fresh.close(); }
  });
  beforeEach(() => { threads.started = 0; });

  it("refuses a scope with values JSON cannot hold", async () => {
    const started = threads.started;
    class CustomArray extends Array {}
    class Point { x = 1; }
    const cases: Array<[unknown, string]> = [
      [1n, "bigint"], [new Date(0), "Date"], [new Map(), "Map"], [() => 1, "function"], [[{ deep: [Symbol("s")] }], "symbol"],
      [CustomArray.from([1, 2]), "CustomArray"], [{ rows: [new Point()] }, "Point"], [new Uint8Array(2), "Uint8Array"],
    ];
    for (const [bad, kind] of cases) {
      await expect(evaluator.evaluate({ ...scope, record: { Bad: bad as JsonObject } }, Array.from({ length: 64 }, () => expression("1"))))
        .rejects.toThrow(`The automation scope must hold only JSON values. It holds a value of type ${kind}.`);
    }
    expect(threads.started).toBe(started);
  });

  it("has the worker refuse a scope it cannot turn into JSON or that nests too deeply, and keep serving", async () => {
    const worker = new Worker(fileURLToPath(new URL("../dist/automation-worker.mjs", import.meta.url)));
    try {
      await once(worker, "message");
      const spent = { prepareMs: 0, runMs: 0 };
      worker.postMessage({ scope: { ...scope, record: { Bad: 1n } }, items: [expression("1")], spent });
      expect((await once(worker, "message"))[0]).toEqual({ kind: "refused", message: "The automation scope must hold only JSON values." });
      worker.postMessage({ scope: { ...scope, bindings: { rows: nested(65) } }, items: [expression("1")], spent });
      expect((await once(worker, "message"))[0]).toEqual({ kind: "result", result: { ok: false, error: tooDeep }, prepareMs: 0, runMs: 0 });
      worker.postMessage({ scope, items: [expression("1 + 1")], spent });
      expect((await once(worker, "message"))[0]).toEqual({ kind: "result", result: { ok: true, value: 2 }, prepareMs: expect.any(Number), runMs: expect.any(Number) });
    } finally { await worker.terminate(); }
  });

  it("refuses a scope nested too deeply before copying it", async () => {
    const fresh = createAutomationEvaluator();
    try {
      const cyclic: JsonObject = {};
      cyclic.self = cyclic;
      for (const deep of [{ ...scope, bindings: { rows: nested(65) } }, { ...scope, record: { Rows: nested(3000) } }, { ...scope, record: cyclic }]) {
        expect(await fresh.evaluate(deep, [expression("1"), expression("2")])).toEqual([{ ok: false, error: tooDeep }, { ok: false, error: tooDeep }]);
      }
      expect(threads.started).toBe(0);
      // A bound step result can nest as deeply as a result can.
      expect(await fresh.evaluate({ ...scope, bindings: { rows: nested(64) }, record: { Rows: nested(64) } }, [expression("rows.flat(Infinity)[0] + record.Rows.flat(Infinity)[0]")]))
        .toEqual([{ ok: true, value: 2 }]);
    } finally { await fresh.close(); }
  });

  it("counts escaped UTF-8 bytes of keys and strings at the size limit", async () => {
    const fresh = createAutomationEvaluator();
    try {
      // Quotes, backslashes, and control characters are escaped; a lone surrogate is written as six bytes.
      const tricky: JsonObject = {
        "é\"\n\u0001😀": "\u0000\u001f\t\\\"é€😀\u2028\ud800",
        [`key${"\u0000".repeat(10)}`]: ["\ud83d", "\udc00", "x\u007f"],
      };
      const sized = (padding: number): AutomationScope => ({ ...scope, record: { ...tricky, Notes: "x".repeat(padding) } });
      const bytes = (input: AutomationScope) => Buffer.byteLength(JSON.stringify(input));
      const padding = AUTOMATION_LIMITS.scopeBytes - bytes(sized(0));
      expect(bytes(sized(padding))).toBe(AUTOMATION_LIMITS.scopeBytes);
      expect(await fresh.evaluate(sized(padding + 1), [expression("1")])).toEqual([{ ok: false, error: tooLarge }]);
      // 150,000 NUL characters serialize to 900 KB.
      expect(await fresh.evaluate({ ...scope, record: { Notes: "\u0000".repeat(150_000) } }, [expression("1")])).toEqual([{ ok: false, error: tooLarge }]);
      expect(await fresh.evaluate({ ...scope, record: { ["\u0000".repeat(50_000)]: 1 } }, [expression("1")])).toEqual([{ ok: false, error: tooLarge }]);
      expect(threads.started).toBe(0);
      expect(await fresh.evaluate(sized(padding), [expression('Object.keys(record).join("|").length')]))
        .toEqual([{ ok: true, value: Object.keys(sized(padding).record!).join("|").length }]);
    } finally { await fresh.close(); }
  });

  it("spends a request's time reading its scope apart from the time its formulas run", async () => {
    const worker = new Worker(fileURLToPath(new URL("../dist/automation-worker.mjs", import.meta.url)));
    try {
      await once(worker, "message");
      type Reply = { result: unknown; prepareMs: number; runMs: number };
      const ask = async (input: AutomationScope, count: number, spent: { prepareMs: number; runMs: number }) => {
        worker.postMessage({ scope: input, items: Array.from({ length: count }, () => expression("record.Rows.length")), spent });
        const replies: Reply[] = [];
        for (let index = 0; index < count; index++) replies.push((await once(worker, "message"))[0] as Reply);
        return replies;
      };
      // The formulas have 100 ms left to run. Reading the large scope 20 times takes longer than that, and does not count.
      const large: AutomationScope = { ...scope, record: { Rows: Array.from({ length: 12_000 }, (_, index) => ({ id: `row-${index}` })) } };
      const replies = await ask(large, 20, { prepareMs: 0, runMs: AUTOMATION_LIMITS.requestMs - 100 });
      expect(replies.map(reply => reply.result)).toEqual(Array.from({ length: 20 }, () => ({ ok: true, value: 12_000 })));
      expect(replies.reduce((total, reply) => total + reply.prepareMs, 0)).toBeGreaterThan(100);
      // Each budget, once spent, stops the items after it.
      expect((await ask(large, 1, { prepareMs: 0, runMs: AUTOMATION_LIMITS.requestMs }))[0]!.result).toEqual({ ok: false, error: {
        code: "timeout", message: "The formula did not run because the run took longer than 8 s." } });
      expect((await ask(large, 1, { prepareMs: AUTOMATION_LIMITS.prepareRequestMs, runMs: 0 }))[0]!.result).toEqual({ ok: false, error: {
        code: "timeout", message: "The formula did not run because reading the record and step results took longer than 8 s in all." } });
    } finally { await worker.terminate(); }
  });

  it("times out reading a scope that finishes after its limit", async () => {
    const quickjs = await newQuickJS();
    // The clock reads 0 when the item starts and 10 s after that, as if reading the scope took 10 s without an interrupt.
    const jumping = () => { let readings = 0; return () => readings++ === 0 ? 0 : 10_000; };
    const late = { code: "timeout", message: `Reading the record and step results took longer than ${AUTOMATION_LIMITS.prepareMs} ms.` };
    expect(evaluateItem(quickjs, JSON.stringify(scope), expression("1 + 1"), jumping()).result).toEqual({ ok: false, error: late });
    // A scope the guest cannot read gives an error, and a timeout past the limit.
    expect(evaluateItem(quickjs, "not JSON", expression("1"), jumping()).result).toEqual({ ok: false, error: late });
    // The same instance still works, so the timeouts released their QuickJS values.
    expect(evaluateItem(quickjs, JSON.stringify(scope), expression("1 + 1")).result).toEqual({ ok: true, value: 2 });
    expect(evaluateItem(quickjs, "not JSON", expression("1")).result)
      .toEqual({ ok: false, error: { code: "too_large", message: "The record and step results are too large or too deeply nested to read." } });
  });
});

describe("evaluator lifetime", () => {
  beforeEach(() => { threads.started = 0; threads.terminated = 0; });

  it("answers requests in order", async () => {
    const results = await Promise.all([1, 2, 3].map(number => value(`${number} * 2`)));
    expect(results).toEqual([{ ok: true, value: 2 }, { ok: true, value: 4 }, { ok: true, value: 6 }]);
  });

  it("returns busy for every item when 16 runs are already waiting", async () => {
    const waiting = Array.from({ length: 16 }, (_, index) => value(`${index}`));
    const busy = { ok: false, error: { code: "busy", message: "The evaluator already has 16 runs waiting. Try this run again later." } };
    expect(await value("16")).toEqual(busy);
    expect(await evaluator.evaluate(scope, [expression("1"), expression("1".repeat(AUTOMATION_LIMITS.sourceBytes + 1))])).toEqual([busy, busy]);
    const oversized = { ...scope, record: { Notes: "x".repeat(AUTOMATION_LIMITS.scopeBytes) } };
    expect(await evaluator.evaluate(oversized, [expression("1"), expression("2")])).toEqual([busy, busy]);
    expect(await Promise.all(waiting)).toEqual(Array.from({ length: 16 }, (_, index) => ({ ok: true, value: index })));
    expect(await value("16")).toEqual({ ok: true, value: 16 });
  });

  it("refuses oversized input without copying it to a worker", async () => {
    const fresh = createAutomationEvaluator();
    try {
      expect(await fresh.evaluate({ ...scope, record: { Notes: "x".repeat(AUTOMATION_LIMITS.scopeBytes) } }, [expression("1")])).toEqual([{ ok: false, error: tooLarge }]);
      expect(await fresh.evaluate({ ...scope, record: { Rows: Array.from({ length: AUTOMATION_LIMITS.scopeBytes }, () => 0) } }, [expression("1")])).toEqual([{ ok: false, error: tooLarge }]);
      expect(await fresh.evaluate(scope, [expression("1".repeat(AUTOMATION_LIMITS.sourceBytes + 1))]))
        .toEqual([{ ok: false, error: { code: "too_large", message: "The formula is longer than 64 KiB." } }]);
      const parts = Array.from({ length: AUTOMATION_LIMITS.textParts + 1 }, (): AutomationTextPart => ({ kind: "text", text: "a" }));
      expect(await fresh.evaluate(scope, [{ kind: "text", parts }]))
        .toEqual([{ ok: false, error: { code: "too_large", message: "The message has more than 1024 parts." } }]);
      expect(await fresh.runCode(scope, "x".repeat(AUTOMATION_LIMITS.sourceBytes + 1)))
        .toEqual({ ok: false, error: { code: "too_large", message: "The code is longer than 64 KiB." } });
      expect(threads.started).toBe(0);
    } finally { await fresh.close(); }
  });

  it("fails one item for a reply it cannot read, and moves on after a worker asks to restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dohc-automation-worker-"));
    const entryPath = join(directory, "worker.mjs");
    // A stand-in worker: "deep" answers with a value too deeply nested to copy, and "restart" asks for a new worker.
    await writeFile(entryPath, `import { parentPort } from "node:worker_threads";
      const reply = message => parentPort.postMessage(message);
      parentPort.on("message", ({ items }) => {
        for (const item of items) {
          if (item.source === "deep") {
            let v = 1;
            for (let i = 0; i < 3000; i++) v = [v];
            reply({ kind: "result", result: { ok: true, value: v } });
          } else if (item.source === "restart") {
            reply({ kind: "result", result: { ok: false, error: { code: "memory", message: "Broken." } } });
            return reply({ kind: "restart" });
          } else reply({ kind: "result", result: { ok: true, value: item.source } });
        }
      });
      reply({ kind: "ready" });`);
    const standIn = createAutomationEvaluator({ entryPath });
    try {
      expect(await standIn.evaluate(scope, ["a", "deep", "b", "restart", "c"].map(expression))).toEqual([
        { ok: true, value: "a" },
        { ok: false, error: { code: "invalid_result", message: "The formula produced a value that cannot be read." } },
        { ok: true, value: "b" },
        { ok: false, error: { code: "memory", message: "Broken." } },
        { ok: true, value: "c" },
      ]);
      expect(threads.started).toBe(2);
    } finally {
      await standIn.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops an idle worker and starts another when needed", async () => {
    const idle = createAutomationEvaluator({ idleMs: 0 });
    try {
      expect(await idle.evaluate(scope, [expression("1")])).toEqual([{ ok: true, value: 1 }]);
      await vi.waitFor(() => expect(threads.terminated).toBe(1), { timeout: 60_000, interval: 5 });
      expect(await idle.evaluate(scope, [expression("2")])).toEqual([{ ok: true, value: 2 }]);
      expect(threads.started).toBe(2);
    } finally { await idle.close(); }
  });

  it("refuses work after close", async () => {
    const closing = createAutomationEvaluator();
    const running = closing.runCode(scope, "for (;;) {}");
    await vi.waitFor(() => expect(threads.started).toBe(1), { timeout: 60_000, interval: 5 });
    await closing.close();
    await expect(running).rejects.toThrow();
    await expect(closing.evaluate(scope, [expression("1")])).rejects.toThrow("closed");
  });
});
