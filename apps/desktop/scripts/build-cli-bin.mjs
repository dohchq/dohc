import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "vite";

const desktopDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(desktopDir, "../..");
const outputDir = join(desktopDir, "resources", "cli-bin");
const executable = join(outputDir, "dohc");

await build({
  configFile: false,
  root: repoDir,
  logLevel: "info",
  build: {
    target: "node22",
    ssr: "packages/cli/src/index.ts",
    outDir: outputDir,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        format: "es",
        entryFileNames: "dohc",
        banner: "#!/usr/bin/env node",
      },
    },
  },
  ssr: { noExternal: true },
});
await chmod(executable, 0o755);
await writeFile(
  join(outputDir, "dohc.cmd"),
  '@echo off\r\nnode "%~dp0dohc" %*\r\n',
  { mode: 0o755 },
);
