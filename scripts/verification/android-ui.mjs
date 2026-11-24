// The Android sample check: installs the sample app, opens each tab and a few screens through dohc:// links in light,
// then dark, and fails when the app dies, logs a crash or a JavaScript error, or a screen never shows its label.
// Usage, from the repository root, with one emulator on adb: node scripts/verification/android-ui.mjs <apk> <out dir>
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

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
const now = () => shell("date +'%m-%d %H:%M:%S.000'").trim();
// The app's crashes, JavaScript errors, and web view renderer crashes logged since a device time.
// Other processes, such as uiautomator, don't count.
const problems = (since, uid) =>
  adb(
    "logcat",
    "-d",
    "-T",
    since,
    `--uid=${uid}`,
    "-v",
    "brief",
    "AndroidRuntime:E",
    "ReactNativeJS:E",
    "RNCWebViewClient:E",
    "*:S",
  )
    .split("\n")
    .filter((line) => /^E\/(AndroidRuntime|ReactNativeJS|RNCWebViewClient)/u.test(line));

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
const uid = shell(`pm list packages -U ${app}`).match(/uid:(\d+)/u)[1];
let failed = 0;
let since = now();
for (const mode of ["light", "dark"]) {
  shell(`cmd uimode night ${mode === "dark" ? "yes" : "no"}`);
  shell(`am force-stop ${app}`);
  for (const [name, link, label] of screens) {
    shell(`am start -W -a android.intent.action.VIEW -d '${link}' ${app} > /dev/null`);
    const missing = await waitFor(label);
    writeFileSync(
      `${out}/${name}-${mode}.png`,
      execFileSync("adb", ["exec-out", "screencap", "-p"], { maxBuffer: 64 << 20 }),
    );
    // The next screen reads from this read's start, so a crash between screens counts.
    const read = now();
    const logged = problems(since, uid);
    const running = alive();
    const verdict = [missing, missing || running ? "" : "the app stopped", ...logged].filter(
      Boolean,
    );
    since = read;
    console.log(
      `${verdict.length ? "FAIL" : "PASS"} ${name} ${mode}${verdict.map((line) => `\n  ${line}`).join("")}`,
    );
    if (verdict.length) failed += 1;
    if (!running) shell(`am start -W -n ${app}/.MainActivity > /dev/null`);
  }
}
// An error logged after the last screen's read.
const late = problems(since, uid);
if (late.length)
  console.log(`FAIL after the last screen${late.map((line) => `\n  ${line}`).join("")}`);
writeFileSync(`${out}/logcat.txt`, adb("logcat", "-d"));
if (failed || late.length) {
  console.error(
    `${failed} of ${screens.length * 2} screens failed${late.length ? ", and the app logged an error after the last" : ""}.`,
  );
  process.exit(1);
}
