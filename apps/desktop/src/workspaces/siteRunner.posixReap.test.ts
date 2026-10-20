import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSiteDevServer } from "./siteRunner";
import { createTestScratch } from "./testTemp";

// The real killProcessTreePosix, with its process-table read held until the
// test lets it go: the await before it signals is the one that matters.
let readTable: (() => Promise<string>) | null = null;
let rootOfFirstRound: number | null = null;
vi.mock("../process/posixSpawn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process/posixSpawn")>();
  return {
    ...actual,
    killProcessTreePosix: vi.fn((pid: number, signal: NodeJS.Signals, options: Parameters<typeof actual.killProcessTreePosix>[2] = {}) => {
      rootOfFirstRound ??= pid;
      return actual.killProcessTreePosix(pid, signal, { ...options, ...(readTable ? { readProcessTable: readTable } : {}) });
    }),
  };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  readTable = null;
  rootOfFirstRound = null;
  vi.restoreAllMocks();
});

const SERVER = "require('node:http').createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', function () { console.log('http://127.0.0.1:' + this.address().port + '/'); });";

describe("a POSIX stop whose wrapper exits during the process-table read", () => {
  it("sends that wrapper no signal once Node has seen it exit", async () => {
    const workspaceRoot = await realpath(await createTestScratch("site-runner-posix-reap-"));
    await mkdir(join(workspaceRoot, "portal"));
    await writeFile(join(workspaceRoot, "portal", "server.js"), SERVER);
    const handle = await startSiteDevServer({
      workspaceRoot, siteRoot: "portal", command: "node", args: ["server.js"],
      descendantsReader: async () => [],
    });
    const exited = new Promise<void>((resolve) => handle.onExit(resolve));

    // Every signal dohc sends once the wrapper's exit is observed.
    const kill = process.kill.bind(process);
    let watching = false;
    const signalsAfterExit: Array<[number, string | number | undefined]> = [];
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (watching && signal !== 0) signalsAfterExit.push([pid, signal]);
      return kill(pid, signal);
    });
    // The read ends the wrapper and answers only after Node reports its
    // exit, with the wrapper still in the table, as a ps that ran just
    // before the exit would list it.
    readTable = async () => {
      const wrapper = rootOfFirstRound!;
      kill(wrapper, "SIGKILL");
      await exited;
      watching = true;
      return `${wrapper} ${process.pid} Tue Oct 20 10:00:00 2026`;
    };

    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    await handle.stop();
    expect(rootOfFirstRound).not.toBeNull();
    expect(signalsAfterExit.filter(([pid]) => pid === rootOfFirstRound)).toEqual([]);
  });
});
