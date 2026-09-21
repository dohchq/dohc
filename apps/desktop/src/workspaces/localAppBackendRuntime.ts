import type { utilityProcess } from "electron";
import { createAppBackendRuntime, type AppRuntimeLauncher } from "@dohc/app-backend-runtime";

/** Electron's runAsNode fuse is disabled; guest work uses a utility process. */
export function createDesktopAppBackendRuntime(processes: Pick<typeof utilityProcess, "fork">) {
  const launch: AppRuntimeLauncher = options => {
    const child = processes.fork(options.entryPath, [], {
      cwd: options.cwd, env: {}, stdio: "ignore", execArgv: ["--max-old-space-size=96"],
      serviceName: "dohc app operation",
    });
    let stopping = false;
    child.once("spawn", () => { if (stopping) child.kill(); });
    child.on("message", message => {
      options.onMessage(message);
      child.postMessage({ kind: "close" });
    });
    child.once("exit", code => options.onExit(code));
    child.once("error", () => options.onError(new Error("The app operation process failed.")));
    return {
      postMessage(message) { child.postMessage(message); },
      kill() { stopping = true; child.kill(); },
    };
  };
  return createAppBackendRuntime({ launch });
}
