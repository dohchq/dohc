import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Small files still cost time without rounding them up to a full second.
export const MIN_TASK_SECONDS = 0.05;

export function refreshShardTimes(records, current = {}) {
  const samples = new Map();
  for (const record of records) {
    if (record.scope !== "js" || record.verdict !== "PASS" || !Array.isArray(record.tests))
      throw new Error("Expected a passing JavaScript result.");
    const measured = [
      ...record.tests.map(({ id, seconds }) => ({
        key: Object.hasOwn(current, id) ? id : id.replace(/^vitest:[^:]+:[^:]*:/u, ""),
        seconds,
      })),
      ...(record.steps ?? [])
        .filter(
          ({ name }) =>
            Object.hasOwn(current, name) ||
            /^(?:node:|typecheck:|repository:|desktop:|self-host-native:|accounts$)/u.test(name),
        )
        .map(({ name, seconds }) => ({ key: name, seconds })),
    ];
    for (const { key, seconds } of measured) {
      if (!Number.isFinite(seconds) || seconds < 0)
        throw new Error(`Invalid measured seconds for ${key}.`);
      const values = samples.get(key) ?? [];
      values.push(seconds);
      samples.set(key, values);
    }
  }
  const weights = { ...current };
  for (const [key, values] of samples) {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    weights[key] = Math.max(MIN_TASK_SECONDS, Math.round(median * 1000) / 1000);
  }
  return Object.fromEntries(Object.entries(weights).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const paths = process.argv.slice(2);
  if (!paths.length) throw new Error("Supply one or more js-result.json paths.");
  const output = new URL("./shard-times.json", import.meta.url);
  const records = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
  const weights = refreshShardTimes(records, JSON.parse(readFileSync(output, "utf8")));
  writeFileSync(output, JSON.stringify(weights, null, 2) + "\n");
}
