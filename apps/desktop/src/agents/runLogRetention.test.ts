import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readUserSettingsFile, USER_SETTINGS_FILE } from "../settings/userSettingsStore";
import { removeExpiredRunLogs, RUN_LOG_FOLDER, runLogKeepDays } from "./runLogRetention";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-11T12:00:00Z");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A state folder whose run-logs hold each file, last written `daysAgo` before NOW.
async function stateWith(files: Record<string, number>): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), "dohc-run-logs-"));
  dirs.push(stateDir);
  const folder = join(stateDir, RUN_LOG_FOLDER);
  await mkdir(folder);
  for (const [name, daysAgo] of Object.entries(files)) {
    const path = join(folder, name);
    await writeFile(path, "output\n");
    const at = new Date(NOW - daysAgo * DAY_MS);
    await utimes(path, at, at);
  }
  return stateDir;
}

const left = async (stateDir: string) => (await readdir(join(stateDir, RUN_LOG_FOLDER))).sort();

describe("removeExpiredRunLogs", () => {
  it("removes only finished runs' files older than the limit", async () => {
    const stateDir = await stateWith({
      "run-old.log": 31, "run-old.log.node": 31, "run-old.log.mcp.json": 31,
      "run-recent.log": 29,
      "run-live.log": 45,
      "notes.txt": 90,
    });
    await removeExpiredRunLogs({ stateDir, keepDays: 30, nowMs: NOW, isRunning: (runId) => runId === "run-live" });
    expect(await left(stateDir)).toEqual(["notes.txt", "run-live.log", "run-recent.log"]);
  });

  it("follows a longer limit from the settings file, and keeps every log when it is forever", async () => {
    const stateDir = await stateWith({ "run-a.log": 31, "run-b.log": 400 });
    await removeExpiredRunLogs({ stateDir, keepDays: 90, nowMs: NOW, isRunning: () => false });
    expect(await left(stateDir)).toEqual(["run-a.log"]);
    await removeExpiredRunLogs({ stateDir, keepDays: "forever", nowMs: NOW + 1000 * DAY_MS, isRunning: () => false });
    expect(await left(stateDir)).toEqual(["run-a.log"]);
  });

  it("does nothing before any run wrote a log", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "dohc-run-logs-"));
    dirs.push(stateDir);
    await expect(removeExpiredRunLogs({ stateDir, keepDays: 30, nowMs: NOW, isRunning: () => false })).resolves.toBeUndefined();
  });
});

describe("runLogKeepDays", () => {
  // The limit dohc sweeps with when the settings file holds this text.
  async function limitFor(text: string) {
    const dir = await mkdtemp(join(tmpdir(), "dohc-run-log-settings-"));
    dirs.push(dir);
    await writeFile(join(dir, USER_SETTINGS_FILE), text);
    return runLogKeepDays(await readUserSettingsFile(dir));
  }

  it("uses the limit the settings file sets", async () => {
    expect(await limitFor(JSON.stringify({ version: 2, agentRunLogs: { keepDays: 90 } }))).toBe(90);
    expect(await limitFor(JSON.stringify({ version: 2 }))).toBe(30);
  });

  it("keeps every log while dohc cannot read the file or its limit", async () => {
    expect(await limitFor('{ "version": 2, "agentRunLogs": { "keepDays": 365 }')).toBe("forever");
    expect(await limitFor(JSON.stringify({ version: 2, agentRunLogs: { keepDays: "a year" } }))).toBe("forever");
    expect(await limitFor(JSON.stringify({ version: 2, agentRunLogs: 365 }))).toBe("forever");
    const unknown = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`unknown${index}`, true]));
    expect(await limitFor(JSON.stringify({ version: 2, ...unknown, agentRunLogs: { keepDays: "a year" } }))).toBe("forever");
  });
});
