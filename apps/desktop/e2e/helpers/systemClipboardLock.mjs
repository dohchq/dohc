import { createConnection, createServer } from "node:net";
import { setTimeout as poll } from "node:timers/promises";

// Both endpoints are host-wide and disappear when the listening process dies.
export const systemClipboardLockPath = () => process.platform === "win32"
  ? "\\\\.\\pipe\\dohc-e2e-system-clipboard"
  : { host: "127.0.0.1", port: 24763, exclusive: true };

function listen(address, owner) {
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.end(JSON.stringify(owner));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.removeListener("error", reject);
      owner.acquiredAt = new Date().toISOString();
      resolve(() => new Promise((closed, failed) => {
        server.close(error => error ? failed(error) : closed());
        for (const socket of sockets) socket.destroy();
      }));
    });
  });
}

function readHolder(address, timeoutMs) {
  return new Promise(resolve => {
    const socket = createConnection(address);
    let text = "";
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      try { resolve(JSON.parse(text)); }
      catch { resolve(null); }
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      text += chunk;
      if (text.length > 4_096) finish();
    });
    socket.once("error", finish);
    socket.once("end", finish);
  });
}

/** Bound acquisition; always release before returning or propagating a span failure. */
export async function withSystemClipboardLock({ timeoutMs, holder, lockPath = systemClipboardLockPath() }, use) {
  const deadline = performance.now() + timeoutMs;
  const owner = { pid: process.pid, holder };
  for (;;) {
    let release;
    try {
      release = await listen(lockPath, owner);
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      if (performance.now() >= deadline) {
        const observed = await readHolder(lockPath, 200);
        const name = observed
          ? `${observed.holder} (pid ${observed.pid}, acquired ${observed.acquiredAt})`
          : "an owner whose name is not yet readable";
        throw new Error(`Timed out waiting for the system clipboard lock; held by ${name}.`);
      }
      await poll(Math.min(50, Math.max(0, deadline - performance.now())));
      continue;
    }
    try { return await use(); }
    finally { await release(); }
  }
}
