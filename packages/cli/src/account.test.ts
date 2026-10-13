import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { formatStoredBytes, type ServerAccountDeletionPreview } from "./account";
import { executeCli } from "./index";
import type { CliRequestWithoutToken } from "./protocol";
import { readPassword } from "./stdin";

const server = "https://dohc.example.test";
const PASSWORD = "correct horse battery";
const preview: ServerAccountDeletionPreview = {
  email: "ice@dohc.dev", server,
  workspaces: [{ workspaceId: "ws-notes", name: "Notes" }],
  workspacesElsewhere: 2, storedBytes: 1536, ownedShareCount: 1, heldGrantCount: 0,
  previewToken: "expiry.digest.signature",
};
const deleteArgv = ["account", "delete", "--server", server, "--preview-token", preview.previewToken];

function expectNoPassword(result: { stdout: string; stderr: string }) {
  expect(result.stdout).not.toContain(PASSWORD);
  expect(result.stderr).not.toContain(PASSWORD);
}

describe("dohc account deletePreview", () => {
  it("asks the app for the preview and prints it with the command that deletes", async () => {
    const request = vi.fn(async (_request: CliRequestWithoutToken) => preview);
    const result = await executeCli({ argv: ["account", "deletePreview"], cwd: "/anywhere", env: {}, request });

    expect(request).toHaveBeenCalledWith(expect.objectContaining({ verb: "accountDeletePreview", args: { cwd: expect.any(String), actor: "human" } }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe([
      `Deleting ice@dohc.dev on ${server} removes it from the server, with:`,
      "  1 workspace on this computer: Notes",
      "  2 workspaces not on this computer",
      "  1.5 KB of stored files, data, apps, chats, and history",
      "  1 share you own. People you shared with lose access and keep their copies.",
      "  your access to 0 shares others gave you",
      "Copies on this computer stay. This cannot be undone.",
      "If you create an account again later, this server will not accept your old copies of these workspaces.",
      "The server's backups keep the data until they expire.",
      "",
      "To delete, run this within five minutes. dohc asks for the account password:",
      `  dohc account delete --server ${server} --preview-token ${preview.previewToken}`,
      "",
    ].join("\n"));
  });

  it("prints the same preview as JSON", async () => {
    const result = await executeCli({ argv: ["account", "deletePreview", "--json"], env: {}, request: async () => preview });
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 2, ...preview });
  });
});

