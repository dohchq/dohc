import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATION_LIMITS, createAutomationEvaluator } from "./automation.ts";
import type { AutomationFormula, AutomationScope, JsonObject, JsonValue } from "./automation.ts";
import { answerItems, evaluateItem, newQuickJS } from "./automation-evaluate.ts";
import type { AutomationWorkerReply } from "./automation-protocol.ts";

const threads = vi.hoisted(() => ({
  started: 0,
  terminated: 0,
  sent: [] as Array<{ kind: string; runId: number; hasScope: boolean }>,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class CountedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      threads.started++;
    }
    override terminate() {
      threads.terminated++;
      return super.terminate();
    }
    override emit(...args: Parameters<Worker["emit"]>) {
      if (args[0] === "message" && args[1]?.testUnreadableReply === true)
        return super.emit("messageerror", new Error("Unreadable test reply."));
      return super.emit(...args);
    }
    override postMessage(...args: Parameters<Worker["postMessage"]>) {
      const message = args[0];
      threads.sent.push({
        kind: message.kind,
        runId: message.runId,
        hasScope: Object.hasOwn(message, "scope"),
      });
      return super.postMessage(...args);
    }
  }
  return { ...actual, Worker: CountedWorker };
});

const scope: AutomationScope = {
  record: {
    Name: "Ana Lopez",
    Status: "Done",
    Tags: ["trip", "urgent"],
    Price: 12.5,
    Quantity: 3,
    Due: "2026-09-30",
  },
  previous: { Status: "Doing" },
  trigger: { kind: "field-changed", field: "Status" },
  bindings: {
    total: 37.5,
    tasks: [
      { id: "record-7", Name: "Book hotel" },
      { id: "record-8", Name: "Pack" },
    ],
  },
  person: { id: "person-1", name: "Ana" },
  now: "2026-09-24T09:30:00.000+08:00",
};
const expression = (source: string): AutomationFormula => ({ kind: "expression", source });
const nested = (depth: number): JsonValue => {
  let value: JsonValue = 1;
  for (let level = 0; level < depth; level++) value = [value];
  return value;
};
const tooLarge = {
  code: "too_large",
  message: "The record and step results are larger than 256 KiB.",
};
const runSpent = {
  code: "timeout",
  message: "The formula did not run because the run took longer than 8 s.",
};
const readSpent = {
  code: "timeout",
  message:
    "The formula did not run because reading the record and step results took longer than 8 s in all.",
};

