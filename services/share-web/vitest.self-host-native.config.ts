import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // publicLinkAuthenticatedNative needs a hashed public release admission, which no gate supplies.
    include: [
      "src/selfHostedLiveNative.integration.ts",
      "src/ownerMultiDeviceNative.integration.ts",
      "src/namedLiveNative.integration.ts",
      "src/namedLiveAuthenticatedNative.integration.ts",
      "src/namedDesktopAuthenticatedNative.integration.ts",
      "src/namedRecipientAuthenticatedNative.integration.ts",
      "src/serviceActivationNative.integration.ts",
      "src/remoteMcpNative.integration.ts",
    ],
    globalSetup: ["src/testing/nativeProofSetup.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
