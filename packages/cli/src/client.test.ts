import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendCliRequest } from "./client";
import { DohcCliError } from "./errors";
import { CLI_PROTOCOL_VERSION } from "./protocol";

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

const PIPE = `\\\\.\\pipe\\dohc-cli-${"9f".repeat(16)}`;

async function describeEndpoint(stateDir: string, pipeName: string): Promise<void> {
  await writeFile(join(stateDir, "dohc-cli-endpoint"), `${pipeName}\n`);
}

describe("sendCliRequest", () => {
  it("reads the boot token and validates a concrete success response", async () => {
    const stateDir = await tempStateDir();
    const transport = vi.fn(async () => ({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: true,
      result: {
        channels: [{ id: "ch_one", name: "One", slug: "one", kind: "channel" }],
      },
    }));
    const result = await sendCliRequest(
      {
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "channels",
        args: { cwd: "/workspace", actor: "human" },
      },
      { stateDir, transport, platform: "linux" },
    );
    expect(result).toEqual({
      channels: [{ id: "ch_one", name: "One", slug: "one", kind: "channel" }],
    });
    expect(transport).toHaveBeenCalledWith(
      join(stateDir, "dohc-cli.sock"),
      JSON.stringify({
        token: TOKEN,
        protocolVersion: CLI_PROTOCOL_VERSION,
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
          protocolVersion: CLI_PROTOCOL_VERSION,
          verb: "channels",
          args: { cwd: "/workspace", actor: "human" },
        },
        {
          stateDir,
          platform: "linux",
          transport: async () => ({
            protocolVersion: CLI_PROTOCOL_VERSION + 1,
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
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: true,
      result: { channels: [] },
    }));
    await sendCliRequest(
      {
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "channels",
        args: { cwd: "/workspace", actor: "human" },
      },
      { stateDir, timeoutMs: 1_234, transport, platform: "linux" },
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
          protocolVersion: CLI_PROTOCOL_VERSION,
          verb: "channels",
          args: { cwd: "/workspace", actor: "human" },
        },
        {
          stateDir,
          platform: "linux",
          transport: async () => ({
            protocolVersion: CLI_PROTOCOL_VERSION,
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
          protocolVersion: CLI_PROTOCOL_VERSION,
          verb: "channels",
          args: { cwd: "/workspace", actor: "human" },
        },
        { stateDir, platform: "linux" },
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
        protocolVersion: CLI_PROTOCOL_VERSION,
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
            protocolVersion: CLI_PROTOCOL_VERSION,
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

  it("dials the Windows pipe named by the endpoint descriptor", async () => {
    const stateDir = await tempStateDir();
    await describeEndpoint(stateDir, PIPE);
    const transport = vi.fn(async () => ({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: true,
      result: { channels: [] },
    }));
    const result = await sendCliRequest(
      {
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "channels",
        args: { cwd: "C:\\workspace", actor: "human" },
      },
      { stateDir, transport, platform: "win32" },
    );
    expect(result).toEqual({ channels: [] });
    // The pipe name carries the per-boot entropy, so it must come from the
    // descriptor rather than from the state dir path.
    expect(transport).toHaveBeenCalledWith(PIPE, expect.any(String), undefined);
  });

  it("never sends the boot token to a descriptor that does not name a dohc pipe", async () => {
    const transport = vi.fn(async () => ({
      protocolVersion: CLI_PROTOCOL_VERSION,
      ok: true,
      result: { channels: [] },
    }));
    for (
      const described of [
        "\\\\.\\pipe\\attacker-listener",
        "\\\\evil-host\\pipe\\dohc-cli-00112233445566778899aabbccddeeff",
        "C:\\Users\\someone\\dohc-cli.sock",
        "",
      ]
    ) {
      const stateDir = await tempStateDir();
      await describeEndpoint(stateDir, described);
      await expect(
        sendCliRequest(
          {
            protocolVersion: CLI_PROTOCOL_VERSION,
            verb: "channels",
            args: { cwd: "C:\\workspace", actor: "human" },
          },
          { stateDir, transport, platform: "win32" },
        ),
      ).rejects.toThrow("desktop app not running");
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("skips a Windows state dir with no endpoint descriptor", async () => {
    const home = await mkdtemp(join(tmpdir(), "dohc-cli-home-"));
    cleanupDirs.push(home);
    const appData = join(home, "AppData", "Roaming");
    const stale = join(appData, "dohc");
    const active = join(appData, "@dohc", "desktop");
    await Promise.all([
      mkdir(stale, { recursive: true }),
      mkdir(active, { recursive: true }),
    ]);
    for (const dir of [stale, active]) {
      await writeFile(join(dir, "dohc-cli-token"), `${TOKEN}\n`);
    }
    await describeEndpoint(active, PIPE);
    const attempted: string[] = [];
    const result = await sendCliRequest(
      {
        protocolVersion: CLI_PROTOCOL_VERSION,
        verb: "channels",
        args: { cwd: "C:\\workspace", actor: "human" },
      },
      {
        env: { APPDATA: appData },
        homeDir: home,
        platform: "win32",
        transport: async (socketPath) => {
          attempted.push(socketPath);
          return {
            protocolVersion: CLI_PROTOCOL_VERSION,
            ok: true,
            result: { channels: [] },
          };
        },
      },
    );
    expect(result).toEqual({ channels: [] });
    expect(attempted).toEqual([PIPE]);
  });
});
