import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  killProcessTreePosix,
  parseProcessTable,
  processDescendants,
  processTreePids,
} from "./posixSpawn";

// The live test spawns a real tree and polls for its death.
vi.setConfig({ testTimeout: 20_000 });

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

  it("reads a row with no leading padding at all", () => {
    // Every OTHER fixture line in this file happens to have leading
    // whitespace — column alignment ps itself adds for narrower pids, not
    // something this parser requires — so only a line with NONE can tell
    // the leading `\s*` (zero or more) apart from a `\s+` (one or more)
    // that would silently drop a row wide enough to need no padding at
    // all (the shape a captured Windows process-table row happened to
    // exercise, before that fixture was consolidated into this shared
    // parser's own coverage).
    const output = "100 1\n200 100\n";

    expect(parseProcessTable(output)).toEqual([
      { pid: 100, ppid: 1 },
      { pid: 200, ppid: 100 },
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

  it("still signals captured descendants when the root already exited", async () => {
    // The force round runs after the root has gone. ESRCH on the root pid is
    // the expected outcome there, not a failure — deleting that tolerance
    // makes this round reject and abandons the descendants it exists for.
    const signalled: number[] = [];

    await expect(
      killProcessTreePosix(100, "SIGKILL", {
        readProcessTable: async () => "  200     1\n",
        alsoSignal: [200],
        sendSignal: (pid) => {
          if (pid === 100) {
            throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
          }
          signalled.push(pid);
        },
      }),
    ).resolves.toEqual([100, 200]);

    expect(signalled).toEqual([200]);
  });

  it("expands a captured pid whose parent chain already exited", async () => {
    // 200 was captured under root 100 at the SIGTERM round. 100 has since
    // exited and 200 was reparented to init, so no walk from 100 reaches it
    // or the worker 300 it forked afterwards.
    const signalled: number[] = [];

    const pids = await killProcessTreePosix(100, "SIGKILL", {
      readProcessTable: async () => "  200     1\n  300   200\n",
      alsoSignal: [200],
      sendSignal: (pid) => signalled.push(pid),
    });

    expect(signalled).toEqual([100, 300, 200]);
    expect(pids).toEqual([100, 300, 200]);
  });

  it("returns the pids a round signalled so the next round can reuse them", async () => {
    const pids = await killProcessTreePosix(100, "SIGTERM", {
      readProcessTable: async () => "  100     1\n  200   100\n",
      sendSignal: () => undefined,
    });

    expect(pids).toEqual([200, 100]);
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
    ).resolves.toEqual([200, 100]);
  });
});

// Platform-agnostic: processDescendants takes its process-table reader as
// an argument, so this same arithmetic (parseProcessTable + processTreePids,
// minus the root) is exercised once here for both the POSIX `ps` shape and
// the Windows Get-CimInstance shape (windowsSpawn.ts's own
// readProcessTableWithPowershell) — a fake reader proves the tree-walk
// either way, with no need for a second, platform-named describe block.
describe("processDescendants", () => {
  it("returns every descendant, excluding the root itself", async () => {
    await expect(
      processDescendants(
        100,
        async () => "  100     1\n  200   100\n  300   200\n",
      ),
    ).resolves.toEqual(expect.arrayContaining([200, 300]));
    await expect(
      processDescendants(
        100,
        async () => "  100     1\n  200   100\n  300   200\n",
      ).then((pids) => pids.includes(100)),
    ).resolves.toBe(false);
  });

  it("returns an empty list when the process table cannot be read", async () => {
    await expect(
      processDescendants(100, () => Promise.reject(new Error("ps: not found"))),
    ).resolves.toEqual([]);
  });

  it("returns an empty list for a root with no children", async () => {
    await expect(
      processDescendants(100, async () => "  100     1\n"),
    ).resolves.toEqual([]);
  });

  it("still finds a descendant once its own parent has already exited and it was reparented away from root", async () => {
    // The scenario stopChild's capture exists for: root's child already
    // exited and reparented grandchild to pid 1 — a plain root-rooted walk
    // would miss it, but a PRIOR capture of the grandchild's own pid (as
    // its own root) still finds it, which is why stopChild re-enumerates
    // from each previously captured pid too, not just the original root.
    await expect(
      processDescendants(300, async () => "  300     1\n  400   300\n"),
    ).resolves.toEqual([400]);
  });
});

// The fakes above prove the sweep's arithmetic. Only a real tree proves the
// `ps` reader, the parser, and process.kill agree about it — the same reason
// windowsSpawn.test.ts keeps a win32-gated spawn-and-verify test.
const describePosix = process.platform === "win32" ? describe.skip : describe;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForDeath(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return !isAlive(pid);
}

describePosix("real process tree teardown (posix)", () => {
  it("kills a grandchild that the root's own signal never reaches", async () => {
    // The root becomes `sleep` through exec, so it forwards nothing. Its
    // child does the same, leaving the grandchild reachable only by walking
    // the process table.
    const child = spawn(
      "sh",
      ["-c", 'sh -c "sleep 30 & echo \\$! ; exec sleep 30" & exec sleep 30'],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const rootPid = child.pid;
    expect(rootPid).toBeGreaterThan(0);

    const grandchildPid = await new Promise<number>((resolvePid, reject) => {
      let out = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        out += String(chunk);
        const line = out.split("\n")[0];
        if (out.includes("\n") && line) resolvePid(Number(line.trim()));
      });
      child.once("error", reject);
      setTimeout(() => reject(new Error("The tree never reported its grandchild pid.")), 10_000);
    });

    try {
      expect(grandchildPid).toBeGreaterThan(0);
      expect(isAlive(grandchildPid)).toBe(true);

      await killProcessTreePosix(rootPid as number, "SIGKILL");

      expect(await waitForDeath(grandchildPid)).toBe(true);
      expect(await waitForDeath(rootPid as number)).toBe(true);
    } finally {
      for (const pid of [grandchildPid, rootPid as number]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already dead, which is the point of the test.
        }
      }
    }
  });
});
