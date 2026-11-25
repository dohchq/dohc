import { defineConfig } from "@playwright/test";
import desktop from "../../apps/desktop/playwright.config";

export default defineConfig({
  ...desktop,
  testDir: ".",
  tsconfig: "../../apps/desktop/tsconfig.quant-workbench.json",
  outputDir: "../../.agent-artifacts/signalbook",
});
