import { createRequire } from "node:module";

// node:test reads each test file's results from that file's stdout, and electron-builder's
// logger writes there too. Its "  • " prefix, landing right after a result, reads as a
// negative message length and fails the whole file with "Unable to deserialize cloned data",
// so its lines go to stderr, which the runner reads line by line.
const require = createRequire(import.meta.url);
export const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
export const { log: builderLog } = createRequire(builderRequire.resolve("app-builder-lib/package.json"))("builder-util");
builderLog.stream = process.stderr;
