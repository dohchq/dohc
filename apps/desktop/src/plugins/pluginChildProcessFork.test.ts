import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  forkElectronUtilityProcess,
  type PluginChildProcessForkOptions,
} from "./pluginChildProcessBroker";

// Electron's own contract: `utilityProcess.fork()` returns before the child
// exists, and `pid` stays undefined until the `spawn` event
// (electron@43.3.0 electron.d.ts, UtilityProcess.pid). Everything that
// recognises a child by its number — the Windows tree kill here, a wrapper
// plugin's ownership record — reads that pid from the handle this returns.

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = undefined;
  stdout = null;
  stderr = null;
  postMessage(): void {}
  kill(): boolean {
    return true;
  }
}

const forked: FakeUtilityProcess[] = [];

vi.mock("electron", () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeUtilityProcess();
      forked.push(child);
      return child;
    },
  },
}));

const OPTIONS: PluginChildProcessForkOptions = {
  cwd: "/plugins/hello",
  env: {},
  serviceName: "dohc.plugin.hello.child",
  stdio: ["ignore", "pipe", "pipe"],
};

function fork(): {
  handle: ReturnType<typeof forkElectronUtilityProcess>;
  onExit: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
} {
  const onExit = vi.fn();
  const onError = vi.fn();
  return {
    handle: forkElectronUtilityProcess("main.mjs", [], OPTIONS, {
      onExit,
      onError,
    }),
    onExit,
    onError,
  };
}

/** One macrotask: enough for every microtask the fork could still be waiting
 * on, so an unsettled promise here is genuinely waiting on the child. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("forkElectronUtilityProcess", () => {
  it("waits for the spawn, so the handle carries the child's pid", async () => {
    const { handle } = fork();
    let settled = false;
    void handle.then(() => {
      settled = true;
    });
    await tick();
    const child = forked.at(-1)!;
    expect(child.pid).toBeUndefined();

    // MUTATION (return the handle straight from fork): settled is already
    // true here, every handle reports no pid, and the ownership record a
    // wrapper plugin writes at spawn is silently never written.
    expect(settled).toBe(false);

    child.pid = 4242;
    child.emit("spawn");
    expect((await handle).pid).toBe(4242);
  });

  it("returns a child that ended before it spawned, so the caller can retry", async () => {
    const { handle, onExit } = fork();
    await tick();
    const child = forked.at(-1)!;
    child.emit("exit", 1);

    // No pid was ever assigned: the caller reads null and treats the attempt
    // as the failure it is, instead of waiting for a spawn that cannot come.
    expect((await handle).pid).toBeUndefined();
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it("returns a child whose launch errored", async () => {
    const { handle, onError } = fork();
    await tick();
    const child = forked.at(-1)!;
    child.emit("error", "FatalError", "utility_process", "launch failed");

    expect((await handle).pid).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      "FatalError",
      "utility_process",
      "launch failed",
    );
  });
});
