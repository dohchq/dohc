import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseHostEpoch } from "@dohc/live-session-contract/host-control";
import { prepareDeviceHostCredentialFile } from "./deviceHostCredentialFile.js";
import { openWindowsCredentialAcl } from "./windowsCredentialAcl.js";

// These tests cover the child lifecycle only. Real ACL refusals are proved in deviceHostCredentialFile.windows.test.ts.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

class FakeOutput extends EventEmitter {
  destroyed = false;
  destroy() { this.destroyed = true; return this; }
  // Node destroys a pipe socket with its read error, then emits that error.
  fail(error: Error) { this.destroy(); process.nextTick(() => this.emit("error", error)); }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new FakeOutput();
  readonly stderr = new FakeOutput();
  readonly requests: string[] = [];
  readonly unref = vi.fn();
  readonly killed: Promise<void>;
  // A stuck child accepts kill but never exits. A failing kill matches Node's two failures and also never exits.
  stuck = false;
  killFailure: "throw" | "emit" | undefined;
  exited = false;
  closeEmitted = false;
  readonly kill = vi.fn(() => {
    this.markKilled();
    if (this.exited) return false;
    if (this.killFailure === "throw") throw Object.assign(new Error("kill EINVAL"), { code: "EINVAL" });
    if (this.killFailure === "emit") {
      this.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
      return false;
    }
    if (!this.stuck) this.exit(null);
    return true;
  });
  private markKilled!: () => void;
  private buffered = "";
  private arrived: (() => void) | undefined;

  constructor() {
    super();
    this.killed = new Promise(resolve => { this.markKilled = resolve; });
    this.stdin.on("data", (chunk: Buffer) => {
      const lines = (this.buffered + chunk.toString("utf8")).split("\n");
      this.buffered = lines.pop()!;
      this.requests.push(...lines);
      this.arrived?.();
    });
  }

  async request(index: number): Promise<string[]> {
    while (this.requests.length <= index) await new Promise<void>(resolve => { this.arrived = resolve; });
    return this.requests[index]!.split(" ");
  }

  reply(text: string): void { if (!this.stdout.destroyed) this.stdout.emit("data", Buffer.from(text, "latin1")); }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    process.nextTick(() => { this.closeEmitted = true; this.emit("close", code); });
  }
}

let children: FakeChild[];
const fakeChild = () => {
  const child = new FakeChild();
  children.push(child);
  return child as unknown as ChildProcess;
};
const turn = () => new Promise(resolve => setImmediate(resolve));
function settled(promise: Promise<unknown>) {
  const state = { done: false };
  promise.then(() => { state.done = true; }, () => { state.done = true; });
  return state;
}

beforeEach(() => {
  children = [];
  vi.mocked(spawn).mockImplementation(fakeChild);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
});

it("never starts PowerShell for an operation without checks", async () => {
  await openWindowsCredentialAcl("Assert-Private").close();
  expect(spawn).not.toHaveBeenCalled();
});

