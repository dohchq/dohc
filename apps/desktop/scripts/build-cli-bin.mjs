import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "vite";

const desktopDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(desktopDir, "../..");
const outputDir = join(desktopDir, "resources", "cli-bin");

// Both launchers a packaged install must carry: the dohc chat CLI, and the
// dohc-mcp stdio server that chat session configs (the desktop's own and the
// driver plugins') point the user's AI tool at. In dev both come from the
// workspace's node_modules/.bin instead.
const entries = [
  { entry: "packages/cli/src/index.ts", name: "dohc" },
  { entry: "packages/mcp/src/server.ts", name: "dohc-mcp" },
];

for (const [index, { entry, name }] of entries.entries()) {
  await build({
    configFile: false,
    root: repoDir,
    logLevel: "info",
    build: {
      target: "node22",
      ssr: entry,
      outDir: outputDir,
      // Only the first build clears the directory, or it would delete the
      // sibling launcher it just produced.
      emptyOutDir: index === 0,
      rollupOptions: {
        output: {
          format: "es",
          entryFileNames: name,
          banner: "#!/usr/bin/env node",
          // One self-contained file per launcher: a dynamic import must not
          // split into an assets/ chunk the packaged cli-bin filter would
          // have to ship alongside it.
          inlineDynamicImports: true,
        },
      },
    },
    ssr: { noExternal: true },
  });
  await chmod(join(outputDir, name), 0o755);
  await writeFile(
    join(outputDir, `${name}.cmd`),
    `@echo off\r\nnode "%~dp0${name}" %*\r\n`,
    { mode: 0o755 },
  );
}
