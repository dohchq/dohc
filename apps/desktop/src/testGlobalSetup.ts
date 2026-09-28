import type { TestProject } from "vitest/node";
import { sweepOldTestScratch } from "./workspaces/testTemp";

declare module "vitest" {
  export interface ProvidedContext {
    testScratchSwept: boolean;
  }
}

export default async function setup({ provide }: TestProject): Promise<() => Promise<void>> {
  await sweepOldTestScratch();
  // Setup files repeat in isolated workers. Share the completed sweep, while
  // each test file keeps its own scratch registrations and cleanup hooks.
  provide("testScratchSwept", true);
  // Sweep again for the empty run roots the pool's killed workers left behind.
  // Vitest tears down before its last workers finish exiting, so the next run's
  // startup sweep removes those.
  return sweepOldTestScratch;
}
