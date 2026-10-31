import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const flakyFixtureFiles = [
  "scripts/verification/flaky.mjs",
  "tools/rust-engine-program/reader-tests.mjs",
  "tools/rust-engine-program/gate-commands.mjs",
  "tools/rust-engine-program/scratch-leak-report.mjs",
];

export function copyFlakyFixture(root, sourceRoot = fileURLToPath(new URL("../../", import.meta.url))) {
  for (const file of flakyFixtureFiles) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(sourceRoot, file), target);
  }
}
