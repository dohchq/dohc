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

// A test that calls `ctx.skip()` in its body has already run `beforeEach`, and
// vitest then runs no `afterEach` for it — so the scratch that `beforeEach`
// made is never released. Draining the per-test set here too means anything a
// test left registered still goes, whatever path skipped its teardown.
afterAll(async () => {
  await cleanupTestScratch();
  await cleanupSuiteTestScratch();
});