async function standInWorker(handler: string) {
  const directory = await mkdtemp(join(tmpdir(), "dohc-automation-worker-"));
  const entryPath = join(directory, "worker.mjs");
  await writeFile(
    entryPath,
    `import { parentPort } from "node:worker_threads";
    const reply = message => parentPort.postMessage(message);
    parentPort.on("message", (request) => { if (request.kind === "end") return; const { items, spent } = request; ${handler} });
    reply({ kind: "ready" });`,
  );
  return {
    entryPath,
    [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
  };
}
const tooDeep = {
  code: "too_large",
  message: "The record and step results nest lists or objects more than 64 levels deep.",
};
const evaluator = createAutomationEvaluator();
afterAll(() => evaluator.close());

async function value(source: string, input: AutomationScope = scope) {
  const [result] = await evaluator.evaluate(input, [expression(source)]);
  return result;
}
async function values(sources: string[]) {
  return (await evaluator.evaluate(scope, sources.map(expression))).map((result) =>
    result.ok ? result.value : result.error,
  );
}

describe("formula helpers", () => {
  it("compares guarded values deeply without rerunning their formula", async () => {
    expect(
      await evaluator.evaluate(scope, [
        expression("({b: [2, 3], a: 1})"),
        { ...expression('"matched"'), when: [{ index: 0, equals: { a: 1, b: [2, 3] } }] },
        { ...expression("record.Missing.name"), when: [{ index: 0, equals: { a: 1, b: [3, 2] } }] },
      ]),
    ).toEqual([
      { ok: true, value: { b: [2, 3], a: 1 } },
      { ok: true, value: "matched" },
      { ok: true, value: null },
    ]);
  });

  it("skips guarded runtime errors, loops, and oversized sources without evaluating them", async () => {
    const when = [{ index: 0, truthy: true }];
    expect(
      await evaluator.evaluate(scope, [
        expression("false"),
        { ...expression("record.Missing.name"), when },
        { ...expression("(() => { for (;;) {} })()"), when },
        { ...expression("x".repeat(AUTOMATION_LIMITS.sourceBytes + 1)), when },
        { ...expression("42"), when: [{ index: 0, truthy: false }] },
      ]),
    ).toEqual([false, null, null, null, 42].map((value) => ({ ok: true, value })));
  });

  it("retains selected errors and skips dependencies of a failed predicate", async () => {
    const results = await evaluator.evaluate(scope, [
      expression("true"),
      { ...expression("record.Missing.name"), when: [{ index: 0, truthy: true }] },
      { ...expression("42"), when: [{ index: 1, truthy: false }] },
      expression("7"),
    ]);
    expect(results).toEqual([
      { ok: true, value: true },
      { ok: false, error: expect.objectContaining({ code: "runtime" }) },
      { ok: true, value: null },
      { ok: true, value: 7 },
    ]);
  });

  it("adds calendar and clock units to dates", async () => {
    expect(
      await values([
        'dateAdd(today(), 3, "days")',
        'dateAdd("2026-01-31", 1, "month")',
        'dateAdd("2024-01-31", 1, "months")',
        'dateAdd("2026-09-24", 2, "weeks")',
        'dateAdd("2026-09-24", -1, "years")',
        'dateAdd("2026-11-30", 1, "quarter")',
        'dateAdd("2026-09-24", 90, "minutes")',
        'dateAdd(now(), 2, "hours")',
        'dateAdd("2026-09-24T23:00:00Z", 2, "hours")',
        'dateAdd("2026-09-24T10:00", 1, "day")',
      ]),
    ).toEqual([
      "2026-09-27",
      "2026-02-28",
      "2024-02-29",
      "2026-10-08",
      "2025-09-24",
      "2027-02-28",
      "2026-09-24T01:30:00.000+08:00",
      "2026-09-24T11:30:00.000+08:00",
      "2026-09-25T01:00:00.000Z",
      "2026-09-25T10:00:00.000+08:00",
    ]);
  });
});

describe("formulas", () => {
  it("read the record, previous values, trigger, person, message, and bound step results", async () => {
    expect(
      await values([
        'record.Status == "Done" && previous.Status != "Done"',
        "trigger.kind",
        "trigger.field",
        "person.name",
        "record.Missing",
        "total",
        "tasks.length",
        "tasks[1].Name",
        "message",
      ]),
    ).toEqual([true, "field-changed", "Status", "Ana", null, 37.5, 2, "Pack", null]);
    const added = {
      record: { Name: "Ana" },
      trigger: { kind: "record-added" },
      person: null,
      now: scope.now,
    };
    expect(
      await evaluator.evaluate(added, [
        expression("previous.Name"),
        expression("person"),
        expression("typeof total"),
      ]),
    ).toEqual([
      { ok: true, value: null },
      { ok: true, value: null },
      { ok: true, value: "undefined" },
    ]);
    const posted = {
      trigger: { kind: "group-message", group: "Trip" },
      message: { text: "/task Buy tickets" },
      person: null,
      now: scope.now,
    };
    expect(
      await evaluator.evaluate(posted, [expression("message.text"), expression("record")]),
    ).toEqual([
      { ok: true, value: "/task Buy tickets" },
      { ok: true, value: null },
    ]);
  });

  it("stops a formula that reads a record key it may not, however it reaches the record", async () => {
    const idOnly: AutomationScope = {
      record: { id: "inv-1" },
      trigger: { kind: "button", record: { id: "inv-1" } },
      person: null,
      now: scope.now,
      recordKeys: ["id"],
    };
    const refused = {
      code: "runtime",
      message: "TypeError: The formula can read only this record's id, not Status.",
    };
    expect(
      await evaluator.evaluate(
        idOnly,
        [
          "record.id",
          'record["id"]',
          "trigger.record.id",
          "String(record)",
          "Object.keys(record)",
          '"id" in record',
          'Object.hasOwn(record, "id")',
          "record.Status",
          "(record).Status",
          "((r) => r.Status)(record)",
          "(({ Status }) => Status)(record)",
          'trigger["record"].Status',
          'record?.["Status"]',
          '"Status" in record',
          'Object.getOwnPropertyDescriptor(record, "Status")',
          'Object.hasOwn(record, "Status")',
          'Reflect.has(trigger.record, "Status")',
        ].map(expression),
      ),
    ).toEqual([
      { ok: true, value: "inv-1" },
      { ok: true, value: "inv-1" },
      { ok: true, value: "inv-1" },
      { ok: true, value: "[object Object]" },
      { ok: true, value: ["id"] },
      { ok: true, value: true },
      { ok: true, value: true },
      ...Array.from({ length: 10 }, () => ({ ok: false, error: refused })),
    ]);
    expect(
      await evaluator.evaluate({ ...idOnly, recordKeys: undefined }, [expression("record.Status")]),
    ).toEqual([{ ok: true, value: null }]);
  });

  it("cannot change what later formulas in the run see", async () => {
    expect(
      await values([
        // Each formula has its own context, so a change to a prototype that no global reaches stays in its formula.
        "(Object.getPrototypeOf([][Symbol.iterator]()).next = function () { return { done: true }; }, 1)",
        "sum(1, 2, 3)",
        "[...record.Tags]",
        "(Object.getPrototypeOf(Uint8Array.prototype).fill = () => 0, 1)",
        "Array.from(new Uint8Array(2).fill(7))",
        // The global built-ins, their prototypes, and the global object are frozen.
        "(Array.prototype.first = 1, 1)",
        "(globalThis.leak = 1, 1)",
        "(JSON.stringify = () => 'x', 1)",
        "[].first",
        "typeof leak",
        "JSON.stringify([1])",
      ]),
    ).toEqual([
      1,
      6,
      ["trip", "urgent"],
      1,
      [7, 7],
      expect.objectContaining({ code: "runtime" }),
      expect.objectContaining({ code: "runtime" }),
      expect.objectContaining({ code: "runtime" }),
      null,
      "undefined",
      "[1]",
    ]);
  });

  it("fill message text with values", async () => {
    // The file contract splits "Hi {record.Name}!" into these parts.
    const text = (...parts: Array<string | { expression: string }>): AutomationFormula => ({
      kind: "text",
      parts: parts.map((part) =>
        typeof part === "string"
          ? { kind: "text", text: part }
          : { kind: "expression", expression: part.expression },
      ),
    });
    expect(
      await evaluator.evaluate(scope, [
        text("Hi ", { expression: "record.Name" }, "!"),
        text("Tags: ", { expression: "record.Tags" }),
        text({ expression: "tasks[0]" }),
        text("[", { expression: "record.Missing" }, "]"),
        text("Due ", { expression: 'formatDate(record.Due, "MMM D")' }),
        text("{", { expression: "}" }),
      ]),
    ).toEqual([
      { ok: true, value: "Hi Ana Lopez!" },
      { ok: true, value: "Tags: trip, urgent" },
      { ok: true, value: '{"id":"record-7","Name":"Book hotel"}' },
      { ok: true, value: "[]" },
      { ok: true, value: "Due Sep 30" },
      { ok: false, error: expect.objectContaining({ code: "syntax" }) },
    ]);
  });

  it("return errors as data", async () => {
    expect(
      await values([
        "missing + 1",
        "let x = 1",
        "() => 1",
        "Promise.resolve(1)",
        "1n",
        "({ toJSON() {} })",
        "undefined",
      ]),
    ).toEqual([
      { code: "runtime", message: expect.stringMatching(/^ReferenceError: .*missing/) },
      { code: "syntax", message: expect.stringMatching(/^SyntaxError: /) },
      {
        code: "invalid_result",
        message: "The formula must produce text, a number, true or false, a list, or an object.",
      },
      {
        code: "invalid_result",
        message: "The formula must finish without waiting. Remove async and await.",
      },
      {
        code: "invalid_result",
        message: "The formula must produce text, a number, true or false, a list, or an object.",
      },
      { code: "invalid_result", message: "The formula produced a value that cannot be saved." },
      null,
    ]);
  });
});

describe("code steps", () => {
  it("return field values, record changes, and output for the executor", async () => {
    const result = await evaluator.runCode(
      scope,
      `
      const due = ctx.dateAdd(ctx.today(), 1, "week");
      return {
        set: { "Finished on": ctx.today(), Due: due },
        records: [
          { action: "add", collection: "Trip/Tasks", fields: { Name: "Book hotel for " + ctx.person.name } },
          { action: "change", collection: "Trip/Tasks", id: "record-7", fields: { Status: "Open" } },
        ],
        output: { total: ctx.sum(ctx.record.Price, ctx.total), tags: ctx.record.Tags },
      };`,
    );
    expect(result).toEqual({
      ok: true,
      value: {
        set: { "Finished on": "2026-09-24", Due: "2026-10-01" },
        records: [
          { action: "add", collection: "Trip/Tasks", fields: { Name: "Book hotel for Ana" } },
          {
            action: "change",
            collection: "Trip/Tasks",
            id: "record-7",
            fields: { Status: "Open" },
          },
        ],
        output: { total: 50, tags: ["trip", "urgent"] },
      },
    });
    expect(
      await evaluator.runCode(
        scope,
        "if (ctx.record.Status !== 'Done') return { set: { Status: 'Done' } };",
      ),
    ).toEqual({ ok: true, value: {} });
  });

  it("share one run's time budget with the formulas around them", async () => {
    const spent = { prepareMs: 0, runMs: 0 };
    expect(await evaluator.runCode(scope, "return { output: 1 };", spent)).toEqual({
      ok: true,
      value: { output: 1 },
    });
    expect(spent.runMs).toBeGreaterThan(0);
    const [formula] = await evaluator.evaluate(scope, [expression("1")], spent);
    expect(formula).toEqual({ ok: true, value: 1 });
    spent.runMs = AUTOMATION_LIMITS.requestMs;
    expect(await evaluator.evaluate(scope, [expression("1")], spent)).toEqual([
      { ok: false, error: runSpent },
    ]);
    expect(await evaluator.runCode(scope, "return {};", spent)).toEqual({
      ok: false,
      error: {
        code: "timeout",
        message: "The code did not run because the run took longer than 8 s.",
      },
    });
  });

  it("reject a result the executor cannot use", async () => {
    const invalid = async (source: string) => {
      const result = await evaluator.runCode(scope, source);
      return result.ok ? result.value : result.error;
    };
    expect(await invalid("return { sets: {} }")).toEqual({
      code: "invalid_result",
      message: expect.stringContaining('"sets"'),
    });
    expect(
      await invalid('return { records: [{ action: "change", collection: "Tasks", fields: {} }] }'),
    ).toEqual({ code: "invalid_result", message: expect.stringContaining("records.0.id") });
    expect(
      await invalid(
        'return { records: [{ action: "remove", collection: "Tasks", id: "a", fields: {} }] }',
      ),
    ).toEqual({ code: "invalid_result", message: expect.stringContaining("records.0.action") });
    expect(
      await invalid(
        'return { records: [{ action: "add", collection: "Tasks", table: "", fields: {} }] }',
      ),
    ).toEqual({ code: "invalid_result", message: expect.stringContaining("records.0.table") });
    expect(await invalid('return { set: { "": 1 } }')).toEqual({
      code: "invalid_result",
      message: expect.stringContaining("set"),
    });
    expect(await invalid("return 5")).toEqual({
      code: "invalid_result",
      message: expect.stringContaining("expected object"),
    });
    expect(await invalid("return (async () => ({}))()")).toEqual({
      code: "invalid_result",
      message: "The code must finish without waiting. Remove async and await.",
    });
  });
});

describe("limits", () => {
  it("stop a runaway formula and keep the worker", async () => {
    const started = threads.started;
    const [loop, next] = await evaluator.evaluate(scope, [
      expression("(() => { for (;;) {} })()"),
      expression("1 + 1"),
    ]);
    expect(loop).toEqual({
      ok: false,
      error: {
        code: "timeout",
        message: expect.stringContaining(`${AUTOMATION_LIMITS.formulaMs} ms`),
      },
    });
    expect(next).toEqual({ ok: true, value: 2 });
    expect(await value("record.Name")).toEqual({ ok: true, value: "Ana Lopez" });
    expect(threads.started).toBe(started);
  });

  it("stop memory use at the limit", async () => {
    const memory = {
      code: "memory",
      message: "The formula used more memory than it is allowed, so it stopped.",
    };
    const before = process.memoryUsage().rss;
    expect(
      await values([
        // Each allocation is under 16 MiB. Together they exceed the worker's capped memory.
        "(() => { const k = []; for (let i = 0; i < 2; i++) k.push(new Uint8Array(15e6).fill(1)); return k.length })()",
        "(() => { const k = []; for (let i = 0; i < 32; i++) k.push(new Uint8Array(1 << 20).fill(1)); return k.length })()",
        '"x".repeat(1 << 25).length',
        "new Array(1e7).fill(0).length",
        "(function f() { return f() })()",
        "new Uint8Array(12 << 20).fill(1).length",
      ]),
    ).toEqual([
      memory,
      memory,
      memory,
      memory,
      { code: "memory", message: "The formula nested its calls too deeply, so it stopped." },
      12 << 20,
    ]);
    expect(process.memoryUsage().rss - before).toBeLessThan(256 * 1024 * 1024);
    expect(
      await evaluator.runCode(scope, "const rows = []; for (;;) rows.push({ rows });"),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: "memory" }) });
    expect(await value('"x".repeat(1 << 20).length')).toEqual({ ok: true, value: 1 << 20 });
  });

  it("refuse source, scope, and results over their sizes", async () => {
    const tooLong = "1+".repeat(AUTOMATION_LIMITS.sourceBytes / 2) + "1";
    expect(await value(tooLong)).toEqual({
      ok: false,
      error: { code: "too_large", message: "The formula is longer than 64 KiB." },
    });
    expect(
      await evaluator.runCode(scope, `return {}; // ${"x".repeat(AUTOMATION_LIMITS.sourceBytes)}`),
    ).toEqual({
      ok: false,
      error: { code: "too_large", message: "The code is longer than 64 KiB." },
    });
    const large = { ...scope, record: { Notes: "x".repeat(AUTOMATION_LIMITS.scopeBytes) } };
    expect(await evaluator.evaluate(large, [expression("1"), expression("2")])).toEqual(
      Array.from({ length: 2 }, () => ({
        ok: false,
        error: {
          code: "too_large",
          message: "The record and step results are larger than 256 KiB.",
        },
      })),
    );
    expect(await value(`"x".repeat(${AUTOMATION_LIMITS.resultBytes})`)).toEqual({
      ok: false,
      error: { code: "too_large", message: "The formula produced more than 64 KiB." },
    });
    expect(await value(`"x".repeat(${AUTOMATION_LIMITS.resultBytes - 100})`)).toEqual({
      ok: true,
      value: "x".repeat(AUTOMATION_LIMITS.resultBytes - 100),
    });
  });

  it("stop work that finishes past its limit without an interrupt", async () => {
    // QuickJS checks its interrupt handler between bytecodes, not during native work such as converting a huge BigInt.
    // Each reading of this clock is 100 ms after the last, so the formula's result arrives at its limit.
    const stepping = () => {
      let readings = 0;
      return () => 100 * readings++;
    };
    const quickjs = await newQuickJS();
    expect(
      evaluateItem(quickjs, JSON.stringify(scope), expression("1 + 1"), stepping()).result,
    ).toEqual({
      ok: false,
      error: {
        code: "timeout",
        message:
          "The formula ran longer than 100 ms, so it stopped. Check it for a loop that never ends.",
      },
    });
    expect(evaluateItem(quickjs, JSON.stringify(scope), expression("1 + 1")).result).toEqual({
      ok: true,
      value: 2,
    });
  });

  // This stand-in worker never answers "hang", as a worker stuck in native work would not.
  const hanging = `for (const item of items) {
    if (item.source === "hang") return;
    reply({ kind: "result", result: { ok: true, value: item.source }, prepareMs: 0, runMs: 1 });
  }`;
  const stuck = {
    ok: false,
    error: {
      code: "timeout",
      message:
        "The formula ran longer than 100 ms, so it stopped. Check it for a loop that never ends.",
    },
  };

  it("replace a worker that stops answering and finish the run on a new one", async () => {
    await using worker = await standInWorker(hanging);
    const standIn = createAutomationEvaluator({ entryPath: worker.entryPath });
    const started = threads.started;
    try {
      expect(await standIn.evaluate(scope, ["hang", "a", "b"].map(expression))).toEqual([
        stuck,
        { ok: true, value: "a" },
        { ok: true, value: "b" },
      ]);
      expect(threads.started).toBe(started + 2);
    } finally {
      await standIn.close();
    }
  }, 60_000);
});