it("starts one hidden profile-free PowerShell on first use and pairs each request with its own response", async () => {
  const acl = openWindowsCredentialAcl("Assert-Private");
  expect(spawn).not.toHaveBeenCalled();
  const path = "C:\\cred it's $(calc) `ü 漢 & ; %PATH%";
  const first = acl.check(path, true, true, false);
  expect(spawn).toHaveBeenCalledOnce();
  const [file, args, options] = vi.mocked(spawn).mock.calls[0]!;
  expect(file).toBe(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"));
  expect(args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", expect.stringContaining("Assert-Private")]);
  expect(args.join(" ")).not.toContain(path);
  expect(options).toMatchObject({ windowsHide: true, stdio: "pipe" });
  const child = children[0]!;
  const [id, create, directory, encoded] = await child.request(0);
  expect([id, create, directory]).toEqual(["1", "1", "1"]);
  expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(path);
  child.reply("ok 1\r\n");
  await first;

  const final = acl.check("C:\\private\\device-host-credential.json", false, false, true);
  expect((await child.request(1)).slice(0, 3)).toEqual(["2", "0", "0"]);
  expect(child.stdin.writableEnded).toBe(true);
  let settled = false;
  final.then(() => { settled = true; }, () => { settled = true; });
  child.reply("ok 2\r\n");
  await turn();
  expect(settled).toBe(false);
  child.exit(0);
  await final;
  await acl.close();
  expect(child.kill).not.toHaveReturnedWith(true);
  await expect(acl.check(path, true, false, false)).rejects.toThrow("Credential ACL checks closed.");
  expect(spawn).toHaveBeenCalledOnce();
});

it("refuses when PowerShell refuses a check and does not restart for the operation", async () => {
  const acl = openWindowsCredentialAcl("check");
  const check = acl.check("C:\\private", true, false, false);
  const child = children[0]!;
  await child.request(0);
  child.stderr.emit("data", Buffer.from("Unexpected access rule"));
  child.exit(1);
  await expect(check).rejects.toThrow("Unexpected access rule");
  await expect(acl.check("C:\\private\\file", false, false, true)).rejects.toThrow("Unexpected access rule");
  expect(spawn).toHaveBeenCalledOnce();
  await acl.close();
});

it.each([
  ["another request's response", "ok 2\r\n"],
  ["a response without CRLF", "ok 1\n"],
  ["an extra response", "ok 1\r\nok 1\r\n"],
  ["oversized output", "o".repeat(1024 * 1024)],
])("refuses %s and stops only this operation's child", async (_, response) => {
  const other = openWindowsCredentialAcl("check"), acl = openWindowsCredentialAcl("check");
  const kept = other.check("C:\\other", true, false, false);
  await children[0]!.request(0);
  children[0]!.reply("ok 1\r\n");
  await kept;
  const check = acl.check("C:\\private", true, false, false);
  const child = children[1]!;
  await child.request(0);
  child.reply(response);
  await expect(check).rejects.toThrow("Unexpected credential ACL response.");
  expect(child.closeEmitted).toBe(true);
  expect(child.kill).toHaveReturnedWith(true);
  expect(children[0]!.kill).not.toHaveBeenCalled();
  await other.close();
});

it("refuses output that arrives between requests", async () => {
  const acl = openWindowsCredentialAcl("check");
  const first = acl.check("C:\\private", true, false, false);
  const child = children[0]!;
  await child.request(0);
  child.reply("ok 1\r\n");
  await first;
  child.reply("ok 2\r\n");
  await expect(acl.check("C:\\private\\file", false, false, true)).rejects.toThrow("Unexpected credential ACL response.");
  expect(child.requests).toHaveLength(1);
  expect(child.closeEmitted).toBe(true);
  expect(spawn).toHaveBeenCalledOnce();
});

it.each([
  ["exits before answering", false, (child: FakeChild) => child.exit(0)],
  ["exits before answering the final request", true, (child: FakeChild) => child.exit(0)],
  ["exits nonzero after answering the final request", true, (child: FakeChild) => { child.reply("ok 1\r\n"); child.exit(1); }],
  ["writes after answering the final request", true, (child: FakeChild) => { child.reply("ok 1\r\n"); child.reply("ok 1\r\n"); }],
] as const)("refuses a child that %s", async (_, final, act) => {
  const acl = openWindowsCredentialAcl("check");
  const check = acl.check("C:\\private", true, false, final);
  const child = children[0]!;
  await child.request(0);
  act(child);
  await expect(check).rejects.toThrow();
  expect(child.closeEmitted).toBe(true);
  await acl.close();
});

it("refuses when PowerShell cannot start", async () => {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = fakeChild() as unknown as FakeChild;
    process.nextTick(() => {
      child.emit("error", Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT" }));
      child.exit(-4058);
    });
    return child as unknown as ChildProcess;
  });
  const missing = openWindowsCredentialAcl("check");
  await expect(missing.check("C:\\private", true, false, false)).rejects.toThrow("ENOENT");
  await missing.close();

  vi.mocked(spawn).mockImplementationOnce(() => { throw new Error("spawn EINVAL"); });
  const invalid = openWindowsCredentialAcl("check");
  await expect(invalid.check("C:\\private", true, false, false)).rejects.toThrow("spawn EINVAL");
  await invalid.close();
});

it("refuses when the request pipe fails", async () => {
  const acl = openWindowsCredentialAcl("check");
  const check = acl.check("C:\\private", true, false, false);
  const child = children[0]!;
  await child.request(0);
  child.stdin.destroy(new Error("write EPIPE"));
  await expect(check).rejects.toThrow("write EPIPE");
  expect(child.kill).toHaveReturnedWith(true);
});

const readFailure = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" });

it.each(["stdout", "stderr"] as const)("refuses a %s read failure, stops the child, and keeps that failure", async stream => {
  const acl = openWindowsCredentialAcl("check");
  const check = acl.check("C:\\private", true, false, false);
  const child = children[0]!;
  await child.request(0);
  const failure = readFailure();
  child[stream].fail(failure);
  await expect(check).rejects.toBe(failure);
  expect(child.kill).toHaveReturnedWith(true);
  expect(child.closeEmitted).toBe(true);
  expect(() => child[stream].emit("error", readFailure())).not.toThrow();
  await expect(acl.check("C:\\private\\file", false, false, true)).rejects.toBe(failure);
  expect(child.requests).toHaveLength(1);
  expect(spawn).toHaveBeenCalledOnce();
});

it.each(["stdout", "stderr"] as const)("keeps an earlier refusal when %s fails afterwards", async stream => {
  const acl = openWindowsCredentialAcl("check");
  const check = acl.check("C:\\private", true, false, false);
  const child = children[0]!;
  await child.request(0);
  child.reply("ok 2\r\n");
  expect(() => child[stream].emit("error", readFailure())).not.toThrow();
  await expect(check).rejects.toThrow("Unexpected credential ACL response.");
  await acl.close();
  expect(child.kill).toHaveBeenCalledOnce();
  expect(spawn).toHaveBeenCalledOnce();
});

it("refuses error output beyond the existing 1 MiB bound", async () => {
  const acl = openWindowsCredentialAcl("check");
  const check = acl.check("C:\\private", true, false, false);
  const child = children[0]!;
  await child.request(0);
  child.stderr.emit("data", Buffer.alloc(1024 * 1024 + 1));
  await expect(check).rejects.toThrow("too much error output");
  expect(child.kill).toHaveReturnedWith(true);
});

it("refuses overlapping checks", async () => {
  const acl = openWindowsCredentialAcl("check");
  const first = acl.check("C:\\a", true, false, false), second = acl.check("C:\\b", false, false, false);
  await expect(first).rejects.toThrow("one at a time");
  await expect(second).rejects.toThrow("one at a time");
  expect(children[0]!.kill).toHaveReturnedWith(true);
});

it("sends paths up to the Windows limit exactly and refuses longer or unpaired-surrogate paths before sending them", async () => {
  const longest = "漢".repeat(32_767);
  const acl = openWindowsCredentialAcl("check");
  const check = acl.check(longest, false, false, false);
  const child = children[0]!;
  const [, , , encoded] = await child.request(0);
  expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(longest);
  child.reply("ok 1\r\n");
  await check;
  await expect(acl.check(longest + "x", false, false, true)).rejects.toThrow("Invalid credential path.");
  expect(child.requests).toHaveLength(1);
  expect(child.closeEmitted).toBe(true);

  for (const path of ["C:\\" + "a".repeat(32_765), "C:\\private\\\ud800"]) {
    const refused = openWindowsCredentialAcl("check");
    await expect(refused.check(path, false, false, false)).rejects.toThrow("Invalid credential path.");
    await refused.close();
  }
  expect(spawn).toHaveBeenCalledOnce();
});

it("counts PowerShell startup against the first request's deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.mocked(spawn).mockImplementationOnce(() => {
    vi.advanceTimersByTime(4_000);
    return fakeChild();
  });
  const acl = openWindowsCredentialAcl("check");
  const first = acl.check("C:\\private", true, false, false);
  const refused = expect(first).rejects.toThrow("Credential ACL check timed out.");
  await children[0]!.request(0);
  await vi.advanceTimersByTimeAsync(6_000);
  await refused;
  expect(children[0]!.kill).toHaveReturnedWith(true);
});

