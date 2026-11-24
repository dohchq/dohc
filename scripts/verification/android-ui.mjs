// The Android sample check: installs the sample app, opens each tab and a few screens through dohc:// links in light,
// then dark, and fails when the app dies, logs a crash or a JavaScript error, or a screen never shows its label.
// Usage, from the repository root, with one emulator on adb: node scripts/verification/android-ui.mjs <apk> <out dir>
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";

const app = "app.dohc.mobile";
// Each screen's link and an attribute only that screen shows. The page's is a line of the sample note, so its editor ran.
const screens = [
  ["chats", "dohc:///", 'content-desc="planning, unread, 2 new"'],
  ["home", "dohc:///home", 'content-desc="Workspace: Lisbon trip. Switch workspace"'],
  ["search", "dohc:///search", 'text="Search"'],
  ["notices", "dohc:///notices", 'content-desc="Mark all read"'],
  ["page", "dohc:///page?path=trip%2Fpacking-list.md", 'text="First-aid kit"'],
  ["chat", "dohc:///chat/g-planning?name=planning", 'text="#planning"'],
  ["settings", "dohc:///settings", 'text="Settings"'],
];

const adb = (...args) => execFileSync("adb", args, { encoding: "utf8", maxBuffer: 64 << 20 });
const shell = (command) => adb("shell", command);
const alive = () => shell(`pidof ${app} || true`).trim() !== "";
const screenText = () => {
  shell("uiautomator dump /sdcard/ui.xml > /dev/null");
  return shell("cat /sdcard/ui.xml");
};
// Crashes and the app's own JavaScript errors since the log was last cleared.
const problems = () =>
  adb("logcat", "-d", "-v", "brief", "AndroidRuntime:E", "ReactNativeJS:E", "*:S")
    .split("\n")
    .filter((line) => /^E\/(AndroidRuntime|ReactNativeJS)/u.test(line));

async function waitFor(label, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive()) return "the app is not running";
    try {
      if (screenText().includes(label)) return "";
    } catch {
      // uiautomator fails while the screen changes; read it again.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return `"${label}" never appeared`;
}

const [apk, out] = process.argv.slice(2);
if (!apk || !out) throw new Error("usage: android-ui.mjs <apk> <out dir>");
mkdirSync(out, { recursive: true });
adb("install", "-r", apk);
let failed = 0;
for (const mode of ["light", "dark"]) {
  shell(`cmd uimode night ${mode === "dark" ? "yes" : "no"}`);
  shell(`am force-stop ${app}`);
  adb("logcat", "-c");
  for (const [name, link, label] of screens) {
    shell(`am start -W -a android.intent.action.VIEW -d '${link}' ${app} > /dev/null`);
    const missing = await waitFor(label);
    const logged = problems();
    writeFileSync(
      `${out}/${name}-${mode}.png`,
      execFileSync("adb", ["exec-out", "screencap", "-p"]),
    );
    const verdict = [missing, ...logged].filter(Boolean);
    console.log(
      `${verdict.length ? "FAIL" : "PASS"} ${name} ${mode}${verdict.map((line) => `\n  ${line}`).join("")}`,
    );
    if (verdict.length) failed += 1;
    appendFileSync(`${out}/logcat.txt`, `== ${name} ${mode}\n${adb("logcat", "-d")}`);
    adb("logcat", "-c");
    if (!alive()) shell(`am start -W -n ${app}/.MainActivity > /dev/null`);
  }
}
if (failed) {
  console.error(`${failed} of ${screens.length * 2} screens failed.`);
  process.exit(1);
}