describe("memory between runs", () => {
  const marker = "dohc-marker-4111111111111111";
  const planted: AutomationScope = {
    ...scope,
    record: { Notes: marker.repeat(40) },
    bindings: { card: marker },
  };
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
  // New, resized, and transferred buffers must not expose a prior run.
  const probes = [
    `new Uint8Array(new ArrayBuffer(${size}))`,
    `(() => { const b = new ArrayBuffer(16, { maxByteLength: ${size} }); b.resize(${size}); return new Uint8Array(b); })()`,
    `new Uint8Array(new ArrayBuffer(16).transfer(${size}))`,
  ];

  it("gives no formula or code step a SharedArrayBuffer", async () => {
    expect(
      await values([
        "typeof SharedArrayBuffer",
        "Object.getOwnPropertyNames(globalThis).includes('SharedArrayBuffer')",
      ]),
    ).toEqual(["undefined", false]);
    expect(await evaluator.runCode(scope, "return { output: typeof SharedArrayBuffer };")).toEqual({
      ok: true,
      value: { output: "undefined" },
    });
  });

  it.each(probes)("keeps one run's data out of a later run's buffer: %s", async (probe) => {
    expect(await evaluator.runCode(planted, plant)).toEqual({ ok: true, value: { output: 4000 } });
    expect(await evaluator.runCode(scope, `return { output: ${find}(${probe}) };`)).toEqual({
      ok: true,
      value: { output: false },
    });
    // Formulas of one run share a memory; freed buffers still come back cleared.
    const [planting, found] = await evaluator.evaluate(planted, [
      expression(
        "(() => { const copies = []; for (let i = 0; i < 4000; i++) copies.push(record.Notes + i); return copies.length; })()",
      ),
      expression(`${find}(${probe})`),
    ]);
    expect([planting, found]).toEqual([
      { ok: true, value: 4000 },
      { ok: true, value: false },
    ]);
  });
});

