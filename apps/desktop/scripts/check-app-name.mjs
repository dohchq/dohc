// Checks, on macOS or Linux, what the desktop's app naming does to a current
// tester's profile: the settings folder it resolves, and the name Electron
// gives the secret that protects a saved sign-in. It starts the pinned
// Electron once, with no window, in a temporary home holding a copy of
// fixtures/app-name-profile laid out under the old folder name. It reads and
// writes nothing outside that home, and never touches the keychain.
//
//   pnpm --filter @dohc/desktop exec node scripts/check-app-name.mjs
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(desktopDir, "scripts/fixtures/app-name-profile");
const packageName = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8")).name;

// The probe app: the desktop's package name, as Electron reads it before main
// runs, and the desktop's own nameApp, called first, as src/entry.ts does.
const PROBE = `
import { app } from "electron";
import { readdirSync } from "node:fs";
import { nameApp } from "./appName.mjs";
const home = process.env.HOME;
const appData = app.getPath("appData");
// Stop before resolving a settings folder outside the temporary home.
if (!appData.startsWith(home)) {
  console.log(JSON.stringify({ refused: appData }));
  app.exit(2);
} else {
  nameApp(app);
  app.dock?.hide();
  // Not awaited at the top level: Electron is ready only once this module has loaded.
  void app.whenReady().then(() => {
    console.log(JSON.stringify({
      appName: app.name,
      // Electron 43 names the macOS keychain item, and the Linux keyring
      // entry's application, from app.name once main has loaded
      // (electron_browser_main_parts.cc, PostCreateMainMessageLoop).
      keychainService: app.name + " Safe Storage",
      settingsFolder: app.getPath("userData"),
      settingsFiles: readdirSync(app.getPath("userData")).sort(),
    }));
    app.exit(0);
  });
}
`;

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashes = (dir) => Object.fromEntries(readdirSync(fixture).map((name) => [name, sha256(join(dir, name))]));

async function check() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("This check runs on macOS and Linux, where a temporary HOME moves the app data folder.");
  }
  // Real path, so Electron's answers compare with it (macOS's /var is /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dohc-app-name-")));
  try {
    const home = join(root, "home");
    const appData = process.platform === "darwin" ? join(home, "Library/Application Support") : join(home, ".config");
    const oldFolder = join(appData, packageName);
    mkdirSync(oldFolder, { recursive: true });
    cpSync(fixture, oldFolder, { recursive: true });
    const before = hashes(oldFolder);

    const probe = join(root, "probe");
    mkdirSync(probe);
    writeFileSync(join(probe, "package.json"), JSON.stringify({ name: packageName, type: "module", main: "main.mjs" }));
    writeFileSync(join(probe, "main.mjs"), PROBE);
    await build({ entryPoints: [join(desktopDir, "src/appName.ts")], outfile: join(probe, "appName.mjs"),
      bundle: true, format: "esm", platform: "node", external: ["electron"], logLevel: "silent" });

    const electron = createRequire(import.meta.url)("electron");
    const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electron, [probe], { env, encoding: "utf8", timeout: 60_000 });
    const line = run.stdout.split("\n").find((text) => text.startsWith("{"));
    if (!line) throw new Error(`The probe printed nothing (exit ${run.status}).\n${run.stderr}`);
    const found = JSON.parse(line);
    if (found.refused) throw new Error(`Electron's app data folder ignored the temporary home: ${found.refused}. Nothing was resolved there.`);

    const failures = [];
    if (found.appName !== "dohc") failures.push(`app name is ${found.appName}, not dohc`);
    if (found.keychainService !== "dohc Safe Storage") failures.push(`the key is stored as ${found.keychainService}`);
    if (realpathSync(found.settingsFolder) !== realpathSync(oldFolder)) failures.push(`settings folder is ${found.settingsFolder}, not ${oldFolder}`);
    const after = hashes(oldFolder);
    for (const [name, hash] of Object.entries(before)) {
      if (after[name] !== hash) failures.push(`${name} changed`);
      if (!found.settingsFiles.includes(name)) failures.push(`the app didn't find ${name}`);
    }
    console.log(`App name: ${found.appName}`);
    console.log(`Key stored as: ${found.keychainService}`);
    console.log(`Settings folder: ${found.settingsFolder} (${process.platform === "darwin" ? "Library/Application Support" : ".config"}/${packageName} in the temporary home)`);
    console.log(`Tester files found unchanged: ${Object.keys(before).join(", ")}`);
    if (failures.length > 0) throw new Error(`App name check failed:\n- ${failures.join("\n- ")}`);
    console.log("App name check passed.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await check().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
