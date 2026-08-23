import { chmod, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

// The dohc-mcp launchers probe for Node.js instead of assuming it: the
// bundled server needs a Node runtime, and the packaged dohc app cannot
// lend its own -- its RunAsNode fuse is disabled on purpose (see
// electron-builder.yml), and weakening that hardening to run an MCP server
// is not on the table. A Claude Code session always has Node (the CLI is a
// Node app); a Codex session may not (the CLI is a native binary), so the
// failure has to name the missing prerequisite instead of dying as a bare
// "env: node: No such file or directory". Exported for
// scripts/build-cli-bin.test.mjs, which runs both launchers against a PATH
// with and without a node.
export const NODE_MISSING_MESSAGE =
  "dohc-mcp needs Node.js on PATH and did not find it. Install Node.js 22 or newer to use dohc's MCP tools.";

// ${0%/*} instead of dirname: it is a shell builtin expansion, so the
// launcher's own failure path cannot depend on anything else being on the
// broken PATH it exists to report. Callers reach this file by absolute path
// (resolveDohcMcpCommand), which the expansion requires.
export const POSIX_MCP_LAUNCHER = `#!/bin/sh
if ! command -v node >/dev/null 2>&1; then
  echo "${NODE_MISSING_MESSAGE}" >&2
  exit 127
fi
NODE_VERSION=$(node --version 2>/dev/null)
NODE_RELEASE=\${NODE_VERSION#v}
NODE_MAJOR=\${NODE_RELEASE%%.*}
NODE_MINOR_REST=\${NODE_RELEASE#*.}
NODE_MINOR=\${NODE_MINOR_REST%%.*}
# node:sqlite's --experimental-sqlite requirement was dropped on a
# different floor per major line -- 22.13 and 23.4, per the Node docs --
# so a single flattened "major*100+minor" threshold wrongly accepted
# 23.0-23.3. The launcher passes no flag, so each major below 24 is
# checked against its own floor; 24 and newer never needed the flag.
NODE_FLOOR=""
if [ "$NODE_MAJOR" -lt 22 ]; then
  NODE_FLOOR="22.13"
elif [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; then
  NODE_FLOOR="22.13"
elif [ "$NODE_MAJOR" -eq 23 ] && [ "$NODE_MINOR" -lt 4 ]; then
  NODE_FLOOR="23.4"
fi
if [ -n "$NODE_FLOOR" ]; then
  echo "dohc-mcp needs Node.js $NODE_FLOOR or newer; found Node.js $NODE_RELEASE." >&2
  exit 127
fi
exec node "\${0%/*}/dohc-mcp.mjs" "$@"
`;

// Probes with `node --version`, not `where node`: where.exe is itself a
// System32 binary, so a PATH broken enough to lose node could also lose the
// probe and turn the report into a different, unnamed failure.
export const WINDOWS_MCP_LAUNCHER =
  "@echo off\r\n" +
  "node --version >nul 2>nul\r\n" +
  "if errorlevel 1 (\r\n" +
  `  echo ${NODE_MISSING_MESSAGE} 1>&2\r\n` +
  "  exit /b 127\r\n" +
  ")\r\n" +
  "set \"NODE_VERSION=\"\r\n" +
  "for /f \"delims=\" %%v in ('node --version 2^>nul') do set \"NODE_VERSION=%%v\"\r\n" +
  "set \"NODE_RELEASE=%NODE_VERSION:~1%\"\r\n" +
  "for /f \"tokens=1,2 delims=.\" %%v in (\"%NODE_RELEASE%\") do set \"NODE_MAJOR=%%v\" & set \"NODE_MINOR=%%w\"\r\n" +
  // node:sqlite's --experimental-sqlite requirement was dropped on a
  // different floor per major line -- 22.13 and 23.4, per the Node docs --
  // so each major below 24 is checked against its own floor; 24+ never
  // needed the flag. NODE_FLOOR stays unset (falsy to `defined`) unless a
  // check below actually names the floor being missed.
  "set \"NODE_FLOOR=\"\r\n" +
  "if %NODE_MAJOR% LSS 22 set \"NODE_FLOOR=22.13\"\r\n" +
  "if %NODE_MAJOR% EQU 22 if %NODE_MINOR% LSS 13 set \"NODE_FLOOR=22.13\"\r\n" +
  "if %NODE_MAJOR% EQU 23 if %NODE_MINOR% LSS 4 set \"NODE_FLOOR=23.4\"\r\n" +
  "if defined NODE_FLOOR (\r\n" +
  "  echo dohc-mcp needs Node.js %NODE_FLOOR% or newer; found Node.js %NODE_RELEASE%. 1>&2\r\n" +
  "  exit /b 127\r\n" +
  ")\r\n" +
  'node "%~dp0dohc-mcp.mjs" %*\r\n';

async function bundle(input) {
  await build({
    configFile: false,
    root: input.repoDir,
    logLevel: "info",
    build: {
      target: "node22",
      ssr: input.entry,
      outDir: input.outputDir,
      emptyOutDir: input.emptyOutDir,
      rollupOptions: {
        output: {
          format: "es",
          entryFileNames: input.name,
          ...(input.banner ? { banner: input.banner } : {}),
          // One self-contained file per bundle: a dynamic import must not
          // split into an assets/ chunk the packaged cli-bin filter would
          // have to ship alongside it.
          inlineDynamicImports: true,
        },
      },
    },
    ssr: { noExternal: true },
  });
}

async function main() {
  const desktopDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const repoDir = resolve(desktopDir, "../..");
  const outputDir = join(desktopDir, "resources", "cli-bin");

  // The dohc chat CLI: users run it from their own shell, where the shebang
  // and a bare `node` are the established contract.
  await bundle({
    repoDir,
    outputDir,
    entry: "packages/cli/src/index.ts",
    name: "dohc",
    banner: "#!/usr/bin/env node",
    emptyOutDir: true,
  });
  await chmod(join(outputDir, "dohc"), 0o755);
  await writeFile(join(outputDir, "dohc.cmd"), '@echo off\r\nnode "%~dp0dohc" %*\r\n', {
    mode: 0o755,
  });

  // The dohc-mcp stdio server chat session configs point the user's AI tool
  // at (resolveDohcMcpCommand): a probing launcher per platform plus the
  // bundle they both run.
  await bundle({
    repoDir,
    outputDir,
    entry: "packages/mcp/src/server.ts",
    name: "dohc-mcp.mjs",
    emptyOutDir: false,
  });
  await writeFile(join(outputDir, "dohc-mcp"), POSIX_MCP_LAUNCHER, { mode: 0o755 });
  await chmod(join(outputDir, "dohc-mcp"), 0o755);
  await writeFile(join(outputDir, "dohc-mcp.cmd"), WINDOWS_MCP_LAUNCHER, { mode: 0o755 });
}

// Run only when invoked as the build script, not when the test imports the
// launcher constants above.
const invoked = process.argv[1] ? resolve(process.argv[1]) : null;
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main();
}
