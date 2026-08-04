import { afterAll, afterEach } from "vitest";
import {
  cleanupSuiteTestScratch,
  cleanupTestScratch,
  sweepOldTestScratch,
} from "./workspaces/testTemp";

await sweepOldTestScratch();

afterEach(async () => {
  await cleanupTestScratch();
});

afterAll(async () => {
  await cleanupSuiteTestScratch();
});