describe("scope preparation", () => {
  beforeEach(() => {
    threads.started = 0;
  });

  it("has the worker refuse a scope it cannot turn into JSON or that nests too deeply, and keep serving", async () => {
    const worker = new Worker(
      fileURLToPath(new URL("../dist/automation-worker.mjs", import.meta.url)),
    );
    try {
      await once(worker, "message");
      const spent = { prepareMs: 0, runMs: 0 };
      worker.postMessage({
        kind: "evaluate",
        runId: 1,
        scope: { ...scope, record: { Bad: 1n } },
        items: [expression("1")],
        spent,
      });
      expect((await once(worker, "message"))[0]).toEqual({
        kind: "refused",
        message: "The automation scope must hold only JSON values.",
      });
      worker.postMessage({
        kind: "evaluate",
        runId: 2,
        scope: { ...scope, bindings: { rows: nested(65) } },
        items: [expression("1")],
        spent,
      });
      expect((await once(worker, "message"))[0]).toEqual({
        kind: "result",
        result: { ok: false, error: tooDeep },
        prepareMs: 0,
        runMs: 0,
      });
      worker.postMessage({
        kind: "evaluate",
        runId: 3,
        scope,
        items: [expression("1 + 1")],
        spent,
      });
      expect((await once(worker, "message"))[0]).toEqual({
        kind: "result",
        result: { ok: true, value: 2 },
        prepareMs: expect.any(Number),
        runMs: expect.any(Number),
      });
    } finally {
      await worker.terminate();
    }
  });

  it("refuses a scope nested too deeply before copying it", async () => {
    const fresh = createAutomationEvaluator();
    try {
      const cyclic: JsonObject = {};
      cyclic.self = cyclic;
      for (const deep of [
        { ...scope, bindings: { rows: nested(65) } },
        { ...scope, record: { Rows: nested(3000) } },
        { ...scope, record: cyclic },
      ]) {
        expect(await fresh.evaluate(deep, [expression("1"), expression("2")])).toEqual([
          { ok: false, error: tooDeep },
          { ok: false, error: tooDeep },
        ]);
      }
      expect(threads.started).toBe(0);
      expect(
        await fresh.evaluate(
          { ...scope, bindings: { rows: nested(64) }, record: { Rows: nested(64) } },
          [expression("rows.flat(Infinity)[0] + record.Rows.flat(Infinity)[0]")],
        ),
      ).toEqual([{ ok: true, value: 2 }]);
    } finally {
      await fresh.close();
    }
  });

  it("counts escaped UTF-8 bytes of keys and strings at the size limit", async () => {
    const fresh = createAutomationEvaluator();
    try {
      // Quotes, backslashes, and control characters are escaped; a lone surrogate is written as six bytes.
      const tricky: JsonObject = {
        'é"\n\u0001😀': '\u0000\u001f\t\\"é€😀\u2028\ud800',
        [`key${"\u0000".repeat(10)}`]: ["\ud83d", "\udc00", "x\u007f"],
      };
      const sized = (padding: number): AutomationScope => ({
        ...scope,
        record: { ...tricky, Notes: "x".repeat(padding) },
      });
      const bytes = (input: AutomationScope) => Buffer.byteLength(JSON.stringify(input));
      const padding = AUTOMATION_LIMITS.scopeBytes - bytes(sized(0));
      expect(bytes(sized(padding))).toBe(AUTOMATION_LIMITS.scopeBytes);
      expect(await fresh.evaluate(sized(padding + 1), [expression("1")])).toEqual([
        { ok: false, error: tooLarge },
      ]);
      // 150,000 NUL characters serialize to 900 KB.
      expect(
        await fresh.evaluate({ ...scope, record: { Notes: "\u0000".repeat(150_000) } }, [
          expression("1"),
        ]),
      ).toEqual([{ ok: false, error: tooLarge }]);
      expect(
        await fresh.evaluate({ ...scope, record: { ["\u0000".repeat(50_000)]: 1 } }, [
          expression("1"),
        ]),
      ).toEqual([{ ok: false, error: tooLarge }]);
      expect(threads.started).toBe(0);
      expect(
        await fresh.evaluate(sized(padding), [expression('Object.keys(record).join("|").length')]),
      ).toEqual([{ ok: true, value: Object.keys(sized(padding).record!).join("|").length }]);
    } finally {
      await fresh.close();
    }
  });

  it("runs a request's items until one of its time budgets is spent", () => {
    const answer = (
      spent: { prepareMs: number; runMs: number },
      count: number,
      timing: { prepareMs: number; runMs: number },
    ) => {
      const ran: number[] = [],
        replies: AutomationWorkerReply[] = [];
      const items = Array.from({ length: count }, (_, index) => expression(String(index)));
      answerItems(
        items,
        spent,
        (item) => {
          ran.push(Number((item as { source: string }).source));
          return { result: { ok: true, value: 1 }, ...timing };
        },
        (reply) => replies.push(reply),
      );
      return {
        ran,
        results: replies.map((reply) => (reply.kind === "result" ? reply.result : reply)),
      };
    };
    // Reading the scope takes 1 s for each formula. It does not count toward the 100 ms the formulas have left to run.
    const reading = answer({ prepareMs: 0, runMs: AUTOMATION_LIMITS.requestMs - 100 }, 10, {
      prepareMs: 1000,
      runMs: 1,
    });
    expect(reading.ran).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(reading.results).toEqual([
      ...Array.from({ length: 8 }, () => ({ ok: true, value: 1 })),
      { ok: false, error: readSpent },
      { ok: false, error: readSpent },
    ]);
    // Running takes 50 ms for each formula, so the third starts after the 8 s of running.
    const running = answer({ prepareMs: 0, runMs: AUTOMATION_LIMITS.requestMs - 100 }, 4, {
      prepareMs: 1,
      runMs: 50,
    });
    expect(running.ran).toEqual([0, 1]);
    expect(running.results).toEqual([
      { ok: true, value: 1 },
      { ok: true, value: 1 },
      { ok: false, error: runSpent },
      { ok: false, error: runSpent },
    ]);
  });

  it("times out reading a scope that finishes after its limit", async () => {
    const quickjs = await newQuickJS();
    // The clock reads 0 when the item starts and 10 s after that, as if reading the scope took 10 s without an interrupt.
    const jumping = () => {
      let readings = 0;
      return () => (readings++ === 0 ? 0 : 10_000);
    };
    const late = {
      code: "timeout",
      message: `Reading the record and step results took longer than ${AUTOMATION_LIMITS.prepareMs} ms.`,
    };
    expect(
      evaluateItem(quickjs, JSON.stringify(scope), expression("1 + 1"), jumping()).result,
    ).toEqual({ ok: false, error: late });
    expect(evaluateItem(quickjs, "not JSON", expression("1"), jumping()).result).toEqual({
      ok: false,
      error: late,
    });
    // The same instance still works, so the timeouts released their QuickJS values.
    expect(evaluateItem(quickjs, JSON.stringify(scope), expression("1 + 1")).result).toEqual({
      ok: true,
      value: 2,
    });
    expect(evaluateItem(quickjs, "not JSON", expression("1")).result).toEqual({
      ok: false,
      error: {
        code: "too_large",
        message: "The record and step results are too large or too deeply nested to read.",
      },
    });
  });
});

