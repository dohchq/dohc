import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

const KEYS = ["bundle", "manifest", "node"];

/**
 * Accepts DOHC_ENGINE_READER_CONFIG only as the engine does: exactly these keys,
 * each an absolute path, here also to a file. The engine only warns about a config
 * it rejects. The returned config drops duplicate keys, which JSON.parse merges
 * but the engine rejects.
 */
export function checkReaderConfig(value: string | undefined): { config: string } | { problem: string } {
  if (value === undefined) return { problem: "DOHC_ENGINE_READER_CONFIG is not set" };
  let config: unknown;
  try { config = JSON.parse(value); } catch { config = undefined; }
  if (typeof config !== "object" || config === null || Object.keys(config).sort().join() !== KEYS.join()) {
    return { problem: "DOHC_ENGINE_READER_CONFIG is not a JSON object with only node, bundle and manifest" };
  }
  for (const key of KEYS) {
    const path: unknown = Reflect.get(config, key);
    if (typeof path !== "string" || !isAbsolute(path)) return { problem: `DOHC_ENGINE_READER_CONFIG's ${key} is not an absolute path` };
    let file = false;
    try { file = statSync(path).isFile(); } catch { /* not a file */ }
    if (!file) return { problem: `DOHC_ENGINE_READER_CONFIG's ${key} names no file: ${path}` };
  }
  return { config: JSON.stringify(config) };
}
