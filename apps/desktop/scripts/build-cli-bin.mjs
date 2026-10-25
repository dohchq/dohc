import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { cliLaunchers } from "./mcp-launchers.mjs";
export { cliLaunchers } from "./mcp-launchers.mjs";

async function bundle(input) {
  await build({
    configFile: false, root: input.repoDir, logLevel: "info",
    build: {
      target: "node22", ssr: input.entry, outDir: input.outputDir, emptyOutDir: input.emptyOutDir,
      rollupOptions: { output: { format: "es", entryFileNames: input.name, inlineDynamicImports: true } },
    },
    ssr: { noExternal: true },
  });
}

export async function buildCliBin(options = {}) {
  const desktopDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const repoDir = resolve(desktopDir, "../..");
  const outputDir = options.outputDir ?? join(desktopDir, "resources", "cli-bin");
  const launchers = cliLaunchers(options);
  await bundle({ repoDir, outputDir, entry: "packages/cli/src/index.ts", name: "dohc.mjs", emptyOutDir: true });
  await bundle({ repoDir, outputDir, entry: "packages/mcp/src/server.ts", name: "dohc-mcp.mjs", emptyOutDir: false });
  for (const [name, content] of Object.entries(launchers)) {
    await writeFile(join(outputDir, name), content, { mode: 0o755 });
    await chmod(join(outputDir, name), 0o755);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (!["--platform", "--arch"].includes(flag) || !process.argv[i + 1]) throw new Error(`Unknown or incomplete option: ${flag}`);
    options[flag.slice(2)] = process.argv[i + 1];
  }
  await buildCliBin(options);
}
