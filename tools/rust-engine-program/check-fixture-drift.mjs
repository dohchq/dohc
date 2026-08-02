#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const dependencyError =
  /could not resolve (?:yjs|tsx\/esm\/api) from any base:/;

// Every committed fixture set that a live TypeScript oracle regenerates. A
// fixture set missing from this list is frozen output nothing can regenerate,
// which is the exact rot this check exists to prevent — add new sets here.
const fixtureSets = [
  {
    dir: "crates/dohc-engine-collab/tests/fixtures",
    oracle: "packages/ydoc-projection",
    // Y.Doc client IDs are randomly generated, so the encoded lineage changes
    // on every run even when its content is identical. The oracle-owned
    // projections, coverage, metadata, and expectations remain byte-stable and
    // are the drift signal this gate must protect.
    volatileFields: [
      "baseUpdateB64",
      "mergedUpdateB64",
      "stateVectorB64",
      "updates",
    ],
    oracleFailurePrefix: "richdocProjection-",
    // Fixture cases the LIVE TypeScript oracle can no longer produce. Each
    // entry is a RECORDED DEFECT, not an exemption: the committed fixture still
    // asserts an expectation the oracle now throws on, so the Rust parity test
    // for that case is validating against frozen output nothing can regenerate.
    //
    // Listing a case here keeps the guard active for every OTHER fixture
    // instead of letting one broken construct blind the whole check. The list
    // is self-expiring: if a listed case starts generating again, this check
    // FAILS and tells you to remove it, so the allowlist cannot quietly outlive
    // the defect it documents.
    knownOracleFailures: new Map([
      [
        "code-language-backtick",
        "yDocToMarkdown throws 'could not restore a fenced code block serialization sentinel' for a codeBlock whose language info string contains a backtick (language: 'lang`tick'). rewriteCodeBlockFences matches the opening fence with /(`{3,})([^`]*)$/, which cannot match an info string containing a backtick.",
      ],
    ]),
  },
  {
    dir: "crates/dohc-engine-sync/tests/fixtures",
    oracle: "packages/security-contract",
    // The path-floor oracle classifies a fixed input list, so its whole output
    // is byte-stable. Nothing here may be excluded from the drift signal: this
    // is a cross-process security contract with a deliberate Rust twin.
    volatileFields: [],
    oracleFailurePrefix: "",
    knownOracleFailures: new Map(),
  },
];

function fixtureNames(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function printList(label, names) {
  console.error(`${label}:`);
  if (names.length === 0) {
    console.error("  (none)");
    return;
  }
  for (const name of names) console.error(`  - ${name}`);
}

function comparableFixture(path, volatileFields) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  for (const field of volatileFields) delete fixture[field];
  return Buffer.from(JSON.stringify(fixture, null, 1));
}

function shortLine(line) {
  const maxLength = 240;
  const excerpt =
    line.length <= maxLength ? line : `${line.slice(0, maxLength - 1)}…`;
  return JSON.stringify(excerpt);
}

function printDiffExcerpt(name, committed, generated) {
  const committedLines = committed.toString("utf8").split("\n");
  const generatedLines = generated.toString("utf8").split("\n");
  const lineCount = Math.max(committedLines.length, generatedLines.length);
  let firstDifference = 0;
  while (
    firstDifference < lineCount &&
    committedLines[firstDifference] === generatedLines[firstDifference]
  ) {
    firstDifference += 1;
  }

  const start = Math.max(0, firstDifference - 1);
  const end = Math.min(lineCount, firstDifference + 2);
  console.error(`\nDiff excerpt for ${name}:`);
  for (let index = start; index < end; index += 1) {
    const lineNumber = String(index + 1).padStart(4);
    const committedLine = committedLines[index];
    const generatedLine = generatedLines[index];
    if (committedLine === generatedLine) {
      console.error(`  ${lineNumber}  ${shortLine(committedLine ?? "")}`);
    } else {
      console.error(
        `- ${lineNumber} committed ${shortLine(committedLine ?? "<missing>")}`,
      );
      console.error(
        `+ ${lineNumber} generated ${shortLine(generatedLine ?? "<missing>")}`,
      );
    }
  }
}

function conciseGeneratorError(output) {
  const lines = output.trimEnd().split(/\r?\n/);
  const errorLine = lines.findLastIndex((line) => line.startsWith("Error:"));
  return lines
    .slice(errorLine >= 0 ? errorLine : Math.max(0, lines.length - 12))
    .join("\n");
}

