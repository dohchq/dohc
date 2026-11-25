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
    let pending = "",
      data = false,
      message: string[] = [];
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
            socket.write(
              refuseNext
                ? "550 test sink refused delivery\r\n"
                : "250 accepted by local test sink\r\n",
            );
            refuseNext = false;
          } else message.push(line.startsWith("..") ? line.slice(1) : line);
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write("250-localhost\r\n250 8BITMIME\r\n");
        else if (/^(MAIL FROM:|RCPT TO:|RSET|NOOP)/i.test(line)) socket.write("250 OK\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 End with a dot\r\n");
        } else if (line === "QUIT") socket.end("221 Bye\r\n");
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
    refuseNextMessage() {
      refuseNext = true;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

// The links in a message's text, each checked against the HTML part's links
// when the message has one, so a button cannot point somewhere else.
export function mailLinks(message: string): string[] {
  const { headers, body } = splitPart(message);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(headers)?.[1];
  const parts = boundary
    ? body
        .split(`--${boundary}`)
        .slice(1, -1)
        .map((part) => splitPart(part.replace(/^\r\n/, "")))
    : [{ headers, body }];
  const text = parts.find((part) => !/content-type:\s*text\/html/i.test(part.headers));
  if (!text) throw new Error("Captured message has no text part.");
  const links = [...decodePart(text).matchAll(/https?:\/\/[^\s<>"']+/g)].map((match) => match[0]!);
  const html = parts.find((part) => /content-type:\s*text\/html/i.test(part.headers));
  if (html) {
    const page = decodePart(html).replaceAll("&amp;", "&");
    for (const link of links)
      if (!page.includes(`href="${link}"`)) throw new Error(`The HTML part does not link ${link}.`);
  }
  return links;
}

function splitPart(part: string): { headers: string; body: string } {
  const separator = part.indexOf("\r\n\r\n");
  if (separator === -1) throw new Error("Captured message has no header/body separator.");
  return { headers: part.slice(0, separator), body: part.slice(separator + 4) };
}

function decodePart({ headers, body }: { headers: string; body: string }): string {
  return /content-transfer-encoding:\s*base64/i.test(headers)
    ? Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")
    : body
        .replace(/=\r\n/g, "")
        .replace(/=([0-9A-F]{2})/gi, (_, value: string) =>
          String.fromCharCode(Number.parseInt(value, 16)),
        );
}