describe("evaluator lifetime", () => {
  beforeEach(() => {
    threads.started = 0;
    threads.terminated = 0;
    threads.sent.length = 0;
  });

  it("sends an immutable scope once per run and ends it before the next queued run", async () => {
    const fresh = createAutomationEvaluator();
    const input = { ...scope, record: { Name: "First" } };
    const formulas: AutomationFormula[] = [
      expression("true"),
      { ...expression("record.Name"), when: [{ index: 0, truthy: true }] },
    ];
    try {
      const first = fresh.evaluate(input, formulas);
      input.record.Name = "Second";
      const second = fresh.evaluate(input, formulas);
      expect(await first).toEqual([
        { ok: true, value: true },
        { ok: true, value: "First" },
      ]);
      expect(await second).toEqual([
        { ok: true, value: true },
        { ok: true, value: "Second" },
      ]);
      expect(threads.sent).toEqual([
        { kind: "evaluate", runId: 1, hasScope: true },
        { kind: "evaluate", runId: 1, hasScope: false },
        { kind: "end", runId: 1, hasScope: false },
        { kind: "evaluate", runId: 2, hasScope: true },
        { kind: "evaluate", runId: 2, hasScope: false },
        { kind: "end", runId: 2, hasScope: false },
      ]);
    } finally {
      await fresh.close();
    }
  });

  it("terminates a prepared guarded run on close and rejects queued work", async () => {
    await using worker = await standInWorker(`
      if (items[0].source === "predicate") reply({ kind: "result", result: { ok: true, value: true }, prepareMs: 0, runMs: 0 });
    `);
    const fresh = createAutomationEvaluator(worker);
    const running = fresh.evaluate(scope, [
      expression("predicate"),
      { ...expression("hang"), when: [{ index: 0, truthy: true }] },
    ]);
    const queued = fresh.evaluate(scope, [expression("next")]);
    const stopped = Promise.allSettled([running, queued]);
    await vi.waitFor(() =>
      expect(threads.sent.some((message) => message.kind === "evaluate" && !message.hasScope)).toBe(
        true,
      ),
    );
    await fresh.close();
    expect((await stopped).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(threads.terminated).toBe(1);
  });

  it("returns busy for every item when 16 runs are already waiting", async () => {
    const waiting = Array.from({ length: 16 }, (_, index) => value(`${index}`));
    const busy = {
      ok: false,
      error: {
        code: "busy",
        message: "The evaluator already has 16 runs waiting. Try this run again later.",
      },
    };
    expect(await value("16")).toEqual(busy);
    expect(
      await evaluator.evaluate(scope, [
        expression("1"),
        expression("1".repeat(AUTOMATION_LIMITS.sourceBytes + 1)),
      ]),
    ).toEqual([busy, busy]);
    const oversized = { ...scope, record: { Notes: "x".repeat(AUTOMATION_LIMITS.scopeBytes) } };
    expect(await evaluator.evaluate(oversized, [expression("1"), expression("2")])).toEqual([
      busy,
      busy,
    ]);
    // A turned-away request does not read its scope, so invalid input is busy too.
    const reads: PropertyKey[] = [];
    const untouched = new Proxy(
      {},
      {
        get: (_target, key) => {
          reads.push(key);
          throw new Error("The scope was read.");
        },
        has: (_target, key) => {
          reads.push(key);
          return false;
        },
        ownKeys: () => {
          reads.push("ownKeys");
          return [];
        },
        getPrototypeOf: () => {
          reads.push("getPrototypeOf");
          return null;
        },
      },
    ) as AutomationScope;
    expect(await evaluator.evaluate(untouched, [expression("1"), expression("2")])).toEqual([
      busy,
      busy,
    ]);
    expect(await evaluator.runCode(untouched, "return {};")).toEqual(busy);
    const formula = new Proxy(
      {},
      {
        get: (_target, key) => {
          reads.push(key);
          throw new Error("The formula was read.");
        },
        has: (_target, key) => {
          reads.push(key);
          return false;
        },
        getPrototypeOf: () => {
          reads.push("getPrototypeOf");
          return null;
        },
      },
    ) as AutomationFormula;
    expect(
      await evaluator.evaluate(untouched, [
        formula,
        { kind: "bogus" } as unknown as AutomationFormula,
      ]),
    ).toEqual([busy, busy]);
    expect(
      await evaluator.evaluate(
        scope,
        Array.from({ length: AUTOMATION_LIMITS.formulasPerBatch + 1 }, () => formula),
      ),
    ).toEqual(Array.from({ length: AUTOMATION_LIMITS.formulasPerBatch + 1 }, () => busy));
    expect(await evaluator.runCode(untouched, 42 as unknown as string)).toEqual(busy);
    expect(reads).toEqual([]);
    expect(
      await evaluator.evaluate(
        { ...scope, now: "not a time", record: { Bad: 1n as unknown as JsonValue } },
        [expression("1")],
      ),
    ).toEqual([busy]);
    expect(await Promise.all(waiting)).toEqual(
      Array.from({ length: 16 }, (_, index) => ({ ok: true, value: index })),
    );
    expect(await value("16")).toEqual({ ok: true, value: 16 });
  });

  it("fails one item for a reply it cannot read, and moves on after a worker asks to restart", async () => {
    // The worker wrapper delivers messageerror for this marker; nesting limits vary across Node versions.
    await using worker = await standInWorker(`for (const item of items) {
      if (item.source === "unreadable") {
        reply({ testUnreadableReply: true });
      } else if (item.source === "restart") {
        return reply({ kind: "result", result: { ok: false, error: { code: "memory", message: "Broken." } }, restart: true });
      } else reply({ kind: "result", result: { ok: true, value: item.source } });
    }`);
    const standIn = createAutomationEvaluator({ entryPath: worker.entryPath });
    try {
      expect(
        await standIn.evaluate(scope, ["a", "unreadable", "b", "restart", "c"].map(expression)),
      ).toEqual([
        { ok: true, value: "a" },
        {
          ok: false,
          error: {
            code: "invalid_result",
            message: "The formula produced a value that cannot be read.",
          },
        },
        { ok: true, value: "b" },
        { ok: false, error: { code: "memory", message: "Broken." } },
        { ok: true, value: "c" },
      ]);
      expect(threads.started).toBe(2);
    } finally {
      await standIn.close();
    }
  });
});
