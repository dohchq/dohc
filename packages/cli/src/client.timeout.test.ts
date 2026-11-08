import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { executeCli } from "./index";

const transport = vi.hoisted(() => ({ socket: undefined as undefined | EventEmitter,
  setTimeout: vi.fn(), destroy: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: () => {
  const socket = Object.assign(new EventEmitter(), { setEncoding: vi.fn(),
    setTimeout: transport.setTimeout, destroy: transport.destroy, write: vi.fn(), end: vi.fn() });
  transport.socket = socket;
  return socket;
} }));

it.each([
  { argv: ["chat", "groups"], timeoutMs: 30_000, stderr: "dohc: desktop app did not respond\n" },
  { argv: ["history", "undo", "dohc-operation:11111111-1111-4111-8111-111111111111"], timeoutMs: 90_000,
    stderr: "dohc: Undo may still be finishing. Run the same command again to get its result.\n" },
  // The windows may take 30 s to save before the change runs.
  { argv: ["version", "switch", "Draft"], timeoutMs: 90_000,
    stderr: "dohc: The version change may still be finishing. Run dohc version list or dohc version conflicts before you try again.\n" },
])("reports a socket deadline accurately ($argv.0 $argv.1)", async ({ argv, timeoutMs, stderr }) => {
  const stateDir = await mkdtemp(join(tmpdir(), "dohc-cli-timeout-"));
  transport.socket = undefined; transport.setTimeout.mockClear(); transport.destroy.mockClear();
  try {
    await writeFile(join(stateDir, "dohc-cli-token"), "a".repeat(64));
    await writeFile(join(stateDir, "dohc-cli.sock"), "endpoint marker");
    const pending = executeCli({ argv, env: {}, client: { stateDir, platform: "linux" } });
    await vi.waitFor(() => expect(transport.socket?.listenerCount("timeout")).toBe(1));
    expect(transport.setTimeout).toHaveBeenCalledWith(timeoutMs);
    transport.socket!.emit("connect");
    transport.socket!.emit("timeout");
    expect(await pending).toEqual({ exitCode: 1, stdout: "", stderr });
    expect(transport.destroy).toHaveBeenCalledOnce();
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
