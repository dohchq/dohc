import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_LIMITS, createAutomationEvaluator } from "./automation.ts";
import type { AutomationFormula, AutomationScope, AutomationTextPart } from "./automation.ts";

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
      'dateAdd("2026-02-30", 1, "days")', 'dateAdd("9999-12-31", 1, "day")',
    ])).toEqual([
      { code: "runtime", message: "TypeError: dateAdd needs a whole number to add, such as 3." },
      { code: "runtime", message: "TypeError: dateAdd needs a unit: years, quarters, months, weeks, days, hours, or minutes." },
      { code: "runtime", message: "TypeError: dateAdd needs a date such as 2026-09-24 or 2026-09-24T09:30:00Z." },
      { code: "runtime", message: "RangeError: dateAdd needs a real date. 2026-02-30 is not one." },
      { code: "runtime", message: "RangeError: dateAdd went outside the years 0000 to 9999." },
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
      "round(record.Price * record.Quantity, 2)",
    ])).toEqual([
      6, 6, 0, { code: "runtime", message: "TypeError: sum needs numbers." },
      1, 5, null, null,
      3, 1.01, 1200, -2, null, { code: "runtime", message: "TypeError: round needs a number." },
      { code: "runtime", message: "RangeError: round needs a whole number of places from -15 to 15." },
      37.5,
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
    const shadowing = { ...scope, bindings: { Math: 3, JSON: "text", Object: null } };
    expect(await evaluator.evaluate(shadowing, [expression("Math + 1"), expression("round(2.5)"), expression("JSON"), expression('join(["a", "b"])')])).toEqual([
      { ok: true, value: 4 }, { ok: true, value: 3 }, { ok: true, value: "text" }, { ok: true, value: "a, b" },
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
    expect(await values(["(Array.prototype.first = 1, 1)", "(globalThis.leak = 1, 1)", "(JSON.stringify = () => 'x', 1)", "[].first", "typeof leak", "JSON.stringify([1])"]))
      .toEqual([
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
    for (const name of ["record", "today", "now", "message", "undefined", "not-a-name"]) {
      await expect(evaluator.evaluate({ ...scope, bindings: { [name]: 1 } }, [expression("1")])).rejects.toThrow(`cannot bind the name "${name}"`);
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
    // On a very busy computer the wall-clock watchdog can stop it first; both report a timeout.
    expect(await evaluator.runCode(scope, "for (;;) {}")).toEqual({ ok: false, error: expect.objectContaining({ code: "timeout" }) });
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
    expect(await values(['"x".repeat(1 << 25).length', "new Array(1e7).fill(0).length", "(function f() { return f() })()"])).toEqual([
      { code: "memory", message: "The formula used more memory than it is allowed, so it stopped." },
      { code: "memory", message: "The formula used more memory than it is allowed, so it stopped." },
      { code: "memory", message: "The formula nested its calls too deeply, so it stopped." },
    ]);
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

  it("replace a worker that stops answering", async () => {
    const started = threads.started;
    // QuickJS checks its interrupt handler between bytecodes, not while native code converts a huge BigInt.
    expect(await value("Array(16).fill(1n << 1048000n).map(String).length")).toEqual({ ok: false, error: { code: "timeout", message: expect.any(String) } });
    expect(await value("1 + 1")).toEqual({ ok: true, value: 2 });
    expect(threads.started).toBe(started + 1);
  }, 60_000);
});

describe("evaluator lifetime", () => {
  beforeEach(() => { threads.started = 0; threads.terminated = 0; });

  it("answers requests in order", async () => {
    const results = await Promise.all([1, 2, 3].map(number => value(`${number} * 2`)));
    expect(results).toEqual([{ ok: true, value: 2 }, { ok: true, value: 4 }, { ok: true, value: 6 }]);
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
