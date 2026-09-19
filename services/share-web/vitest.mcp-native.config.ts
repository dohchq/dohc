import {defineConfig} from "vitest/config";

export default defineConfig({test: {include: ["src/remoteMcpNative.integration.ts"], maxWorkers: 1, fileParallelism: false}});
