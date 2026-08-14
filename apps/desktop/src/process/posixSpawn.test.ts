import { describe, expect, it } from "vitest";
import {
  killProcessTreePosix,
  parseProcessTable,
  processTreePids,
} from "./posixSpawn";

// The real `ps` path cannot run on a Windows host, so the parser and the sweep
// are proven here against captured output and injected fakes.
describe("parseProcessTable", () => {
  it("reads `ps -A -o pid=,ppid=` output", () => {
    const output = [
      "    1     0",
      "  842     1",
      " 1099   842",
      "",
    ].join("\n");

    expect(parseProcessTable(output)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 842, ppid: 1 },
      { pid: 1099, ppid: 842 },
    ]);
  });

  it("ignores lines it cannot read rather than failing the sweep", () => {
    const output = [
      "  842     1",
      "ps: some transient warning",
      "  not a row",
      " 1099   842   extra",
      " 1200   842",
    ].join("\n");

    expect(parseProcessTable(output)).toEqual([
      { pid: 842, ppid: 1 },
      { pid: 1200, ppid: 842 },
    ]);
  });
});

describe("processTreePids", () => {
  it("collects the transitive closure, children before their parents", () => {
    const table = [
      { pid: 1, ppid: 0 },
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
      { pid: 400, ppid: 100 },
      { pid: 999, ppid: 1 },
    ];

    const pids = processTreePids(table, 100);

    expect(pids).toEqual([300, 400, 200, 100]);
    expect(pids).not.toContain(999);
    expect(pids).not.toContain(1);
  });

  it("returns the root alone when it has no children", () => {
    expect(processTreePids([{ pid: 100, ppid: 1 }], 100)).toEqual([100]);
  });

  it("returns the root even when the table does not list it", () => {
    expect(processTreePids([], 100)).toEqual([100]);
  });

  it("terminates on a parent cycle", () => {
    const table = [
      { pid: 100, ppid: 300 },
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
    ];

    expect(processTreePids(table, 100)).toEqual([300, 200, 100]);
  });
});

describe("killProcessTreePosix", () => {
  it("signals the root and every descendant", async () => {
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    await killProcessTreePosix(100, "SIGTERM", {
      readProcessTable: async () => "  100     1\n  200   100\n  300   200\n",
      sendSignal: (pid, signal) => signalled.push({ pid, signal }),
    });

    expect(signalled).toEqual([
      { pid: 300, signal: "SIGTERM" },
      { pid: 200, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
    ]);
  });

  it("signals the root alone when the process table cannot be read", async () => {
    const signalled: number[] = [];

    await killProcessTreePosix(100, "SIGKILL", {
      readProcessTable: () => Promise.reject(new Error("ps: not found")),
      sendSignal: (pid) => signalled.push(pid),
    });

    expect(signalled).toEqual([100]);
  });

  it("keeps signalling after a descendant has already exited", async () => {
    const signalled: number[] = [];

    await killProcessTreePosix(100, "SIGTERM", {
      readProcessTable: async () => "  100     1\n  200   100\n  300   100\n",
      sendSignal: (pid) => {
        if (pid === 300) {
          throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        }
        signalled.push(pid);
      },
    });

    expect(signalled).toEqual([200, 100]);
  });

  it("reports a root signal failure that is not ESRCH", async () => {
    await expect(
      killProcessTreePosix(100, "SIGTERM", {
        readProcessTable: async () => "  100     1\n",
        sendSignal: () => {
          throw Object.assign(new Error("operation not permitted"), {
            code: "EPERM",
          });
        },
      }),
    ).rejects.toThrow("operation not permitted");
  });

  it("stays silent when only a descendant signal fails", async () => {
    await expect(
      killProcessTreePosix(100, "SIGTERM", {
        readProcessTable: async () => "  100     1\n  200   100\n",
        sendSignal: (pid) => {
          if (pid === 200) {
            throw Object.assign(new Error("operation not permitted"), {
              code: "EPERM",
            });
          }
        },
      }),
    ).resolves.toBeUndefined();
  });
});