it("gives each later request its own deadline and counts the final exit within it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const acl = openWindowsCredentialAcl("check");
  const first = acl.check("C:\\private", true, false, false);
  const child = children[0]!;
  await child.request(0);
  await vi.advanceTimersByTimeAsync(9_999);
  child.reply("ok 1\r\n");
  await first;
  const second = acl.check("C:\\private\\temporary", false, false, false);
  await child.request(1);
  await vi.advanceTimersByTimeAsync(9_999);
  child.reply("ok 2\r\n");
  await second;
  const final = acl.check("C:\\private\\temporary", false, false, true);
  const refused = expect(final).rejects.toThrow("Credential ACL check timed out.");
  await child.request(2);
  child.reply("ok 3\r\n");
  await vi.advanceTimersByTimeAsync(10_000);
  await refused;
  expect(child.kill).toHaveReturnedWith(true);
});

it("refuses by the request deadline and stops waiting one deadline after failure when a killed child never closes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const acl = openWindowsCredentialAcl("check");
  const check = acl.check("C:\\private", true, false, false), refused = settled(check);
  const child = children[0]!;
  child.stuck = true;
  await child.request(0);
  await vi.advanceTimersByTimeAsync(4_000);
  child.reply("ok 2\r\n");
  expect(child.kill).toHaveReturnedWith(true);
  expect(child.unref).toHaveBeenCalledOnce();
  expect([child.stdin.destroyed, child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true, true]);
  await vi.advanceTimersByTimeAsync(5_999);
  expect(refused.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(check).rejects.toThrow("Unexpected credential ACL response.");
  const closing = settled(acl.close());
  await vi.advanceTimersByTimeAsync(3_999);
  expect(closing.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await turn();
  expect(closing.done).toBe(true);
  expect(child.closeEmitted).toBe(false);
});

// A throw escaping the timer path would fail advanceTimersByTimeAsync; one escaping the event path would fail reply.
it.each([
  ["throws", "a timeout"], ["throws", "a malformed response"],
  ["emits an error", "a timeout"], ["emits an error", "a malformed response"],
] as const)("keeps the first failure when kill %s after %s and still refuses and closes within bounds", async (kill, trigger) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const reason = trigger === "a timeout" ? "Credential ACL check timed out." : "Unexpected credential ACL response.";
  const failedAt = trigger === "a timeout" ? 10_000 : 4_000;
  const acl = openWindowsCredentialAcl("check");
  const check = acl.check("C:\\private", true, false, false), refused = settled(check);
  const child = children[0]!;
  child.killFailure = kill === "throws" ? "throw" : "emit";
  await child.request(0);
  await vi.advanceTimersByTimeAsync(4_000);
  if (trigger === "a malformed response") expect(() => child.reply("ok 2\r\n")).not.toThrow();
  await vi.advanceTimersByTimeAsync(5_999);
  expect(refused.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(check).rejects.toThrow(reason);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(child.unref).toHaveBeenCalledOnce();
  expect([child.stdin.destroyed, child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true, true]);
  const closing = settled(acl.close());
  await vi.advanceTimersByTimeAsync(failedAt - 1);
  expect(closing.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await turn();
  expect(closing.done).toBe(true);
  await expect(acl.check("C:\\private\\file", false, false, true)).rejects.toThrow(reason);
  expect(child.requests).toHaveLength(1);
  expect(child.closeEmitted).toBe(false);
  expect(spawn).toHaveBeenCalledOnce();
});

it("keeps an operation's own filesystem error and stops waiting one deadline after killing a child that never closes", async () => {
  const scratch = fileURLToPath(new URL("../.output/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "credential-acl-"));
  try {
    const directory = join(root, "private");
    await mkdir(join(directory, "device-host-credential.json"), { recursive: true });
    let started!: (child: FakeChild) => void;
    const spawned = new Promise<FakeChild>(resolve => { started = resolve; });
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new FakeChild();
      child.stuck = true;
      started(child);
      return child as unknown as ChildProcess;
    });
    vi.stubGlobal("process", { ...process, platform: "win32" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const operation = prepareDeviceHostCredentialFile(directory, "host", parseHostEpoch(1)), refused = settled(operation);
    const child = await spawned;
    expect((await child.request(0)).slice(0, 3)).toEqual(["1", "0", "1"]);
    child.reply("ok 1\r\n");
    await child.killed;
    expect(child.requests).toHaveLength(1);
    expect(child.unref).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(refused.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(operation).rejects.toThrow("Invalid credential path.");
    expect(child.closeEmitted).toBe(false);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["stdout", "stderr"] as const)("removes the temporary credential when %s fails during its check", async stream => {
  const scratch = fileURLToPath(new URL("../.output/", import.meta.url));
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "credential-acl-"));
  try {
    const directory = join(root, "private");
    let started!: (child: FakeChild) => void;
    const spawned = new Promise<FakeChild>(resolve => { started = resolve; });
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new FakeChild();
      started(child);
      return child as unknown as ChildProcess;
    });
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const operation = prepareDeviceHostCredentialFile(directory, "host", parseHostEpoch(1));
    const child = await spawned;
    expect((await child.request(0)).slice(0, 3)).toEqual(["1", "1", "1"]);
    child.reply("ok 1\r\n");
    const [, create, isDirectory, encoded] = await child.request(1);
    expect([create, isDirectory]).toEqual(["0", "0"]);
    expect(Buffer.from(encoded!, "base64").toString("utf8")).toMatch(/\.device-host-credential-[^\\/]+\.tmp$/);
    const failure = readFailure();
    child[stream].fail(failure);
    await expect(operation).rejects.toBe(failure);
    expect(await readdir(directory)).toEqual([]);
    expect(child.closeEmitted).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  }
});

it("stops only its own child when an operation ends early and waits for that child to close", async () => {
  const first = openWindowsCredentialAcl("check"), second = openWindowsCredentialAcl("check");
  const a = first.check("C:\\a", true, false, false), b = second.check("C:\\b", true, false, false);
  const [childA, childB] = children as [FakeChild, FakeChild];
  await childA.request(0); childA.reply("ok 1\r\n"); await a;
  await childB.request(0); childB.reply("ok 1\r\n"); await b;
  const closing = first.close();
  expect(childA.closeEmitted).toBe(false);
  await closing;
  expect(childA.closeEmitted).toBe(true);
  expect(childB.kill).not.toHaveBeenCalled();
  const final = second.check("C:\\b\\file", false, false, true);
  await childB.request(1);
  childB.reply("ok 2\r\n");
  childB.exit(0);
  await final;
  await second.close();
  expect(childB.kill).not.toHaveReturnedWith(true);
  expect(spawn).toHaveBeenCalledTimes(2);
});
