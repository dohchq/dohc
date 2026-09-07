import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export function createDeviceControlRequestParser(options: {
  hosts: ReadonlySet<string>; path: string; protocol: string; maxHeaderBytes: number; maxCredentialBytes: number;
}) {
  const hosts = new Set([...options.hosts].map(host => {
    if (!/^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:.]+\])(?::[0-9]+)?$/.test(host) ||
      !new URL(`http://${host}`).hostname) throw new TypeError("Invalid device control Host.");
    return host.toLowerCase();
  }));
  if (hosts.size === 0) throw new TypeError("Device control requires configured Hosts.");
  return (request: Pick<IncomingMessage, "method" | "url" | "rawHeaders">): ReadonlyMap<string, string> | null => {
    if (request.method !== "GET" || request.url !== options.path || request.rawHeaders.length % 2) return null;
    const headers = new Map<string, string>();
    let bytes = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index]!.toLowerCase(), value = request.rawHeaders[index + 1]!;
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
      if (bytes > options.maxHeaderBytes || headers.has(name)) return null;
      headers.set(name, value);
    }
    const credential = headers.get("authorization"), key = headers.get("sec-websocket-key");
    if (!hosts.has(headers.get("host")?.toLowerCase() ?? "") || headers.has("origin") || headers.has("cookie") ||
      headers.has("content-length") || headers.has("transfer-encoding") || headers.has("sec-websocket-extensions") ||
      headers.get("upgrade")?.toLowerCase() !== "websocket" || headers.get("connection")?.toLowerCase() !== "upgrade" ||
      headers.get("sec-websocket-version") !== "13" || headers.get("sec-websocket-protocol") !== options.protocol ||
      !key || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, "base64").toString("base64") !== key ||
      !credential || Buffer.byteLength(credential) > options.maxCredentialBytes || !/^Bearer [A-Za-z0-9_-]+$/.test(credential)) return null;
    return headers;
  };
}

export function refuseDeviceControl(socket: Duplex, closeTimeoutMs: number): void {
  if (socket.destroyed) return;
  socket.once("error", () => socket.destroy());
  const timer = setTimeout(() => socket.destroy(), closeTimeoutMs);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
  if (!socket.writable || socket.writableEnded) { socket.destroy(); return; }
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => socket.destroy());
}
