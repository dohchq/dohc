import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  killProcessTreePosix,
  parseProcessTable,
  processTreePids,
  stopProcessTreePosix,
} from "./posixSpawn";

// The live test spawns a real tree and polls for its death.
vi.setConfig({ testTimeout: 20_000 });

const TEST_STARTED_AT = "Fri Aug 21 10:00:00 2026";

function psRow(pid: number, ppid: number, startedAt = TEST_STARTED_AT): string {
  return `${pid} ${ppid} ${startedAt}`;
}

function tableEntry(pid: number, ppid: number) {
  return { pid, ppid, startedAt: TEST_STARTED_AT };
}

// The real `ps` path cannot run on a Windows host, so the parser and the sweep
// are proven here against captured output and injected fakes.
describe("parseProcessTable", () => {
  it("reads `ps -A -o pid=,ppid=,lstart=` output", () => {
    const output = [
      `    ${psRow(1, 0)}`,
      `  ${psRow(842, 1)}`,
      ` ${psRow(1099, 842)}`,
      "",
    ].join("\n");

    expect(parseProcessTable(output)).toEqual([
      tableEntry(1, 0),
      tableEntry(842, 1),
      tableEntry(1099, 842),
    ]);
  });

  it("ignores lines it cannot read rather than failing the sweep", () => {
    const output = [
      psRow(842, 1),
      "ps: some transient warning",
      "  not a row",
      " 1099   842",
      psRow(1200, 842),
    ].join("\n");

    expect(parseProcessTable(output)).toEqual([
      tableEntry(842, 1),
      tableEntry(1200, 842),
    ]);
  });
});

describe("processTreePids", () => {
  it("collects the transitive closure, children before their parents", () => {
    const table = [
      tableEntry(1, 0),
      tableEntry(100, 1),
      tableEntry(200, 100),
      tableEntry(300, 200),
      tableEntry(400, 100),
      tableEntry(999, 1),
    ];

    const pids = processTreePids(table, 100);

    expect(pids).toEqual([300, 400, 200, 100]);
    expect(pids).not.toContain(999);
    expect(pids).not.toContain(1);
  });

  it("returns the root alone when it has no children", () => {
    expect(processTreePids([tableEntry(100, 1)], 100)).toEqual([100]);
  });

  it("returns the root even when the table does not list it", () => {
    expect(processTreePids([], 100)).toEqual([100]);
  });

  it("terminates on a parent cycle", () => {
    const table = [
      tableEntry(100, 300),
      tableEntry(200, 100),
      tableEntry(300, 200),
    ];

    expect(processTreePids(table, 100)).toEqual([300, 200, 100]);
  });
});

