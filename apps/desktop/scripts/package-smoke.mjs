import { existsSync, readFileSync, statSync, accessSync, constants } from "node:fs";
import { cp, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentRuntimeTarget, BUNDLED_NODE_MISSING_MESSAGE } from "./mcp-launchers.mjs";

export function agentResourceFailures(resources, { platform = process.platform, arch = process.arch } = {}) {
  const files = ["dohc", "dohc.cmd", "dohc.mjs", "dohc-mcp", "dohc-mcp.cmd", "dohc-mcp.mjs"].map(name => `cli-bin/${name}`);
  if (agentRuntimeTarget(platform, arch) === "bundled") {
    files.push(`app-compiler/${platform === "win32" ? "node.exe" : "node"}`);
  }
  return files.filter(file => {
    try {
      const path = join(resources, file);
      if (!statSync(path).isFile() || statSync(path).size === 0) return true;
      if (platform !== "win32" && (file.endsWith("/node") || file === "cli-bin/dohc" || file === "cli-bin/dohc-mcp")) accessSync(path, constants.X_OK);
      return false;
    } catch { return true; }
  }).map(file => `Missing or unusable agent resource: ${file}`);
}

function launcherCommand(resources, name, args, shell) {
  const path = join(resources, "cli-bin", name + (process.platform === "win32" ? ".cmd" : ""));
  return process.platform === "win32"
    ? { command: shell, args: ["/d", "/s", "/c", `""${path}" ${args.map(arg => `"${arg}"`).join(" ")}"`], windowsVerbatimArguments: true }
    : { command: shell, args: [path, ...args] };
}

async function probeMcp(resources, cwd, home, shell, env) {
  const command = launcherCommand(resources, "dohc-mcp", ["--workspace", cwd, "--home", home, "--tool", "dohc_reply_to_chat"], shell);
  const child = spawn(command.command, command.args, { cwd, env, windowsHide: true, windowsVerbatimArguments: command.windowsVerbatimArguments, stdio: "pipe" });
  let output = "", stderr = "";
  const responses = new Map();
  let resolveResponse, rejectResponse;
  let waiting;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => {
    output += chunk;
    let newline;
    while ((newline = output.indexOf("\n")) !== -1) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      try {
        const response = JSON.parse(line);
        if (response.id !== undefined) responses.set(response.id, response);
        if (response.id === waiting) resolveResponse?.(response);
      } catch (error) { rejectResponse?.(error); }
    }
  });
  child.on("error", error => rejectResponse?.(error));
  child.stdin.on("error", error => rejectResponse?.(error));
  const closed = new Promise(resolveClose => child.once("close", resolveClose));
  child.once("exit", code => rejectResponse?.(new Error(`MCP exited ${code}: ${stderr}`)));
  async function request(id, method, params) {
    const response = new Promise((resolveResult, rejectResult) => { waiting = id; resolveResponse = resolveResult; rejectResponse = rejectResult; });
    const timer = setTimeout(() => rejectResponse?.(new Error(`MCP ${method} timed out: ${stderr}`)), 20000);
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      if (responses.has(id)) resolveResponse(responses.get(id));
      const result = await response;
      assert.ok(!result.error, JSON.stringify(result.error));
      return result.result;
    } finally { clearTimeout(timer); }
  }
  try {
    const initialized = await request(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dohc-package-smoke", version: "1" } });
    assert.ok(initialized.serverInfo);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = await request(2, "tools/list", {});
    assert.ok(tools.tools.some(tool => tool.name === "dohc_reply_to_chat"));
    console.log("ok  unmodified packaged MCP initialize/tools-list");
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 2000);
    await closed;
    clearTimeout(timer);
  }
}

