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
export function posixMcpLauncher(moduleFileName) {
  return `#!/bin/sh
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
exec node "\${0%/*}/${moduleFileName}" "$@"
`;
}

export const POSIX_MCP_LAUNCHER = posixMcpLauncher("dohc-mcp.mjs");