describe("killProcessTreePosix", () => {
  it("sizes the real ps read above execFile's default buffer", async () => {
    const execFileMock = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { maxBuffer?: number; timeout?: number },
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      callback(null, psRow(100, 1));
    });
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      execFile: execFileMock,
    }));

    try {
      const { killProcessTreePosix: killWithMockedPs } = await import(
        "./posixSpawn"
      );

      await killWithMockedPs(100, "SIGTERM", {
        sendSignal: () => undefined,
      });

      expect(execFileMock).toHaveBeenCalledWith(
        "ps",
        ["-A", "-o", "pid=,ppid=,lstart="],
        { maxBuffer: 8 * 1024 * 1024, timeout: 2_000 },
        expect.any(Function),
      );
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("signals the root and every descendant", async () => {
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    await killProcessTreePosix(100, "SIGTERM", {
      readProcessTable: async () => [
        psRow(100, 1),
        psRow(200, 100),
        psRow(300, 200),
      ].join("\n"),
      sendSignal: (pid, signal) => signalled.push({ pid, signal }),
    });

    expect(signalled).toEqual([
      { pid: 300, signal: "SIGTERM" },
      { pid: 200, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
    ]);
  });

  it("builds one child index for a multi-root signal round", async () => {
    const originalIterator = Array.prototype[Symbol.iterator];
    let processTableIterations = 0;
    Object.defineProperty(Array.prototype, Symbol.iterator, {
      configurable: true,
      writable: true,
      value: function (this: unknown[]) {
        const first = this[0];
        if (
          typeof first === "object" &&
          first !== null &&
          "pid" in first &&
          "ppid" in first &&
          "startedAt" in first
        ) {
          processTableIterations += 1;
        }
        return originalIterator.call(this);
      },
    });
    const signalled: number[] = [];

    try {
      await killProcessTreePosix(100, "SIGTERM", {
        readProcessTable: async () => [
          psRow(100, 1),
          psRow(110, 100),
          psRow(200, 1),
          psRow(210, 200),
          psRow(300, 1),
          psRow(310, 300),
        ].join("\n"),
        alsoSignal: [200, 300],
        sendSignal: (pid) => signalled.push(pid),
      });
    } finally {
      Object.defineProperty(Array.prototype, Symbol.iterator, {
        configurable: true,
        writable: true,
        value: originalIterator,
      });
    }

    expect(processTableIterations).toBe(1);
    expect(signalled).toEqual([110, 100, 210, 200, 310, 300]);
  });

  it("signals the root alone when the process table cannot be read", async () => {
    const signalled: number[] = [];

    await killProcessTreePosix(100, "SIGKILL", {
      readProcessTable: () => Promise.reject(new Error("ps: not found")),
      sendSignal: (pid) => signalled.push(pid),
    });

    expect(signalled).toEqual([100]);
  });

  it("times out a hanging process-table read before signalling the root", async () => {
    vi.useFakeTimers();
    try {
      const signalled: number[] = [];
      let resolved = false;

      const pending = killProcessTreePosix(100, "SIGKILL", {
        readProcessTable: () => new Promise(() => {}),
        sendSignal: (pid) => signalled.push(pid),
      }).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(resolved).toBe(false);
      expect(signalled).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);

      expect(resolved).toBe(true);
      await pending;
      expect(signalled).toEqual([100]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps signalling after a descendant has already exited", async () => {
    const signalled: number[] = [];

    await killProcessTreePosix(100, "SIGTERM", {
      readProcessTable: async () => [
        psRow(100, 1),
        psRow(200, 100),
        psRow(300, 100),
      ].join("\n"),
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
        readProcessTable: async () => psRow(100, 1),
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
        readProcessTable: async () => psRow(200, 1),
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
      readProcessTable: async () => [psRow(200, 1), psRow(300, 200)].join("\n"),
      alsoSignal: [200],
      sendSignal: (pid) => signalled.push(pid),
    });

    expect(signalled).toEqual([100, 300, 200]);
    expect(pids).toEqual([100, 300, 200]);
  });

  it("returns the pids a round signalled so the next round can reuse them", async () => {
    const pids = await killProcessTreePosix(100, "SIGTERM", {
      readProcessTable: async () => [psRow(100, 1), psRow(200, 100)].join("\n"),
      sendSignal: () => undefined,
    });

    expect(pids).toEqual([200, 100]);
  });

  it("stays silent when only a descendant signal fails", async () => {
    await expect(
      killProcessTreePosix(100, "SIGTERM", {
        readProcessTable: async () => [psRow(100, 1), psRow(200, 100)].join("\n"),
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

describe("stopProcessTreePosix", () => {
  it("falls back after grace when the first table omits a live root", async () => {
    vi.useFakeTimers();
    try {
      const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const onTreeKillFailure = vi.fn();
      let readCount = 0;

      const pending = stopProcessTreePosix(
        100,
        Promise.resolve(),
        100,
        onTreeKillFailure,
        {
          readProcessTable: async () => {
            readCount += 1;
            return readCount === 1 ? psRow(999, 1) : psRow(100, 1);
          },
          sendSignal: (pid, signal) => signalled.push({ pid, signal }),
          isAlive: () => true,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(99);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(signalled).toEqual([
        { pid: 100, signal: "SIGTERM" },
      ]);
      expect(onTreeKillFailure).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fall back when the first table omits an exited root", async () => {
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const onTreeKillFailure = vi.fn();
    let readCount = 0;

    await stopProcessTreePosix(
      100,
      Promise.resolve(),
      100,
      onTreeKillFailure,
      {
        readProcessTable: async () => {
          readCount += 1;
          return readCount === 1 ? psRow(999, 1) : psRow(100, 1);
        },
        sendSignal: (pid, signal) => signalled.push({ pid, signal }),
        isAlive: () => false,
      },
    );

    expect(signalled).toEqual([
      { pid: 100, signal: "SIGTERM" },
    ]);
    expect(onTreeKillFailure).not.toHaveBeenCalled();
  });

  it("does not fall back when both reads succeed and the force round runs promptly", async () => {
    vi.useFakeTimers();
    try {
      const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const onTreeKillFailure = vi.fn();
      const pending = stopProcessTreePosix(
        100,
        Promise.resolve(),
        100,
        onTreeKillFailure,
        {
          readProcessTable: async () => psRow(100, 1),
          sendSignal: (pid, signal) => {
            signalled.push({ pid, signal });
          },
          isAlive: () => false,
        },
      );

      await vi.advanceTimersByTimeAsync(100);
      await pending;

      expect(signalled).toEqual([
        { pid: 100, signal: "SIGTERM" },
        { pid: 100, signal: "SIGKILL" },
      ]);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back after grace when only the force-round table read fails", async () => {
    vi.useFakeTimers();
    try {
      const onTreeKillFailure = vi.fn();
      let readCount = 0;

      const pending = stopProcessTreePosix(
        100,
        Promise.resolve(),
        100,
        onTreeKillFailure,
        {
          readProcessTable: async () => {
            readCount += 1;
            if (readCount === 2) throw new Error("ps: transient failure");
            return psRow(100, 1);
          },
          sendSignal: () => undefined,
          isAlive: () => true,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(99);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(onTreeKillFailure).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back after grace when only the first table read fails", async () => {
    vi.useFakeTimers();
    try {
      const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const onTreeKillFailure = vi.fn();
      let readCount = 0;

      const pending = stopProcessTreePosix(
        100,
        Promise.resolve(),
        100,
        onTreeKillFailure,
        {
          readProcessTable: async () => {
            readCount += 1;
            if (readCount === 1) throw new Error("ps: not found");
            return psRow(100, 1);
          },
          sendSignal: (pid, signal) => signalled.push({ pid, signal }),
          isAlive: () => true,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(99);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(signalled).toEqual([
        { pid: 100, signal: "SIGTERM" },
      ]);
      expect(onTreeKillFailure).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a hanging first table read and falls back after grace", async () => {
    vi.useFakeTimers();
    try {
      const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const onTreeKillFailure = vi.fn();
      let readCount = 0;

      const pending = stopProcessTreePosix(
        100,
        Promise.resolve(),
        100,
        onTreeKillFailure,
        {
          readProcessTable: () => {
            readCount += 1;
            return readCount === 1
              ? new Promise(() => {})
              : Promise.resolve(psRow(100, 1));
          },
          sendSignal: (pid, signal) => signalled.push({ pid, signal }),
          isAlive: () => true,
        },
      );

      await vi.advanceTimersByTimeAsync(99);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
      expect(signalled).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(onTreeKillFailure).toHaveBeenCalledOnce();
      expect(signalled).toEqual([
        { pid: 100, signal: "SIGTERM" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one shutdown budget across reads, grace, force, and fallback", async () => {
    vi.useFakeTimers();
    try {
      const settleMs = 100;
      const toleranceMs = 1;
      const startedAt = Date.now();
      let readCount = 0;
      let resolvedAt: number | undefined;
      let fallbackAt: number | undefined;
      const onTreeKillFailure = vi.fn(() => {
        fallbackAt = Date.now();
      });

      const pending = stopProcessTreePosix(
        100,
        Promise.resolve(),
        settleMs,
        onTreeKillFailure,
        {
          readProcessTable: () => {
            readCount += 1;
            if (readCount === 1) {
              return new Promise<string>((resolve) => {
                setTimeout(() => resolve(psRow(100, 1)), 95);
              });
            }
            return new Promise(() => {});
          },
          sendSignal: () => undefined,
          isAlive: () => true,
        },
      ).then(() => {
        resolvedAt = Date.now();
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);

      // The force round has no budget left, so its read wrapper fails before
      // it calls the underlying reader.
      expect(readCount).toBe(1);
      expect(fallbackAt).toBeDefined();
      expect((fallbackAt as number) - startedAt)
        .toBeLessThanOrEqual(settleMs + toleranceMs);
      expect((resolvedAt as number) - startedAt)
        .toBeLessThanOrEqual(settleMs + toleranceMs);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back once after grace when both table reads fail", async () => {
    vi.useFakeTimers();
    try {
      const onTreeKillFailure = vi.fn();

      const pending = stopProcessTreePosix(
        100,
        Promise.resolve(),
        100,
        onTreeKillFailure,
        {
          readProcessTable: () => Promise.reject(new Error("ps: not found")),
          sendSignal: () => undefined,
          isAlive: () => true,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(99);
      expect(onTreeKillFailure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(onTreeKillFailure).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fall back when SIGTERM stops the root", async () => {
    const onTreeKillFailure = vi.fn();
    let alive = true;
    let readCount = 0;

    await stopProcessTreePosix(
      100,
      Promise.resolve(),
      100,
      onTreeKillFailure,
      {
        readProcessTable: async () => {
          readCount += 1;
          return readCount === 1 ? psRow(100, 1) : "";
        },
        sendSignal: (_pid, signal) => {
          if (signal === "SIGTERM") alive = false;
        },
        isAlive: () => alive,
      },
    );

    expect(onTreeKillFailure).not.toHaveBeenCalled();
  });

  it("force-signals a root captured with the same identity", async () => {
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const startedAt = "Fri Aug 21 10:00:05 2026";
    let readCount = 0;

    await stopProcessTreePosix(
      100,
      Promise.resolve(),
      100,
      undefined,
      {
        readProcessTable: async () => {
          readCount += 1;
          return readCount === 1
            ? psRow(100, 1, startedAt)
            : [psRow(100, 1, startedAt), psRow(999, 1)].join("\n");
        },
        sendSignal: (pid, signal) => signalled.push({ pid, signal }),
        isAlive: () => false,
      },
    );

    expect(signalled).toEqual([
      { pid: 100, signal: "SIGTERM" },
      { pid: 100, signal: "SIGKILL" },
    ]);
  });

  it("skips a root pid reused by a different process", async () => {
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const onTreeKillFailure = vi.fn();
    let readCount = 0;

    await stopProcessTreePosix(
      100,
      Promise.resolve(),
      100,
      onTreeKillFailure,
      {
        readProcessTable: async () => {
          readCount += 1;
          return readCount === 1
            ? psRow(100, 1, "Fri Aug 21 09:59:00 2026")
            : psRow(100, 1, "Fri Aug 21 10:00:05 2026");
        },
        sendSignal: (pid, signal) => signalled.push({ pid, signal }),
        isAlive: () => false,
      },
    );

    expect(signalled).toEqual([
      { pid: 100, signal: "SIGTERM" },
    ]);
    expect(onTreeKillFailure).not.toHaveBeenCalled();
  });

  it("still signals the root pid with the same process identity", async () => {
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const startedAt = "Fri Aug 21 10:00:05 2026";

    await stopProcessTreePosix(
      100,
      Promise.resolve(),
      100,
      undefined,
      {
        readProcessTable: async () => psRow(100, 1, startedAt),
        sendSignal: (pid, signal) => signalled.push({ pid, signal }),
        isAlive: () => false,
      },
    );

    expect(signalled).toEqual([
      { pid: 100, signal: "SIGTERM" },
      { pid: 100, signal: "SIGKILL" },
    ]);
  });

  it("skips a captured pid reused by a different process", async () => {
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let readCount = 0;

    await stopProcessTreePosix(
      100,
      Promise.resolve(),
      100,
      undefined,
      {
        readProcessTable: async () => {
          readCount += 1;
          return readCount === 1
            ? [
                psRow(100, 1),
                psRow(200, 100, "Fri Aug 21 09:59:00 2026"),
              ].join("\n")
            : [
                psRow(100, 1),
                psRow(200, 1, "Fri Aug 21 10:00:05 2026"),
              ].join("\n");
        },
        sendSignal: (pid, signal) => signalled.push({ pid, signal }),
        isAlive: () => false,
      },
    );

    expect(signalled).toEqual([
      { pid: 200, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
      { pid: 100, signal: "SIGKILL" },
    ]);
  });

  it("still signals a captured pid with the same process identity", async () => {
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const startedAt = "Fri Aug 21 10:00:05 2026";
    let readCount = 0;

    await stopProcessTreePosix(
      100,
      Promise.resolve(),
      100,
      undefined,
      {
        readProcessTable: async () => {
          readCount += 1;
          return readCount === 1
            ? [psRow(100, 1), psRow(200, 100, startedAt)].join("\n")
            : [psRow(100, 1), psRow(200, 1, startedAt)].join("\n");
        },
        sendSignal: (pid, signal) => signalled.push({ pid, signal }),
        isAlive: () => false,
      },
    );

    expect(signalled).toEqual([
      { pid: 200, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
      { pid: 100, signal: "SIGKILL" },
      { pid: 200, signal: "SIGKILL" },
    ]);
  });

  it("waits for a captured descendant after the root settles", async () => {
    vi.useFakeTimers();
    try {
      const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      let descendantAliveChecks = 0;
      const options = {
        readProcessTable: async () =>
          [psRow(100, 1), psRow(200, 100)].join("\n"),
        sendSignal: (pid: number, signal: NodeJS.Signals) =>
          signalled.push({ pid, signal }),
        isAlive: (pid: number) => {
          if (pid === 100) return false;
          descendantAliveChecks += 1;
          return descendantAliveChecks < 3;
        },
      };

      const pending = stopProcessTreePosix(
        100,
        Promise.resolve(),
        200,
        undefined,
        options,
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(signalled).toEqual([
        { pid: 200, signal: "SIGTERM" },
        { pid: 100, signal: "SIGTERM" },
      ]);
      await vi.advanceTimersByTimeAsync(50);
      expect(descendantAliveChecks).toBe(2);
      expect(signalled).toEqual([
        { pid: 200, signal: "SIGTERM" },
        { pid: 100, signal: "SIGTERM" },
      ]);
      await vi.advanceTimersByTimeAsync(50);
      await pending;

      expect(descendantAliveChecks).toBe(5);
      expect(signalled).toEqual([
        { pid: 200, signal: "SIGTERM" },
        { pid: 100, signal: "SIGTERM" },
        { pid: 200, signal: "SIGKILL" },
        { pid: 100, signal: "SIGKILL" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the force round promptly when every captured target has exited", async () => {
    vi.useFakeTimers();
    try {
      const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
      const pending = stopProcessTreePosix(
        100,
        Promise.resolve(),
        200,
        undefined,
        {
          readProcessTable: async () =>
            [psRow(100, 1), psRow(200, 100)].join("\n"),
          sendSignal: (pid, signal) => signalled.push({ pid, signal }),
          isAlive: () => false,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      await pending;

      expect(signalled).toEqual([
        { pid: 200, signal: "SIGTERM" },
        { pid: 100, signal: "SIGTERM" },
        { pid: 200, signal: "SIGKILL" },
        { pid: 100, signal: "SIGKILL" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for force-round targets to exit before resolving", async () => {
    vi.useFakeTimers();
    try {
      let aliveChecks = 0;
      let resolved = false;
      let forceRoundStarted = false;
      const options = {
        readProcessTable: async () => psRow(100, 1),
        sendSignal: (_pid: number, signal: NodeJS.Signals) => {
          if (signal === "SIGKILL") forceRoundStarted = true;
        },
        isAlive: () => {
          if (!forceRoundStarted) return false;
          aliveChecks += 1;
          return aliveChecks < 3;
        },
      };

      const pending = stopProcessTreePosix(
        100,
        Promise.resolve(),
        200,
        undefined,
        options,
      ).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(50);
      await pending;

      expect(aliveChecks).toBe(4);
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
