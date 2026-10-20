import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";

// A first-open preparation's cutoff is its workspace log's highest relay
// sequence, and the writer publishes while that head is unchanged. That treats
// every row the preparation did not read as absent, which holds only while the
// log is append-only: each row gets a relay sequence SQLite assigns above every
// earlier one, no row is rewritten, and AUTOINCREMENT's counter never moves back.
// This scans production SQL for the three ways to break that. SQL that names
// its table at run time is beyond what it can see.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOT_PRODUCTION = /(\.test|\.test-helper|\.fixture|TestFixture)\.ts$/;
const LOG = String.raw`(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+["\x60]?sync_relay_log\b`;
const FORBIDDEN: Array<[string, RegExp]> = [
  ["rewrites log rows", /\bUPDATE\s+(?:OR\s+\w+\s+)?["`]?sync_relay_log\b/gi],
  // With no column list, every column is written, the relay sequence included.
  ["chooses a log row's relay sequence", new RegExp(String.raw`\b${LOG}(?:(?![\s"\x60]*\()|["\x60]?\s*\([^)]*\brelay_seq\b)`, "gi")],
  ["writes SQLite's AUTOINCREMENT counters", /\b(?:UPDATE\s+(?:OR\s+\w+\s+)?|INTO\s+|DELETE\s+FROM\s+)["`]?sqlite_sequence\b/gi],
];

function productionSources(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "testing" ? [] : productionSources(path);
    return entry.name.endsWith(".ts") && !NOT_PRODUCTION.test(entry.name) ? [path] : [];
  });
}

it("keeps the relay log append-only in production code", () => {
  const sources = productionSources(ROOT);
  expect(sources.map(path => relative(ROOT, path).replaceAll("\\", "/"))).toContain("storage/log.ts");
  const found = sources.flatMap(path => {
    const text = readFileSync(path, "utf8");
    return FORBIDDEN.flatMap(([rule, pattern]) => [...text.matchAll(pattern)].map(match =>
      `${relative(ROOT, path)}:${text.slice(0, match.index).split("\n").length} ${rule}: ${match[0]}`));
  });
  expect(found).toEqual([]);
});
