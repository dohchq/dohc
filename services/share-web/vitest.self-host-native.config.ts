import {defineConfig} from "vitest/config";

export default defineConfig({test: {include: ["src/selfHostedLiveNative.integration.ts"], maxWorkers: 1, fileParallelism: false}});
