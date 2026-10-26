import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestScratch } from "./testTemp";
import { readFlagsWithStat } from "./workspaceICloudOnly";

const UF_HIDDEN = 0x8000;

// The real macOS stat, which reads the flags Node does not expose.
it.runIf(process.platform === "darwin")("reads each path's flags in order, in batches, and fails for a path that vanished", async () => {
  const root = await createTestScratch("icloud-flags-");
  const paths = Array.from({ length: 2_500 }, (_, index) => join(root, `file ${index}\n.txt`));
  for (const path of paths) await writeFile(path, "x");
  execFileSync("/usr/bin/chflags", ["hidden", paths[1]!, paths[2_400]!]);
  const flags = await readFlagsWithStat(paths, 30_000);
  expect(flags).toHaveLength(2_500);
  expect(flags.flatMap((value, index) => (value & UF_HIDDEN) !== 0 ? [index] : [])).toEqual([1, 2_400]);
  await rm(paths[1_200]!);
  await expect(readFlagsWithStat(paths, 30_000)).rejects.toThrow();
  await expect(readFlagsWithStat(paths, 0)).rejects.toThrow();
});
