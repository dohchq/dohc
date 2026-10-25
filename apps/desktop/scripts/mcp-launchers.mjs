export const BUNDLED_NODE_MISSING_MESSAGE =
  "dohc is missing a file it needs to run agents. Reinstall dohc, then try again.";
export const NODE_MISSING_MESSAGE =
  "dohc commands need Node.js on PATH. Install Node.js 22.13 or newer, then try again.";

export function agentRuntimeTarget(platform, arch) {
  if (platform === "win32" && arch === "x64" || platform === "darwin" && arch === "arm64") return "bundled";
  if (platform === "linux" && ["x64", "arm64"].includes(arch)) return "path";
  throw new Error(`Unsupported agent runtime target: ${platform}-${arch}`);
}

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
case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    echo "${NODE_MISSING_MESSAGE}" >&2
    exit 127 ;;
esac
case "$NODE_MINOR" in
  ''|*[!0-9]*)
    echo "${NODE_MISSING_MESSAGE}" >&2
    exit 127 ;;
esac
NODE_FLOOR=""
if [ "$NODE_MAJOR" -lt 22 ]; then
  NODE_FLOOR="22.13"
elif [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; then
  NODE_FLOOR="22.13"
elif [ "$NODE_MAJOR" -eq 23 ] && [ "$NODE_MINOR" -lt 4 ]; then
  NODE_FLOOR="23.4"
fi
if [ -n "$NODE_FLOOR" ]; then
  echo "dohc commands need Node.js $NODE_FLOOR or newer; found Node.js $NODE_RELEASE." >&2
  exit 127
fi
exec node "\${0%/*}/${moduleFileName}" "$@"
`;
}

export function bundledPosixLauncher(moduleFileName, nodeFileName) {
  return `#!/bin/sh
NODE="\${0%/*}/${nodeFileName}"
if [ ! -f "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "${BUNDLED_NODE_MISSING_MESSAGE}" >&2
  exit 127
fi
exec "$NODE" "\${0%/*}/${moduleFileName}" "$@"
`;
}

export function windowsLauncher(moduleFileName) {
  return [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    'if not exist "%~dp0..\\app-compiler\\node.exe" (',
    `  echo ${BUNDLED_NODE_MISSING_MESSAGE} 1>&2`,
    "  exit /b 127",
    ")",
    `"%~dp0..\\app-compiler\\node.exe" "%~dp0${moduleFileName}" %*`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
}

export function cliLaunchers({ platform = process.platform, arch = process.arch } = {}) {
  const bundled = agentRuntimeTarget(platform, arch) === "bundled";
  const files = {};
  for (const name of ["dohc", "dohc-mcp"]) {
    files[name] = bundled
      ? bundledPosixLauncher(`${name}.mjs`, `../app-compiler/${platform === "win32" ? "node.exe" : "node"}`)
      : posixMcpLauncher(`${name}.mjs`);
    files[`${name}.cmd`] = windowsLauncher(`${name}.mjs`);
  }
  return files;
}
