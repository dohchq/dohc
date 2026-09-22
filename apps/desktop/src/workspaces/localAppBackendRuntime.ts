import type { utilityProcess } from "electron";
import { createAppBackendRuntime, type AppRuntimeLauncher } from "@dohc/app-backend-runtime";

/** Electron's runAsNode fuse is disabled; both runtime lifetimes use utility processes. */
export function createDesktopAppRuntimeLauncher(
  processes: Pick<typeof utilityProcess, "fork">,
  closeAfterReply: boolean,
): AppRuntimeLauncher {
  return options => {
    const child = processes.fork(options.entryPath, [], {
      cwd: options.cwd, env: {}, stdio: "ignore", execArgv: ["--max-old-space-size=96"],
      serviceName: "dohc app data",
    });
    let stopping = false;
    child.once("spawn", () => { if (stopping) child.kill(); });
    child.on("message", message => {
      options.onMessage(message);
      if (closeAfterReply) child.postMessage({ kind: "close" });
    });
    child.once("exit", code => options.onExit(code));
    child.once("error", () => options.onError(new Error("The app operation process failed.")));
    return {
      postMessage(message) { child.postMessage(message); },
      kill() { stopping = true; child.kill(); },
    };
  };
}

export function createDesktopAppBackendRuntime(processes: Pick<typeof utilityProcess, "fork">, entryPath?: string) {
  const launch = createDesktopAppRuntimeLauncher(processes, true);
  return createAppBackendRuntime({ launch, ...(entryPath ? { entryPath } : {}) });
}
