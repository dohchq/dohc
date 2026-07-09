import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendCliRequest } from "./client";
import { DohcCliError } from "./errors";

const TOKEN = "a".repeat(64);
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempStateDir(withToken = true): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-cli-test-"));
  cleanupDirs.push(dir);
  if (withToken) await writeFile(join(dir, "dohc-cli-token"), `${TOKEN}\n`, { mode: 0o600 });
  return dir;
}

describe("sendCliRequest", () => {
  it("reads the boot token and validates a concrete success response", async () => {
    const stateDir = await tempStateDir();
    const transport = vi.fn(async () => ({
      protocolVersion: 1,
      ok: true,
      result: {
        channels: [{ id: "ch_one", name: "One", slug: "one", kind: "channel" }],
      },
    }));
    const result = await sendCliRequest(
      {
        protocolVersion: 1,
        verb: "channels",
        args: { cwd: "/workspace", actor: "human" },
      },
      { stateDir, transport },
    );
    expect(result).toEqual({
      channels: [{ id: "ch_one", name: "One", slug: "one", kind: "channel" }],
    });
    expect(transport).toHaveBeenCalledWith(
      join(stateDir, "dohc-cli.sock"),
      JSON.stringify({
        token: TOKEN,
        protocolVersion: 1,
        verb: "channels",
        args: { cwd: "/workspace", actor: "human" },
      }),
      undefined,
    );
  });

  it("reports a protocol mismatch before validating a future response shape", async () => {
    const stateDir = await tempStateDir();
    await expect(
      sendCliRequest(
        {
          protocolVersion: 1,
          verb: "channels",
          args: { cwd: "/workspace", actor: "human" },
        },
        {
          stateDir,
          transport: async () => ({
            protocolVersion: 2,
            status: "future-error-shape",
            detail: { restartRequired: true },
          }),
        },
      ),
    ).rejects.toThrow("CLI/app version mismatch — restart the app");
  });

  it("forwards an explicit response timeout without imposing a default", async () => {
    const stateDir = await tempStateDir();
    const transport = vi.fn(async () => ({
      protocolVersion: 1,
      ok: true,
      result: { channels: [] },
    }));
    await sendCliRequest(
      {
        protocolVersion: 1,
        verb: "channels",
        args: { cwd: "/workspace", actor: "human" },
      },
      { stateDir, timeoutMs: 1_234, transport },
    );
    expect(transport).toHaveBeenCalledWith(
      join(stateDir, "dohc-cli.sock"),
      expect.any(String),
      1_234,
    );
  });

  it("rejects a malformed per-verb result", async () => {
    const stateDir = await tempStateDir();
    await expect(
      sendCliRequest(
        {
          protocolVersion: 1,
          verb: "channels",
          args: { cwd: "/workspace", actor: "human" },
        },
        {
          stateDir,
          transport: async () => ({
            protocolVersion: 1,
            ok: true,
            result: { channels: [{ id: 5 }] },
          }),
        },
      ),
    ).rejects.toThrow("desktop app returned an invalid response");
  });

  it("maps a missing boot token to desktop-not-running", async () => {
    const stateDir = await tempStateDir(false);
    await expect(
      sendCliRequest(
        {
          protocolVersion: 1,
          verb: "channels",
          args: { cwd: "/workspace", actor: "human" },
        },
        { stateDir },
      ),
    ).rejects.toThrow("desktop app not running");
  });

  it("falls through a stale preferred endpoint to an active desktop endpoint", async () => {
    const home = await mkdtemp(join(tmpdir(), "dohc-cli-home-"));
    cleanupDirs.push(home);
    const configHome = join(home, "config");
    const stale = join(configHome, "dohc");
    const active = join(configHome, "@dohc", "desktop");
    await Promise.all([mkdir(stale, { recursive: true }), mkdir(active, { recursive: true })]);
    for (const dir of [stale, active]) {
      await writeFile(join(dir, "dohc-cli-token"), `${TOKEN}\n`);
      await writeFile(join(dir, "dohc-cli.sock"), "endpoint marker");
    }
    const attempted: string[] = [];
    const result = await sendCliRequest(
      {
        protocolVersion: 1,
        verb: "channels",
        args: { cwd: "/workspace", actor: "human" },
      },
      {
        env: { XDG_CONFIG_HOME: configHome },
        homeDir: home,
        platform: "linux",
        transport: async (socketPath) => {
          attempted.push(socketPath);
          if (socketPath === join(stale, "dohc-cli.sock")) {
            throw new DohcCliError("desktop app not running");
          }
          return {
            protocolVersion: 1,
            ok: true,
            result: { channels: [] },
          };
        },
      },
    );
    expect(result).toEqual({ channels: [] });
    expect(attempted).toEqual([
      join(stale, "dohc-cli.sock"),
      join(active, "dohc-cli.sock"),
    ]);
  });
});
