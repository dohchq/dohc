// The eval's command line. A run spends model quota, so a flag that is misspelled, missing
// its value, or not a positive whole number stops the run instead of falling back to a default.

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_CODEX_MODEL = "gpt-6.2-sol";

export const USAGE =
  "usage: pnpm eval --out <folder> [--harness claude|codex] [--suite tool-use|everyday|all] [--skill <file>] [--model <id>] [--case <ids>] [--samples <n>] [--concurrency <n>] [--baseline <results.jsonl>] [--keep-session-route] [--dry-run] [--context]";

export type EvalHarness = "claude" | "codex";
export type SuiteSelection = "tool-use" | "everyday" | "all";

export interface RunOptions {
  out?: string;
  harness: EvalHarness;
  suite: SuiteSelection;
  skill?: string;
  model: string;
  cases?: string[];
  samples: number;
  concurrency: number;
  baseline?: string;
  keepSessionRoute: boolean;
  dryRun: boolean;
  context: boolean;
}

const VALUE_FLAGS = [
  "--out",
  "--harness",
  "--suite",
  "--skill",
  "--model",
  "--case",
  "--samples",
  "--concurrency",
  "--baseline",
] as const;
const SWITCHES = ["--keep-session-route", "--dry-run", "--context"] as const;

function count(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} takes a whole number of 1 or more`);
  return Number(value);
}

function harnessSelection(value: string | undefined): EvalHarness {
  if (value === undefined) return "claude";
  if (value === "claude" || value === "codex") return value;
  throw new Error("--harness takes claude or codex");
}

function suiteSelection(value: string | undefined): SuiteSelection {
  if (value === undefined) return "tool-use";
  if (value === "tool-use" || value === "everyday" || value === "all") return value;
  throw new Error("--suite takes tool-use, everyday, or all");
}

export function readOptions(argv: readonly string[]): RunOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!;
    if ((SWITCHES as readonly string[]).includes(name)) {
      switches.add(name);
    } else if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = argv[index + 1];
      if (value === undefined || value === "" || value.startsWith("--"))
        throw new Error(`${name} takes a value`);
      values.set(name, value);
      index += 1;
    } else {
      throw new Error(`unknown argument '${name}'`);
    }
  }
  const out = values.get("--out");
  const harness = harnessSelection(values.get("--harness"));
  const skill = values.get("--skill");
  const cases = values.get("--case")?.split(",");
  const baseline = values.get("--baseline");
  const defaultModel = harness === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_MODEL;
  return {
    ...(out === undefined ? {} : { out }),
    harness,
    suite: suiteSelection(values.get("--suite")),
    ...(skill === undefined ? {} : { skill }),
    model: values.get("--model") ?? defaultModel,
    ...(cases === undefined ? {} : { cases }),
    samples: count(values.get("--samples"), "--samples", 2),
    concurrency: count(values.get("--concurrency"), "--concurrency", 2),
    ...(baseline === undefined ? {} : { baseline }),
    keepSessionRoute: switches.has("--keep-session-route"),
    dryRun: switches.has("--dry-run"),
    context: switches.has("--context"),
  };
}
