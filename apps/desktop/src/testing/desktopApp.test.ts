import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ output: "", launch: vi.fn(), close: vi.fn() }));
vi.mock("@playwright/test", () => ({ test: { info: () => ({
  outputPath: (name: string) => join(fixture.output, name),
  attach: vi.fn(),
}) } }));
vi.mock("playwright", () => ({ _electron: { launch: fixture.launch } }));
vi.mock("../../../../scripts/verification/build.mjs", () => ({ assertPrepared: () => ({ version: 1 }) }));
vi.mock("../../../../scripts/verification/close-electron.mjs", async (original) => ({
  ...await original<typeof import("../../../../scripts/verification/close-electron.mjs")>(),
  closeElectronApplication: fixture.close,
}));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  existsSync: () => true,
}));

import { launchDesktopApp } from "../../e2e/helpers/desktopApp";

afterEach(() => {
  if (fixture.output) rmSync(fixture.output, { recursive: true, force: true });
  vi.clearAllMocks();
});

test("desktop evidence decodes split UTF-8 independently on stdout and stderr", async () => {
  fixture.output = mkdtempSync(join(tmpdir(), "dohc-desktop-log-"));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = { pid: 42, stdout, stderr };
  const page = { on: vi.fn(), isClosed: () => true };
  const app = { process: () => child, firstWindow: async () => page, evaluate: async () => 43 };
  fixture.launch.mockResolvedValue(app);
  fixture.close.mockImplementation(async () => {
    stdout.end(); stderr.end();
    await Promise.all([finished(stdout), finished(stderr)]);
  });
  const desktop = await launchDesktopApp({ workspace: {
    baseDir: fixture.output, homeDir: fixture.output, rootPath: fixture.output,
  } });
  const output = "workspace café/日本語/🛠\n";
  const error = "échec 🧪\n";
  for (const byte of Buffer.from(output)) stdout.write(Buffer.from([byte]));
  for (const byte of Buffer.from(error)) stderr.write(Buffer.from([byte]));
  // A truncated final code point must also flush at stream end.
  stderr.write(Buffer.from([0xe2]));
  await desktop.close();
  expect(fixture.close).toHaveBeenCalledExactlyOnceWith(app, child, 10_000);
  const persisted = readFileSync(join(fixture.launch.mock.calls[0][0].artifactsDir, "desktop.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  for (const entries of [desktop.logs, persisted]) {
    expect(entries.filter((entry) => entry.level === "stdout").map((entry) => entry.text).join("")).toBe(output);
    expect(entries.filter((entry) => entry.level === "stderr").map((entry) => entry.text).join("")).toBe(error + "\ufffd");
  }
});

test("failed desktop launch gives cleanup the renderer and teardown budget", async () => {
  fixture.output = mkdtempSync(join(tmpdir(), "dohc-desktop-launch-failure-"));
  const child = { pid: 42 };
  const failure = new Error("first window failed");
  const app = { process: () => child, firstWindow: async () => { throw failure; } };
  fixture.launch.mockResolvedValue(app);
  fixture.close.mockResolvedValue(undefined);
  await expect(launchDesktopApp({ workspace: {
    baseDir: fixture.output, homeDir: fixture.output, rootPath: fixture.output,
  } })).rejects.toBe(failure);
  expect(fixture.close).toHaveBeenCalledExactlyOnceWith(app, child, 10_000);
});
