// The PR checks' iOS job: which sample UI tests it runs, and how it reads their results and the built bundle.
// Usage, from the repository root:
//   node scripts/verification/ios-ui.mjs classes
//   node scripts/verification/ios-ui.mjs exclusions
//   node scripts/verification/ios-ui.mjs skips <class>
//   node scripts/verification/ios-ui.mjs check <class> <appearance> <results.json> <xcodebuild status>
//   node scripts/verification/ios-ui.mjs flag <plain JS bundle> <name> <on|off>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const IOS_UI_TARGET = "dohcUITests";

// PageAccessibilityTests stays on the Mac: its only test needs VoiceOver.
export const IOS_UI_CLASSES = [
  "ConversationComposerTests",
  "ConversationOutboxTests",
  "ConversationActionsTests",
  "ConversationDecisionTests",
  "ConversationWakeTests",
  "NoticesAnswerTests",
  "NoticesActionsTests",
  "NoticesAccessibilityTests",
  "NoticesScrollTests",
  "PageEditingTests",
];

// Tests that need the Mac, skipped by name so they report no result.
export const IOS_UI_EXCLUSIONS = {
  "NoticesAccessibilityTests/testVoiceOverSpeaksEachRowOnce": "needs VoiceOver",
  "PageEditingTests/testSwitchingToTheEmojiKeyboardKeepsTheLineAboveIt":
    "the emoji keyboard crashes the simulator, so the test skips itself",
};

export const testMethods = (source) =>
  [...source.matchAll(/func (test\w+)\(/gu)].map((match) => match[1]);

/** The methods a class must pass, and any exclusion that no longer names one of its tests. */
export function expectedTests(name, source) {
  const methods = testMethods(source);
  const excluded = Object.keys(IOS_UI_EXCLUSIONS)
    .filter((test) => test.startsWith(`${name}/`))
    .map((test) => test.slice(name.length + 1));
  const problems = excluded
    .filter((method) => !methods.includes(method))
    .map((method) => `${name}/${method} is excluded but is not a test`);
  if (!methods.length) problems.push(`${name} has no tests`);
  return { expected: methods.filter((method) => !excluded.includes(method)), problems };
}

/** The test cases in `xcrun xcresulttool get test-results tests --compact` output. */
export function resultRows(data) {
  const rows = [];
  const walk = (node, suite) => {
    if (Array.isArray(node)) return node.forEach((child) => walk(child, suite));
    if (!node || typeof node !== "object") return;
    if (node.nodeType === "Test Suite") suite = node.name;
    if (node.nodeType === "Test Case") {
      rows.push({
        suite,
        name: String(node.name ?? "").replace(/\(\)$/u, ""),
        result: node.result,
        seconds: node.durationInSeconds ?? node.duration,
      });
      return;
    }
    walk(node.children ?? [], suite);
  };
  walk(data?.testNodes ?? data, undefined);
  return rows;
}

/** One class in one appearance passes only if xcodebuild exited 0 and every expected test passed once, as an ordinary test. */
export function checkClass({ name, source, results, status }) {
  const { expected, problems } = expectedTests(name, source);
  const rows = resultRows(results);
  if (status !== 0) problems.push(`xcodebuild exited ${status}`);
  let passed = 0;
  for (const method of expected) {
    const found = rows.filter((row) => row.suite === name && row.name === method);
    if (!found.length) problems.push(`${name}/${method}: no result`);
    else if (found.length > 1) problems.push(`${name}/${method}: ${found.length} results`);
    else if (found[0].result !== "Passed") problems.push(`${name}/${method}: ${found[0].result}`);
    else passed++;
  }
  for (const row of rows)
    if (row.suite !== name || !expected.includes(row.name))
      problems.push(`${row.suite}/${row.name}: not selected, reported ${row.result}`);
  return { expected, passed, rows, problems };
}

/** How the plain JS bundle sets an exported build flag: `on`, `off`, or `undetermined`. */
export function flagReading(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  // The assignment ends at a semicolon, a comma, or the module wrapper's closing brace or parenthesis.
  const hits = [...text.matchAll(new RegExp(`${escaped}\\s*=(?!=)[^;,})\\n]{0,120}`, "gu"))].map(
    ([hit]) => hit.trim(),
  );
  const on = hits.filter((hit) => /["']1["']\s*===\s*["']1["']|=\s*(?:true|!0)\s*$/u.test(hit));
  const off = hits.filter((hit) =>
    /(?:undefined|void 0)\s*===\s*["']1["']|=\s*(?:false|!1)\s*$/u.test(hit),
  );
  if (on.length && !off.length) return { state: "on", hit: on[0] };
  if (off.length && !on.length) return { state: "off", hit: off[0] };
  return { state: "undetermined", hit: hits.slice(0, 3).join(" | ") };
}

function main([command, ...args]) {
  if (command === "classes") {
    console.log(IOS_UI_CLASSES.join("\n"));
    return 0;
  }
  if (command === "exclusions") {
    for (const [test, reason] of Object.entries(IOS_UI_EXCLUSIONS))
      console.log(`${test}: ${reason}`);
    console.log("PageAccessibilityTests: needs VoiceOver");
    return 0;
  }
  if (command === "skips") {
    const [name] = args;
    console.log(
      Object.keys(IOS_UI_EXCLUSIONS)
        .filter((test) => test.startsWith(`${name}/`))
        .map((test) => `-skip-testing:${IOS_UI_TARGET}/${test}`)
        .join(" "),
    );
    return 0;
  }
  if (command === "check") {
    const [name, appearance, resultsPath, status] = args;
    let results = null;
    try {
      results = JSON.parse(readFileSync(resultsPath, "utf8"));
    } catch (error) {
      console.log(`${name} ${appearance}: the result bundle could not be read (${error.message})`);
    }
    const source = readFileSync(`apps/mobile/uitests/${name}.swift`, "utf8");
    const { expected, passed, rows, problems } = checkClass({
      name,
      source,
      results,
      status: /^\d+$/u.test(status ?? "") ? Number(status) : status,
    });
    for (const row of rows)
      console.log(`  ${row.suite}/${row.name}: ${row.result} (${row.seconds}s)`);
    for (const problem of problems) console.log(`  FAILED ${problem}`);
    console.log(
      `${name} ${appearance}: ${problems.length ? "FAIL" : "PASS"}, ${passed} of ${expected.length} passed`,
    );
    return problems.length ? 1 : 0;
  }
  if (command === "flag") {
    const [path, name, wanted] = args;
    const { state, hit } = flagReading(readFileSync(path, "utf8"), name);
    console.log(`${name}: ${state} (${hit || "no assignment found"})`);
    return state === wanted ? 0 : 1;
  }
  console.error(
    "Usage: ios-ui.mjs classes | exclusions | skips <class> | check <class> <appearance> <results.json> <status> | flag <bundle> <name> <on|off>",
  );
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv.slice(2));
