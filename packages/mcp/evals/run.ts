// Runs the tool-use eval. README.md has the flags, what a run uses, and how to add a case.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDohcMcpServer } from "../src/server";
import type { Check, EvalCase, RecordedCall } from "./case";
import { CASES } from "./cases";
import { claudeArguments, runClaudeSample, type SampleUsage } from "./claude";
import { casePasses, grade } from "./grade";
import { readOptions, USAGE, type RunOptions } from "./options";

const SAMPLE_TIMEOUT_MS = 300_000;

interface ResultRow {
  case: string;
  kind: EvalCase["kind"];
  model: string;
  sample: number;
  /** Absent when the sample ended as an error. */
  pass?: boolean;
  error?: string;
  checks?: Check[];
  calls?: RecordedCall[];
  text?: string;
  usage: SampleUsage;
  harness?: string;
  /** `session` when the sample kept the enclosing session's route to the model. */
  route: "sign-in" | "session";
}

/** What the model reads of every tool: the bytes T3 Code's context budget counts the same way. */
async function toolListBytes(): Promise<{ tools: number; bytes: number }> {
  const server = createDohcMcpServer({ root: "/eval-context", home: "/eval-context" });
  const client = new Client({ name: "eval-context", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  const seen = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return { tools: tools.length, bytes: Buffer.byteLength(JSON.stringify(seen)) };
}

async function sample(evalCase: EvalCase, model: string, index: number, keepSessionRoute: boolean): Promise<ResultRow> {
  const base = { case: evalCase.id, kind: evalCase.kind, model, sample: index, route: keepSessionRoute ? "session" as const : "sign-in" as const };
  const outcome = await runClaudeSample({ evalCase, model, timeoutMs: SAMPLE_TIMEOUT_MS, keepSessionRoute });
  const harness = outcome.harness ? { harness: outcome.harness } : {};
  if (!outcome.run) return { ...base, ...harness, error: outcome.error ?? "unknown error", usage: outcome.usage };
  const checks = grade(evalCase.expect, outcome.run);
  return { ...base, ...harness, pass: checks.every((check) => check.pass), checks, calls: outcome.run.calls, text: outcome.run.text, usage: outcome.usage };
}

/** Two samples, and a third when they disagree. */
async function runCase(evalCase: EvalCase, model: string, samples: number, keepSessionRoute: boolean, record: (row: ResultRow) => Promise<void>): Promise<ResultRow[]> {
  const rows: ResultRow[] = [];
  for (let index = 1; index <= samples; index += 1) {
    const row = await sample(evalCase, model, index, keepSessionRoute);
    rows.push(row);
    await record(row);
  }
  const graded = rows.filter((row) => row.pass !== undefined);
  if (samples === 2 && graded.length === 2 && graded[0]!.pass !== graded[1]!.pass) {
    const row = await sample(evalCase, model, 3, keepSessionRoute);
    rows.push(row);
    await record(row);
  }
  return rows;
}

function passCounts(rows: readonly ResultRow[]): Map<string, { passed: number; graded: number }> {
  const counts = new Map<string, { passed: number; graded: number }>();
  for (const row of rows) {
    if (row.pass === undefined) continue;
    const count = counts.get(row.case) ?? { passed: 0, graded: 0 };
    count.graded += 1;
    if (row.pass) count.passed += 1;
    counts.set(row.case, count);
  }
  return counts;
}

function summary(input: { model: string; cases: readonly EvalCase[]; rows: readonly ResultRow[]; baseline: readonly ResultRow[] | undefined; context: { tools: number; bytes: number } }): { text: string; regressions: string[] } {
  const counts = passCounts(input.rows);
  const before = input.baseline ? passCounts(input.baseline.filter((row) => row.model === input.model)) : undefined;
  const regressions: string[] = [];
  const lines = [
    `# Tool-use eval: ${input.model}`,
    "",
    `Harness: ${[...new Set(input.rows.map((row) => row.harness).filter(Boolean))].join(", ") || "unknown"}.`,
    ...(input.rows.some((row) => row.route === "session")
      ? ["", "These samples kept the enclosing session's route to the model. A proxy on that route can rename tools, so compare this run only with runs made the same way."]
      : []),
    `The tool list is ${input.context.tools} tools and ${input.context.bytes.toLocaleString("en-US")} bytes.`,
    "",
    `| Case | Kind | ${before ? "Baseline | " : ""}Passed | Verdict |`,
    `| --- | --- | ${before ? "--- | " : ""}--- | --- |`,
  ];
  for (const evalCase of input.cases) {
    const count = counts.get(evalCase.id);
    const rows = input.rows.filter((row) => row.case === evalCase.id);
    const verdict = !count ? "error" : casePasses(rows.filter((row) => row.pass !== undefined).map((row) => row.pass === true)) ? "pass" : "FAIL";
    const earlier = before?.get(evalCase.id);
    // A case that passed every baseline sample and fails now is a regression.
    if (earlier && earlier.graded > 0 && earlier.passed === earlier.graded && verdict === "FAIL") regressions.push(evalCase.id);
    const baselineCell = before ? `${earlier ? `${earlier.passed}/${earlier.graded}` : "none"} | ` : "";
    lines.push(`| ${evalCase.id} | ${evalCase.kind} | ${baselineCell}${count ? `${count.passed}/${count.graded}` : "0/0"} | ${verdict} |`);
  }
  const failed = input.rows.filter((row) => row.pass === false);
  if (failed.length > 0) {
    lines.push("", "## Failed samples", "");
    for (const row of failed) {
      lines.push(`- ${row.case}, sample ${row.sample}: ${row.checks!.filter((check) => !check.pass).map((check) => check.name + (check.detail ? ` (${check.detail})` : "")).join("; ")}`);
    }
  }
  const errors = input.rows.filter((row) => row.error !== undefined);
  if (errors.length > 0) {
    lines.push("", "## Errors", "", "These samples could not be graded and are left out of every pass count.", "");
    for (const row of errors) lines.push(`- ${row.case}, sample ${row.sample}: ${row.error}`);
  }
  if (regressions.length > 0) lines.push("", `Regressions against the baseline: ${regressions.join(", ")}.`);
  const cost = input.rows.reduce((total, row) => total + row.usage.costUsd, 0);
  const tokens = input.rows.reduce((total, row) => total + row.usage.inputTokens + row.usage.outputTokens, 0);
  lines.push(
    "",
    `${input.rows.length} samples used ${tokens.toLocaleString("en-US")} tokens, which is $${cost.toFixed(2)} at API prices. A subscription run is not billed this amount.`,
    "",
  );
  return { text: lines.join("\n"), regressions };
}

async function main(argv: readonly string[]): Promise<number> {
  let options: RunOptions;
  try {
    options = readOptions(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
    return 1;
  }
  const context = await toolListBytes();
  if (options.context) {
    process.stdout.write(`${context.tools} tools, ${context.bytes} bytes of names, descriptions, and input schemas\n`);
    return 0;
  }
  const wanted = options.cases;
  const cases = wanted ? CASES.filter((evalCase) => wanted.includes(evalCase.id)) : CASES;
  const unknown = (wanted ?? []).filter((id) => !CASES.some((evalCase) => evalCase.id === id));
  if (unknown.length > 0) {
    process.stderr.write(`no case named ${unknown.join(", ")}; cases: ${CASES.map((evalCase) => evalCase.id).join(", ")}\n`);
    return 1;
  }
  const { model, samples, keepSessionRoute } = options;
  if (options.dryRun) {
    for (const evalCase of cases) {
      process.stdout.write(`${evalCase.id}\n  claude ${claudeArguments({ prompt: evalCase.prompt, model, mcpConfigPath: "<mcp.json>" }).map((part) => JSON.stringify(part)).join(" ")}\n`);
    }
    return 0;
  }
  if (!options.out) {
    process.stderr.write(`--out takes a folder for the run's results\n${USAGE}\n`);
    return 1;
  }
  const baseline = options.baseline
    ? (await readFile(options.baseline, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as ResultRow)
    : undefined;

  await mkdir(options.out, { recursive: true });
  const resultsPath = join(options.out, "results.jsonl");
  await writeFile(resultsPath, "");
  const rows: ResultRow[] = [];
  const record = async (row: ResultRow): Promise<void> => {
    rows.push(row);
    await appendFile(resultsPath, `${JSON.stringify(row)}\n`);
    process.stdout.write(`${row.case} #${row.sample}: ${row.error ? `error: ${row.error}` : row.pass ? "pass" : "FAIL"}\n`);
  };
  const queue = [...cases];
  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    for (let evalCase = queue.shift(); evalCase; evalCase = queue.shift()) await runCase(evalCase, model, samples, keepSessionRoute, record);
  }));

  const report = summary({ model, cases, rows, baseline, context });
  await writeFile(join(options.out, "summary.md"), report.text);
  process.stdout.write(`\n${report.text}`);
  return report.regressions.length > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