// Returns this fixture set's exit code: 0 pass, 1 fail, 2 dependency SKIP.
// Starts at 1 so any path that reaches no verdict fails closed.
function checkFixtureSet({
  dir,
  oracle,
  volatileFields,
  oracleFailurePrefix,
  knownOracleFailures,
}) {
  const fixturesDir = join(repoRoot, dir);
  const generator = join(fixturesDir, "gen-fixtures.mjs");
  const tempDir = mkdtempSync(join(tmpdir(), "dohc-fixture-drift-"));
  let exitCode = 1;
  console.log(`\n--- ${dir} (oracle: ${oracle}) ---`);
  try {
    const generated = spawnSync(process.execPath, [generator], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DOHC_FIXTURE_OUT: tempDir,
        DOHC_FIXTURE_ALLOW_ORACLE_FAILURES: [...knownOracleFailures.keys()].join(","),
      },
      encoding: "utf8",
    });
    const generatorOutput = `${generated.stdout ?? ""}${generated.stderr ?? ""}`;

    if (generated.error) {
      console.error(
        `fixture generator could not start: ${generated.error.message}`,
      );
    } else if (generated.status !== 0) {
      if (dependencyError.test(generatorOutput)) {
        const dependency = generatorOutput.includes("tsx/esm/api")
          ? "tsx"
          : "yjs";
        console.warn(
          `SKIP: ${dir} fixture drift was not checked because ${dependency} could not be resolved.`,
        );
        console.warn(
          "Install the JavaScript workspace dependencies or set DOHC_YJS_BASE, then rerun the check.",
        );
        exitCode = 2;
      } else {
        console.error("fixture generator failed:");
        console.error(conciseGeneratorError(generatorOutput));
        console.error(
          "Remediation: fix the generator/oracle error, then re-run the fixture drift check.",
        );
      }
    } else {
      if (generated.stdout) process.stdout.write(generated.stdout);
      if (generated.stderr) process.stderr.write(generated.stderr);

      // Report the recorded oracle failures every run -- loudly, so a known
      // defect stays visible instead of decaying into background noise -- and
      // fail if a listed case has started generating again, which means the
      // entry is stale and must be removed.
      const observedFailures = new Set(
        [...generatorOutput.matchAll(/^ORACLE_FAILURE (\S+):/gm)].map((m) => m[1]),
      );
      const staleAllowlist = [...knownOracleFailures.keys()].filter(
        (name) => !observedFailures.has(name),
      );
      for (const name of observedFailures) {
        console.error(
          `KNOWN ORACLE FAILURE: ${oracleFailurePrefix}${name} -- the committed fixture asserts an expectation the live oracle can no longer produce.`,
        );
        console.error(`  ${knownOracleFailures.get(name)}`);
      }

      const excluded = new Set(
        [...knownOracleFailures.keys()].map(
          (name) => `${oracleFailurePrefix}${name}.json`,
        ),
      );
      const committedNames = fixtureNames(fixturesDir).filter(
        (name) => !excluded.has(name),
      );
      const generatedNames = fixtureNames(tempDir).filter(
        (name) => !excluded.has(name),
      );
      const committedSet = new Set(committedNames);
      const generatedSet = new Set(generatedNames);
      const missing = committedNames.filter((name) => !generatedSet.has(name));
      const unexpectedlyNew = generatedNames.filter(
        (name) => !committedSet.has(name),
      );
      const differing = committedNames.filter((name) => {
        if (!generatedSet.has(name)) return false;
        return !comparableFixture(join(fixturesDir, name), volatileFields).equals(
          comparableFixture(join(tempDir, name), volatileFields),
        );
      });

      if (staleAllowlist.length > 0) {
        console.error(
          "stale known-oracle-failure allowlist: these cases generate cleanly again and must be removed from knownOracleFailures, and their fixtures regenerated:",
        );
        for (const name of staleAllowlist) console.error(`  - ${name}`);
      } else if (
        differing.length === 0 &&
        missing.length === 0 &&
        unexpectedlyNew.length === 0
      ) {
        console.log(
          `${dir}: ${committedNames.length} deterministic fixture payloads match byte-for-byte` +
            (observedFailures.size > 0
              ? ` (${observedFailures.size} recorded oracle failure(s) excluded and reported above)`
              : ""),
        );
        exitCode = 0;
      } else {
        console.error(`fixture drift detected in ${dir}.`);
        printList("Differing fixtures", differing);
        printList(
          "Missing fixtures (committed but not regenerated)",
          missing,
        );
        printList(
          "Unexpectedly new fixtures (generated but not committed)",
          unexpectedlyNew,
        );

        const excerptName =
          differing.find((name) => name !== "_manifest.json") ?? differing[0];
        if (excerptName) {
          printDiffExcerpt(
            excerptName,
            comparableFixture(join(fixturesDir, excerptName), volatileFields),
            comparableFixture(join(tempDir, excerptName), volatileFields),
          );
        }
        console.error(
          `\nRemediation: re-run ${dir}/gen-fixtures.mjs and review the resulting diff.`,
        );
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return exitCode;
}

// Check every set before reporting, so one drifted set does not hide another.
// A real failure outranks a dependency SKIP, which outranks a pass.
const codes = fixtureSets.map((set) => checkFixtureSet(set));
const exitCode = codes.includes(1) ? 1 : codes.includes(2) ? 2 : 0;
if (exitCode === 0) {
  console.log(
    `\nfixture drift check passed: ${fixtureSets.length} fixture sets regenerated from their live oracles`,
  );
}

process.exitCode = exitCode;