export async function probeAgentLaunchers(resources) {
  if (!isAbsolute(resources)) throw new Error("--resources must be absolute");
  assert.deepEqual(agentResourceFailures(resources), []);
  // Resolve the shell before testing an environment without system Node.
  const shell = process.platform === "win32" ? process.env.ComSpec : "/bin/sh";
  assert.ok(shell && isAbsolute(shell), "The shell must have an absolute path");
  const scratch = await mkdtemp(join(tmpdir(), "dohc-packaged-launchers-"));
  try {
    const probe = join(scratch, "probe.mjs");
    await writeFile(probe, `import fs from 'node:fs'; console.log(JSON.stringify({execPath:process.execPath, args:process.argv.slice(2), stdin:[...fs.readFileSync(0)]})); console.error('probe-stderr'); process.exit(37);`);
    const competing = join(scratch, "competing");
    await mkdir(competing);
    await copyFile(process.execPath, join(competing, process.platform === "win32" ? "node.exe" : "node"));
    const args = ["", "two words", "Icé 雪"];
    const bundled = agentRuntimeTarget(process.platform, process.arch) === "bundled";
    const input = Buffer.from([0, 10, 13, 255, 65]);
    for (const label of ["Ice Test", "Icé"]) {
      const copied = join(scratch, label, "resources");
      const cwd = join(scratch, label, "workspace", label);
      await mkdir(cwd, { recursive: true });
      await cp(join(resources, "cli-bin"), join(copied, "cli-bin"), { recursive: true });
      await mkdir(join(copied, "app-compiler"), { recursive: true });
      const nodeName = process.platform === "win32" ? "node.exe" : "node";
      if (existsSync(join(resources, "app-compiler", nodeName))) await copyFile(join(resources, "app-compiler", nodeName), join(copied, "app-compiler", nodeName));
      await copyFile(process.execPath, join(cwd, nodeName));
      await writeFile(join(cwd, "node.cmd"), "@echo WORKSPACE-NODE-RAN\r\nexit /b 98\r\n");
      for (const selected of [resources, copied]) {
        for (const path of [join(scratch, "empty-path"), competing]) {
          for (const name of ["dohc", "dohc-mcp"]) {
            const command = launcherCommand(selected, name, args, shell);
            const result = spawnSync(command.command, command.args, { cwd, input, encoding: "utf8", timeout: 20000,
              env: { ...process.env, PATH: path, Path: path, NODE_OPTIONS: `--import=${pathToFileURL(probe).href}` },
              windowsVerbatimArguments: command.windowsVerbatimArguments, windowsHide: true });
            if (!bundled && path !== competing) {
              assert.equal(result.status, 127);
              assert.match(result.stderr, /Node\.js/);
              continue;
            }
            assert.equal(result.status, 37, result.stderr || String(result.error));
            const recorded = JSON.parse(result.stdout);
            assert.equal(resolve(recorded.execPath), bundled ? resolve(selected, "app-compiler", nodeName) : resolve(competing, nodeName));
            assert.deepEqual(recorded.args, args);
            assert.deepEqual(recorded.stdin, [...input]);
            assert.equal(result.stderr.trim(), "probe-stderr");
            console.log(`ok  ${name}; cwd=${cwd}; PATH=${path}; process.execPath=${recorded.execPath}`);
          }
        }
      }
      if (bundled) {
        await rm(join(copied, "app-compiler", nodeName));
        for (const name of ["dohc", "dohc-mcp"]) {
          const command = launcherCommand(copied, name, [], shell);
          const result = spawnSync(command.command, command.args, {
            cwd, encoding: "utf8", timeout: 20000,
            env: { ...process.env, PATH: competing, Path: competing, NODE_OPTIONS: "" },
            windowsVerbatimArguments: command.windowsVerbatimArguments, windowsHide: true,
          });
          assert.equal(result.status, 127, result.stderr || String(result.error));
          assert.equal(result.stdout, "");
          assert.equal(result.stderr.trim(), BUNDLED_NODE_MISSING_MESSAGE);
          console.log(`ok  ${name} refuses a missing copied runtime; cwd=${cwd}`);
        }
      }
    }
    const cwd = join(scratch, "mcp-workspace");
    await mkdir(cwd);
    await probeMcp(resources, cwd, join(scratch, "home"), shell, { ...process.env, NODE_OPTIONS: "", PATH: competing, Path: competing });
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export function staticPackageSmoke() {
  // Static packaging gate: asserts the built tree and electron-builder config
  // are release-ready without running electron-builder (no network, no heavy
  // packaging). Run after `electron-vite build`.

  const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const failures = [];

  function check(ok, label) {
    console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
    if (!ok) failures.push(label);
  }

  // --- build outputs ---------------------------------------------------------
  for (const output of ["dist/main/main.js", "dist/main/app.js", "dist/preload/preload.cjs", "dist/renderer/index.html"]) {
    check(existsSync(join(desktopDir, output)), `build output exists: ${output}`);
  }
  for (const worker of ["workspace-database-worker", "document-projection-worker", "workspace-files-worker", "collection-history-worker"]) {
    check(
      existsSync(join(desktopDir, `dist/main/${worker}.js`)),
      `build output exists: dist/main/${worker}.js`,
    );
  }
  for (const icon of ["build/icon.png", "build/icon.ico", "build/icon-light.png", "build/icon-dark.png", "build/icon.icns", "build/trayTemplate.png", "build/trayTemplate@2x.png"]) {
    check(existsSync(join(desktopDir, icon)), `icon exists: ${icon}`);
  }
  for (const failure of agentResourceFailures(join(desktopDir, "resources"))) check(false, failure);
  const engineBinary = `dohc-workspace-engine${process.platform === "win32" ? ".exe" : ""}`;
  check(
    existsSync(join(desktopDir, "resources/workspace-engine", engineBinary)),
    "bundled Rust workspace engine exists",
  );

  // --- package metadata ------------------------------------------------------
  const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
  check(pkg.name.includes("dohc"), `package name carries dohc (${pkg.name})`);
  check(pkg.main === "dist/main/main.js", "package main points at the built entry");
  check(typeof pkg.version === "string" && pkg.version.length > 0, "package version set (artifact naming)");
  check(
    pkg.desktopName === "dohc.desktop",
    "Linux runtime desktopName matches the generated launcher name",
  );

  // --- electron-builder config ----------------------------------------------
  // js-yaml ships in the workspace through electron-builder's own tree;
  // resolved at runtime instead of adding a direct dependency for one parse.
  let config = null;
  try {
    const require = createRequire(import.meta.url);
    const yaml = require("js-yaml");
    config = yaml.load(readFileSync(join(desktopDir, "electron-builder.yml"), "utf8"));
  } catch (error) {
    check(false, `electron-builder.yml parses (${error.message})`);
  }

  if (config) {
    check(true, "electron-builder.yml parses");
    check(config.productName === "dohc", "productName is dohc");
    check(typeof config.appId === "string" && config.appId.includes("dohc"), `appId carries dohc (${config.appId})`);
    check(config.executableName === "dohc", "executableName is filesystem-safe");
    check(config.linux?.executableName === "dohc-desktop", "the Linux app's command leaves dohc to the chat CLI");
    check(
      config.linux?.syncDesktopName === true,
      "Linux launcher filename and StartupWMClass sync to desktopName",
    );
    check(config.asar === true, "asar is enabled");
    check(
      config.beforePack === "scripts/require-workspace-engine.mjs",
      "packaging refuses a missing Rust workspace engine",
    );
    check(Array.isArray(config.files) && config.files.includes("dist/**"), "files ship the built dist tree");
    const extraResources = Array.isArray(config.extraResources) ? config.extraResources : [];
    const compilerResource = extraResources.find(
      entry => entry?.from === "resources/app-compiler" && entry?.to === "app-compiler",
    );
    check(compilerResource?.filter?.includes("**/*") === true,
      "app compiler ships all staged assets as unpacked extraResources");
    const backendResource = extraResources.find(entry => entry?.from === "resources/app-backend-runtime" && entry?.to === "app-backend-runtime");
    check(backendResource?.filter?.includes("**/*") === true,
      "app backend runtime ships its child and Wasm closure as unpacked extraResources");
    check(
      extraResources.some(
        (entry) => entry?.from === "build/icon.png" && entry?.to === "icon.png",
      ),
      "window icon ships as an extraResource",
    );
    for (const theme of ["light", "dark"]) {
      check(
        extraResources.some(
          (entry) =>
            entry?.from === `build/icon-${theme}.png` &&
            entry?.to === `icon-${theme}.png`,
        ),
        `${theme} system theme icon ships as an extraResource`,
      );
    }
    const cliBinResource = extraResources.find(
      (entry) => entry?.from === "resources/cli-bin" && entry?.to === "cli-bin",
    );
    check(Boolean(cliBinResource), "dohc chat CLI ships as an unpacked extraResource");
    // resolveDohcMcpCommand points packaged chat session configs at these two
    // files by absolute path -- a filter that omits them ships sessions with
    // no dohc MCP tools.
    for (const launcher of ["dohc", "dohc.cmd", "dohc.mjs", "dohc-mcp", "dohc-mcp.cmd", "dohc-mcp.mjs"]) {
      check(
        cliBinResource?.filter?.includes(launcher) === true,
        `cli-bin extraResource ships ${launcher}`,
      );
    }

    // Fuse hardening intent: electron-builder >=24.12 flips these itself via
    // @electron/fuses at package time — no afterPack hook needed.
    const FUSE_EXPECTATIONS = {
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      // true is load-bearing: the renderer is module scripts over file://
      // (CORS-mode fetches). scripts/fuse-smoke.mjs proves the boot behavior.
      grantFileProtocolExtraPrivileges: true,
    };
    for (const [fuse, expected] of Object.entries(FUSE_EXPECTATIONS)) {
      check(config.electronFuses?.[fuse] === expected, `electronFuses.${fuse} === ${expected}`);
    }

    // Signing safety: never fake a signature, never hard-require one in the
    // committed config (release pipelines opt in with -c.forceCodeSigning=true).
    check(config.mac?.identity === undefined, "mac.identity is not hard-coded");
    check(config.forceCodeSigning !== true, "forceCodeSigning stays a release-pipeline opt-in");
    const publishConfig = Array.isArray(config.publish)
      ? config.publish[0]
      : config.publish;
    if (publishConfig?.provider === "github") {
      check(publishConfig.owner === "dohchq", "publish GitHub owner is dohchq");
      check(publishConfig.repo === "dohc", "publish GitHub repo is dohc");
      check(
        publishConfig.channel === "latest" || publishConfig.channel === "nightly",
        `publish channel is explicit (${publishConfig.channel ?? "missing"})`,
      );
    } else {
      check(publishConfig?.provider === "generic", "publish provider is generic or github");
      check(
        typeof publishConfig?.url === "string" &&
          publishConfig.url.startsWith("https://") &&
          !publishConfig.url.includes(".invalid"),
        `publish URL is release-ready (${publishConfig?.url ?? "missing"})`,
      );
    }
    const fileExtensions = config.fileAssociations?.flatMap((entry) =>
      Array.isArray(entry.ext) ? entry.ext : [entry.ext],
    ) ?? [];
    // Markdown may make dohc its default app; text, CSV and JSON never do.
    const expectedRanks = { md: "Default", markdown: "Default", txt: "Alternate", csv: "Alternate", json: "Alternate" };
    for (const [ext, rank] of Object.entries(expectedRanks)) {
      check(fileExtensions.includes(ext), `Open with dohc association includes .${ext}`);
      const entry = config.fileAssociations?.find((candidate) => [candidate.ext].flat().includes(ext));
      check(entry?.rank === rank, `.${ext} association ranks dohc ${rank} (${entry?.rank ?? "missing"})`);
    }
    // A Linux desktop entry names types, not extensions.
    for (const type of ["text/markdown", "text/plain", "text/csv", "application/json"]) {
      check(config.linux?.mimeTypes?.includes(type), `Linux Open with dohc includes ${type}`);
    }
    // deb.depends replaces electron-builder's default list (app-builder-lib's
    // FpmTarget.getDefaultDepends), so it repeats that list and adds the
    // libraries Electron links that the list does not bring. Without one, the
    // .deb still installs, then the app does not start.
    for (const dependency of [
      "libgtk-3-0",
      "libnotify4",
      "libnss3",
      "libxss1",
      "libxtst6",
      "xdg-utils",
      "libatspi2.0-0",
      "libuuid1",
      "libsecret-1-0",
      "libasound2t64 | libasound2",
      "libgbm1",
    ]) {
      check(config.deb?.depends?.includes(dependency), `the .deb depends on ${dependency}`);
    }
    check(
      Array.isArray(config.protocols) &&
        config.protocols.length === 1 &&
        config.protocols[0]?.name === "dohc share link" &&
        Array.isArray(config.protocols[0]?.schemes) &&
        config.protocols[0].schemes.length === 1 &&
        config.protocols[0].schemes[0] === "dohc",
      "packaged protocol is the single dohc share-link scheme",
    );
  }

  // --- signing labeling ------------------------------------------------------
  // A production-signed release is never implied: without signing credentials
  // the build is loudly unsigned, and a release that requires signing fails here.
  // A Mac signs with a release keychain identity (CSC_NAME) and notarizes with a
  // notarytool keychain profile; electron-builder skips notarization without
  // one, and Gatekeeper blocks a signed Mac app that is not notarized.
  const mac = process.platform === "darwin";
  const hasSigningCredentials = mac
    ? Boolean(process.env.CSC_NAME && process.env.APPLE_KEYCHAIN_PROFILE)
    : Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK);
  if (process.env.DOHC_REQUIRE_SIGNING === "1") {
    check(hasSigningCredentials, mac
      ? "DOHC_REQUIRE_SIGNING=1 on macOS demands CSC_NAME and APPLE_KEYCHAIN_PROFILE in the env"
      : "DOHC_REQUIRE_SIGNING=1 demands CSC_LINK/WIN_CSC_LINK in the env");
  }
  console.log(hasSigningCredentials
    ? "SIGNING: credentials present"
    : "SIGNING: unsigned (dev)");

  if (failures.length > 0) {
    console.error(`\nPackage smoke FAILED (${failures.length} check${failures.length === 1 ? "" : "s"}).`);
    process.exit(1);
  }
  console.log("\nPackage smoke passed.");

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 2) staticPackageSmoke();
  else if (process.argv.length === 5 && process.argv[2] === "--resources" && process.argv[4] === "--agent-launchers") await probeAgentLaunchers(process.argv[3]);
  else throw new Error("Usage: package-smoke.mjs [--resources <absolute-directory> --agent-launchers]");
}
