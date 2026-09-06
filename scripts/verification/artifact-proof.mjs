import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { prepare } from "./build.mjs";
import { repoRoot, run } from "./process.mjs";

const output = join(repoRoot, ".agent-artifacts/verification", `artifact-proof-${randomUUID()}`);
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]);
}
try {
  await prepare();
  let failed = false;
  try {
    await run(process.execPath, ["apps/desktop/scripts/run-playwright.mjs", "--config", "apps/desktop/playwright.config.ts", "--grep", "@artifact-proof", "--output", output], { env: { ...process.env, DOHC_QA_ARTIFACT_PROBE: "1" } });
  } catch { failed = true; }
  if (!failed || !existsSync(output)) throw new Error("The intentional failure did not produce an artifact directory.");
  const artifacts = files(output);
  const log = artifacts.find((path) => path.endsWith("desktop.jsonl"));
  if (!log || !readFileSync(log, "utf8").includes("verification-artifact-sentinel")) throw new Error("Desktop logs were lost during failed-run cleanup.");
  if (!artifacts.some((path) => path.endsWith(".png")) || !artifacts.some((path) => path.endsWith("trace.zip"))) throw new Error("Failure screenshot or trace is missing.");
  console.log(`[artifact-proof] PASS: intentional failure retained logs, screenshot, and trace at ${output}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
