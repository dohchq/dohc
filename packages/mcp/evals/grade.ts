// Grades one run against a case's expectations. Plain logic with no model in it, so
// grade.test.ts can prove each check fails when it should.

import type { CallMatch, Check, Expectation, RecordedCall, RunRecord } from "./case";

function valueAt(args: Record<string, unknown>, dottedKey: string): unknown {
  let value: unknown = args;
  for (const key of dottedKey.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Whether a call's arguments match. Keys may be dotted paths. `null` matches a missing key,
 * `*` matches any key that is present, `~text` matches a string that contains the text in
 * any letter case, and any other value matches when its JSON is equal.
 */
export function matchesArgs(args: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, want]) => {
    const got = valueAt(args, key);
    if (want === null) return got === undefined;
    if (want === "*") return got !== undefined;
    if (typeof want === "string" && want.startsWith("~")) {
      return typeof got === "string" && got.toLowerCase().includes(want.slice(1).toLowerCase());
    }
    return JSON.stringify(got) === JSON.stringify(want);
  });
}

/** A tool name that ends in `*` matches every tool that starts with the rest, so `dohc_*` is every dohc tool. */
function matchesTool(tool: string, wanted: string): boolean {
  return wanted.endsWith("*") ? tool.startsWith(wanted.slice(0, -1)) : tool === wanted;
}

function matchesCall(call: RecordedCall, match: CallMatch): boolean {
  return matchesTool(call.tool, match.tool)
    && (match.ok === undefined || call.ok === match.ok)
    && (match.args === undefined || matchesArgs(call.args, match.args));
}

function describe(match: CallMatch): string {
  const args = match.args ? ` ${JSON.stringify(match.args)}` : "";
  const outcome = match.ok === undefined ? "" : match.ok ? " that succeeded" : " that was refused";
  return `${match.tool}${args}${outcome}`;
}

export function grade(expect: Expectation, run: RunRecord): Check[] {
  const checks: Check[] = [];
  const called = run.calls.map((call) => call.tool).join(", ") || "no tools";

  for (const match of expect.calls ?? []) {
    const pass = run.calls.some((call) => matchesCall(call, match));
    checks.push({ name: `calls ${describe(match)}`, pass, ...(pass ? {} : { detail: `called: ${called}` }) });
  }

  for (const entry of expect.notCalls ?? []) {
    const match = typeof entry === "string" ? { tool: entry } : entry;
    const hit = run.calls.find((call) => matchesCall(call, match));
    checks.push({
      name: `does not call ${describe(match)}`,
      pass: hit === undefined,
      ...(hit ? { detail: `called with ${JSON.stringify(hit.args)}` } : {}),
    });
  }

  if (expect.order) {
    let next = 0;
    for (const call of run.calls) if (call.tool === expect.order[next]) next += 1;
    const pass = next === expect.order.length;
    checks.push({ name: `calls in order ${expect.order.join(", ")}`, pass, ...(pass ? {} : { detail: `called: ${called}` }) });
  }

  for (const [tool, most] of Object.entries(expect.maxCalls ?? {})) {
    const count = run.calls.filter((call) => call.tool === tool).length;
    checks.push({ name: `calls ${tool} at most ${most} times`, pass: count <= most, ...(count <= most ? {} : { detail: `called ${count} times` }) });
  }

  for (const pattern of expect.text ?? []) {
    checks.push({ name: `answer matches /${pattern}/`, pass: new RegExp(pattern, "i").test(run.text) });
  }
  for (const pattern of expect.notText ?? []) {
    checks.push({ name: `answer does not match /${pattern}/`, pass: !new RegExp(pattern, "i").test(run.text) });
  }

  for (const [path, want] of Object.entries(expect.files ?? {})) {
    const content = run.files[path];
    if (want.absent) {
      checks.push({ name: `${path} does not exist`, pass: content === undefined });
      continue;
    }
    for (const text of want.contains ?? []) {
      checks.push({ name: `${path} contains ${JSON.stringify(text)}`, pass: content !== undefined && content.includes(text) });
    }
    for (const text of want.lacks ?? []) {
      checks.push({ name: `${path} lacks ${JSON.stringify(text)}`, pass: content !== undefined && !content.includes(text) });
    }
    for (const [text, times] of Object.entries(want.times ?? {})) {
      const found = content === undefined ? -1 : content.split(text).length - 1;
      checks.push({ name: `${path} has ${JSON.stringify(text)} ${times} times`, pass: found === times, ...(found === times ? {} : { detail: `found ${Math.max(found, 0)}` }) });
    }
  }

  return checks;
}

/** A case passes when more than half of its graded samples pass. */
export function casePasses(samplePasses: readonly boolean[]): boolean {
  return samplePasses.filter(Boolean).length * 2 > samplePasses.length;
}