describe("dohc account delete", () => {
  it("sends the password it read, never from argv, and never prints it", async () => {
    const request = vi.fn(async (_request: CliRequestWithoutToken) => ({ ok: true, finished: true, email: "ice@dohc.dev", server }));
    const readPasswordInput = vi.fn(async () => PASSWORD);
    const result = await executeCli({ argv: deleteArgv, env: {}, request, readPassword: readPasswordInput });

    expect(readPasswordInput).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      verb: "accountDelete",
      args: expect.objectContaining({ server, previewToken: preview.previewToken, password: PASSWORD }),
    }));
    expect(deleteArgv.join(" ")).not.toContain(PASSWORD);
    expect(result).toEqual({
      exitCode: 0, stderr: "",
      stdout: `Deleted ice@dohc.dev on ${server}. The dohc app disconnected from this server. Workspaces on this computer stay.\n`,
    });
  });

  it("says the account is blocked while the server finishes", async () => {
    const result = await executeCli({
      argv: [...deleteArgv, "--json"], env: {}, readPassword: async () => PASSWORD,
      request: async () => ({ ok: true, finished: false, email: "ice@dohc.dev", server }),
    });
    expect(JSON.parse(result.stdout)).toEqual({ schemaVersion: 2, ok: true, finished: false, email: "ice@dohc.dev", server });
    expectNoPassword(result);
    const text = await executeCli({
      argv: deleteArgv, env: {}, readPassword: async () => PASSWORD,
      request: async () => ({ ok: true, finished: false, email: "ice@dohc.dev", server }),
    });
    expect(text.stdout).toContain(`ice@dohc.dev on ${server} is blocked. The server will finish removing its data.`);
  });

  it.each([
    ["preview-changed", "The review expired, or what deletion removes changed. Review it again."],
    ["wrong-password", "The password is incorrect. Enter your server account password."],
    ["rate-limited", "The server paused deletion after too many attempts. Wait a few minutes, then try again."],
  ])("exits with the %s refusal and without the password", async (code, reason) => {
    for (const argv of [deleteArgv, [...deleteArgv, "--json"]]) {
      const result = await executeCli({ argv, env: {}, readPassword: async () => PASSWORD, request: async () => ({ ok: false, code, reason }) });
      expect(result).toEqual({ exitCode: 1, stdout: "", stderr: `dohc: ${reason}\n` });
    }
  });

  it("keeps the password out of a failure", async () => {
    const result = await executeCli({
      argv: deleteArgv, env: {}, readPassword: async () => PASSWORD,
      request: async () => { throw new Error("dohc could not reach this server. Check your connection, then try again."); },
    });
    expect(result.exitCode).toBe(1);
    expectNoPassword(result);
  });

  it.each([
    [["account", "delete", "--server", server, "--preview-token", "token", "--password", PASSWORD], "unknown account delete option '--password'"],
    [["account", "delete", PASSWORD, "--server", server, "--preview-token", "token"], `account delete does not accept '${PASSWORD}'`],
    [["account", "delete", "--preview-token", "token"], "account delete requires --server <address> from deletePreview"],
    [["account", "delete", "--server", server], "account delete requires --preview-token <token> from deletePreview"],
  ])("refuses %j before reading a password or calling the app", async (argv, message) => {
    const request = vi.fn(async () => ({}));
    const readPasswordInput = vi.fn(async () => PASSWORD);
    const result = await executeCli({ argv, env: {}, request, readPassword: readPasswordInput });
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: `dohc: ${message}\n` });
    expect(readPasswordInput).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses an empty password without calling the app", async () => {
    const request = vi.fn(async () => ({}));
    const result = await executeCli({ argv: deleteArgv, env: {}, request, readPassword: async () => "" });
    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "dohc: account delete requires the server account password\n" });
    expect(request).not.toHaveBeenCalled();
  });
});

class FakeTerminal extends EventEmitter {
  isTTY = true;
  raw: boolean[] = [];
  setRawMode(mode: boolean) { this.raw.push(mode); return this; }
  setEncoding() { return this; }
  resume() { return this; }
  pause() { return this; }
}

function sink() {
  let written = "";
  const stream = new Writable({ write(chunk, _encoding, done) { written += String(chunk); done(); } });
  return { stream, written: () => written };
}

describe("readPassword", () => {
  it("reads piped stdin without its final line break", async () => {
    const prompt = sink();
    expect(await readPassword(Readable.from([`${PASSWORD}\r\n`]) as unknown as NodeJS.ReadStream, prompt.stream)).toBe(PASSWORD);
    expect(prompt.written()).toBe("");
  });

  it("asks on a terminal without echoing, and handles backspace", async () => {
    const terminal = new FakeTerminal();
    const prompt = sink();
    const read = readPassword(terminal as unknown as NodeJS.ReadStream, prompt.stream);
    terminal.emit("data", "secrex");
    terminal.emit("data", "\u007ft\r");
    expect(await read).toBe("secret");
    expect(prompt.written()).toBe("Server account password: \n");
    expect(terminal.raw).toEqual([true, false]);
  });

  it("stops on Ctrl-C", async () => {
    const terminal = new FakeTerminal();
    const read = readPassword(terminal as unknown as NodeJS.ReadStream, sink().stream);
    terminal.emit("data", "abc\u0003");
    await expect(read).rejects.toThrow("cancelled");
    expect(terminal.raw).toEqual([true, false]);
  });
});

describe("formatStoredBytes", () => {
  it.each([
    [0, "0 bytes"], [1, "1 byte"], [1023, "1023 bytes"], [1536, "1.5 KB"],
    [5 * 1024 * 1024, "5.0 MB"], [25 * 1024 ** 3, "25 GB"],
  ])("formats %i bytes", (bytes, text) => {
    expect(formatStoredBytes(bytes)).toBe(text);
  });
});
