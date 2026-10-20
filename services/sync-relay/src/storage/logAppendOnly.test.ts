import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";

// A first-open preparation's cutoff is its workspace log's highest relay
// sequence, and the writer publishes while that head is unchanged. That treats
// every row the preparation did not read as absent, which holds only while the
// log is append-only: each row gets a relay sequence SQLite assigns above every
// earlier one, no row is rewritten, and AUTOINCREMENT's counter never moves back.
// This is a text scan of production SQL for the ways to break that, not a proof
// about the SQL that runs: it cannot see a table name built at run time, SQL
// read from elsewhere, or a statement split across string pieces.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Fixtures run as relay processes, so only tests and their helpers are skipped.
const NOT_PRODUCTION = /(\.test|\.test-helper)\.ts$/;
// The log table, quoted or not, alone or under a schema such as `main`.
const quoted = (name: string) => String.raw`(?:["\x60\[]${name}["\x60\]]|${name})`;
const TABLE = (name: string) => String.raw`(?:${quoted(String.raw`\w+`)}\s*\.\s*)?${quoted(name)}(?![\w])`;
const LOG = TABLE("sync_relay_log"), SEQUENCE = TABLE("sqlite_sequence");
const INSERT = String.raw`\b(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+${LOG}`;
const FORBIDDEN: Array<[string, RegExp]> = [
  ["rewrites log rows", new RegExp(String.raw`\bUPDATE\s+(?:OR\s+\w+\s+)?${LOG}`, "gi")],
  // With no column list, every column is written, the relay sequence included.
  ["chooses a log row's relay sequence", new RegExp(String.raw`${INSERT}(?:(?!\s*\()|\s*\([^)]*\brelay_seq\b)`, "gi")],
  // An upsert rewrites the row it conflicts with.
  ["upserts log rows", new RegExp(String.raw`${INSERT}[^;\x60]*?\bON\s+CONFLICT\b[^;\x60]*?\bDO\s+UPDATE\b`, "gi")],
  ["writes SQLite's AUTOINCREMENT counters", new RegExp(String.raw`\b(?:UPDATE\s+(?:OR\s+\w+\s+)?|INTO\s+|DELETE\s+FROM\s+)${SEQUENCE}`, "gi")],
];

function productionSources(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "testing" ? [] : productionSources(path);
    return entry.name.endsWith(".ts") && !NOT_PRODUCTION.test(entry.name) ? [path] : [];
  });
}
const findings = (text: string) => FORBIDDEN.flatMap(([rule, pattern]) => [...text.matchAll(pattern)].map(match => ({rule, match: match[0], index: match.index})));

it("keeps the relay log append-only in production code", () => {
  const sources = productionSources(ROOT), names = sources.map(path => relative(ROOT, path).replaceAll("\\", "/"));
  expect(names).toContain("storage/log.ts");
  expect(names).toContain("relayDeploymentCrash.fixture.ts");
  const found = sources.flatMap(path => {
    const text = readFileSync(path, "utf8");
    return findings(text).map(({rule, match, index}) => `${relative(ROOT, path)}:${text.slice(0, index).split("\n").length} ${rule}: ${match}`);
  });
  expect(found).toEqual([]);
});

it("finds each forbidden shape however the table is named", () => {
  const rules = (sql: string) => findings(sql).map(({rule}) => rule);
  for (const table of ["sync_relay_log", "main.sync_relay_log", "\"sync_relay_log\"", "`sync_relay_log`", "[sync_relay_log]", "\"main\".\"sync_relay_log\"", "main . [sync_relay_log]"]) {
    expect(rules(`UPDATE ${table} SET payload_json='{}'`), table).toEqual(["rewrites log rows"]);
    expect(rules(`INSERT INTO ${table} VALUES (1)`), table).toEqual(["chooses a log row's relay sequence"]);
    expect(rules(`INSERT OR REPLACE INTO ${table}(relay_seq,workspace_id) VALUES (1,'w')`), table).toEqual(["chooses a log row's relay sequence"]);
    expect(rules(`INSERT INTO ${table}(workspace_id,origin_id) VALUES ('w','o') ON CONFLICT(workspace_id,origin_id,origin_seq) DO UPDATE SET payload_json=excluded.payload_json`), table)
      .toEqual(["upserts log rows"]);
  }
  for (const table of ["sqlite_sequence", "main.sqlite_sequence", "\"sqlite_sequence\""]) {
    expect(rules(`UPDATE ${table} SET seq=0`), table).toEqual(["writes SQLite's AUTOINCREMENT counters"]);
    expect(rules(`DELETE FROM ${table}`), table).toEqual(["writes SQLite's AUTOINCREMENT counters"]);
  }
  // What append and the readers do.
  expect(rules("INSERT INTO sync_relay_log (workspace_id, origin_id) VALUES (?, ?)")).toEqual([]);
  expect(rules("INSERT INTO sync_relay_log_other (relay_seq) VALUES (1)")).toEqual([]);
  expect(rules("INSERT INTO sync_relay_log(workspace_id) VALUES (?) ON CONFLICT DO NOTHING")).toEqual([]);
  expect(rules("SELECT relay_seq FROM sync_relay_log")).toEqual([]);
});
