import { createServer, type Socket } from "node:net";

/** A loopback SMTP sink for account acceptance tests. It never forwards mail. */
export async function startSmtpCapture() {
  const messages: string[] = [];
  let refuseNext = false;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let pending = "", data = false, message: string[] = [];
    socket.setEncoding("utf8");
    socket.write("220 localhost account-test SMTP\r\n");
    socket.on("data", (chunk: string) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\r\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data) {
          if (line === ".") {
            if (!refuseNext) messages.push(message.join("\r\n"));
            data = false;
            message = [];
            socket.write(refuseNext ? "550 test sink refused delivery\r\n" : "250 accepted by local test sink\r\n");
            refuseNext = false;
          } else message.push(line.startsWith("..") ? line.slice(1) : line);
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write("250-localhost\r\n250 8BITMIME\r\n");
        else if (/^(MAIL FROM:|RCPT TO:|RSET|NOOP)/i.test(line)) socket.write("250 OK\r\n");
        else if (line === "DATA") { data = true; socket.write("354 End with a dot\r\n"); }
        else if (line === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("502 Unsupported command\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMTP sink did not bind.");
  return {
    port: address.port,
    messages,
    refuseNextMessage() { refuseNext = true; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export function mailLinks(message: string): string[] {
  const separator = message.indexOf("\r\n\r\n");
  const headers = message.slice(0, separator);
  const body = message.slice(separator + 4);
  const decoded = /content-transfer-encoding:\s*base64/i.test(headers)
    ? Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")
    : message.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, value: string) => String.fromCharCode(Number.parseInt(value, 16)));
  return [...decoded.matchAll(/https?:\/\/[^\s<>"']+/g)].map(match => match[0]!);
}
