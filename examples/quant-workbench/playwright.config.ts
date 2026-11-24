import { defineConfig } from "@playwright/test";
import desktop from "../../apps/desktop/playwright.config";

export default defineConfig({
  ...desktop,
  testDir: ".",
  outputDir: "../../.agent-artifacts/signalbook",
});
