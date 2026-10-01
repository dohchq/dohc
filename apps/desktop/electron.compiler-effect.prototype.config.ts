// Throwaway comparison of the existing production main-process configuration.
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import original from "./electron.vite.config";

export default defineConfig(async (environment) => {
  const config = await original(environment);
  const variant = process.env.DOHC_COMPILER_EFFECT_VARIANT;
  if (variant !== "baseline" && variant !== "candidate") throw new Error("Missing comparison variant.");
  const main = config.main!;
  if (variant === "baseline") {
    main.plugins!.unshift({
      name: "prototype-original-supervisor",
      enforce: "pre",
      resolveId(source) {
        if (/\/compilerProcessSupervisor(?:\.ts)?$/.test(source)) {
          return resolve("src/workspaces/compilerProcessSupervisor.prototype-baseline.ts");
        }
      },
    });
  }
  main.build!.outDir = resolve(`../../.agent-artifacts/effect-compiler/bundles/${variant}`);
  return { main };
});
