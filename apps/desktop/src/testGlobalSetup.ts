import type { TestProject } from "vitest/node";
import { sweepOldTestScratch } from "./workspaces/testTemp";

declare module "vitest" {
  export interface ProvidedContext {
    testScratchSwept: boolean;
  }
}

export default async function setup({ provide }: TestProject): Promise<void> {
  await sweepOldTestScratch();
  // Setup files repeat in isolated workers. Share the completed sweep, while
  // each test file keeps its own scratch registrations and cleanup hooks.
  provide("testScratchSwept", true);
}
