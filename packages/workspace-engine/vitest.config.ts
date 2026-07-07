import { defineConfig } from "vitest/config";

// The engine suite exercises the on-disk history store (changeSetStore) and the
// versioned file workspace, which take real filesystem locks — including the
// Linux descriptor-anchored history mutation path. Run test files serially so
// the lock-contention/concurrency assertions (changeSetStore.test.ts) are not
// destabilised by unrelated fs-heavy files racing them across parallel workers.
// Tests within each file still run per that file's own design.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
