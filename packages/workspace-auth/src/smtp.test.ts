import nodemailer from "nodemailer";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSmtpSender,
  isLoopback,
  SmtpConfigError,
  SmtpDeliveryError,
  smtpSettingsFromEnv,
} from "./smtp";

// The wire behaviour is checked against a fake submission server: the test
// asserts the transcript dohc sends, because that transcript is what a real
// MTA judges. No sleeps — every step waits for the peer's reply.

interface FakeServer {
  port: number;
  transcript: string[];
  message: () => string;
  close: () => Promise<void>;
}

interface FakeOptions {
  /** Capabilities announced after EHLO. */
  capabilities?: string[];
  /** Replaces the reply for a command the test wants to fail. */
  refuse?: { command: string; reply: string };
}

function startFakeSmtp(options: FakeOptions = {}): Promise<FakeServer> {
  const capabilities = options.capabilities ?? ["AUTH PLAIN LOGIN"];
  const transcript: string[] = [];
  let message = "";

  const handle = (socket: Socket): void => {
    let buffer = "";
    let inData = false;
    let loginStep = 0;
    socket.write("220 fake.dohc.test ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            transcript.push("DATA-END");
            socket.write("250 2.0.0 queued\r\n");
          } else {
            message += `${line}\r\n`;
          }
          continue;
        }
        transcript.push(line);
        if (loginStep > 0) {
          // AUTH LOGIN continuations arrive as bare base64: user, then password.
          socket.write(loginStep === 1 ? "334 UGFzc3dvcmQ6\r\n" : "235 2.7.0 accepted\r\n");
          loginStep = loginStep === 1 ? 2 : 0;
          continue;
        }
        const command = line.split(" ")[0]!.toUpperCase();
        if (options.refuse && line.toUpperCase().startsWith(options.refuse.command.toUpperCase())) {
          socket.write(`${options.refuse.reply}\r\n`);
          continue;
        }
        switch (command) {
          case "EHLO": {
            const lines = ["250-fake.dohc.test", ...capabilities.map((entry) => `250-${entry}`)];
            socket.write(`${lines.join("\r\n")}\r\n250 SIZE 10240000\r\n`);
            break;
          }
          case "AUTH":
            if (line.toUpperCase() === "AUTH LOGIN") {
              loginStep = 1;
              socket.write("334 VXNlcm5hbWU6\r\n");
            } else socket.write("235 2.7.0 accepted\r\n");
            break;
          case "DATA":
            inData = true;
            socket.write("354 end with <CRLF>.<CRLF>\r\n");
            break;
          case "QUIT":
            socket.write("221 2.0.0 bye\r\n");
            socket.end();
            break;
          default:
            socket.write("250 2.0.0 ok\r\n");
        }
      }
    });
    socket.on("error", () => undefined);
  };

  return new Promise((resolve) => {
    const server: Server = createServer(handle);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        transcript,
        message: () => message,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

const servers: FakeServer[] = [];

async function fakeSmtp(options?: FakeOptions): Promise<FakeServer> {
  const server = await startFakeSmtp(options);
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("smtpSettingsFromEnv", () => {
  it("returns null when an operator configured no SMTP", () => {
    expect(smtpSettingsFromEnv({})).toBeNull();
  });

  it("reads a complete configuration", () => {
    expect(
      smtpSettingsFromEnv({
        DOHC_SMTP_HOST: "smtp.example.com",
        DOHC_SMTP_PORT: "465",
        DOHC_SMTP_SECURE: "true",
        DOHC_SMTP_USER: "postmaster",
        DOHC_SMTP_PASSWORD: " secret ",
        DOHC_SMTP_FROM: "dohc <accounts@example.com>",
      }),
    ).toEqual({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "postmaster",
      password: " secret ",
      from: "dohc <accounts@example.com>",
    });
  });

  it("rejects a partial or malformed configuration instead of disabling email", () => {
    expect(() => smtpSettingsFromEnv({ DOHC_SMTP_HOST: "smtp.example.com" })).toThrow(SmtpConfigError);
    const complete = {
      DOHC_SMTP_HOST: "smtp.example.com",
      DOHC_SMTP_PORT: "587",
      DOHC_SMTP_SECURE: "false",
      DOHC_SMTP_FROM: "accounts@example.com",
    };
    expect(() => smtpSettingsFromEnv({ ...complete, DOHC_SMTP_PORT: "0" })).toThrow(/1 to 65535/);
    expect(() => smtpSettingsFromEnv({ ...complete, DOHC_SMTP_SECURE: "yes" })).toThrow(/true or false/);
    expect(() => smtpSettingsFromEnv({ ...complete, DOHC_SMTP_FROM: "accounts" })).toThrow(/email address/);
    expect(() => smtpSettingsFromEnv({ ...complete, DOHC_SMTP_USER: "postmaster" })).toThrow(/both/);
  });
});

describe("createSmtpSender", () => {
  it("requires remote TLS even when the SMTP server needs no password", () => {
    const create = vi.spyOn(nodemailer, "createTransport");
    try {
      createSmtpSender({ host: "smtp.example.test", port: 587, secure: false, from: "accounts@dohc.test" });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ requireTLS: true, secure: false }));
      createSmtpSender({ host: "127.0.0.1", port: 2525, secure: false, from: "accounts@dohc.test" });
      expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ requireTLS: false }));
    } finally { create.mockRestore(); }
  });

  it("submits one message with the envelope, headers and body the server sees", async () => {
    const server = await fakeSmtp();
    const send = createSmtpSender({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      from: "dohc <accounts@dohc.test>",
    });

    await send({ to: "person@example.com", subject: "Verify your dohc email", text: "Hello\nthere" });

    expect(server.transcript).toContain("MAIL FROM:<accounts@dohc.test>");
    expect(server.transcript).toContain("RCPT TO:<person@example.com>");
    expect(server.transcript).toContain("DATA-END");
    expect(server.message()).toContain("Subject: Verify your dohc email");
    expect(server.message()).toContain("Hello");
  });

  it("authenticates with PLAIN when the server offers it", async () => {
    const server = await fakeSmtp();
    const send = createSmtpSender({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      user: "postmaster",
      password: "secret",
      from: "accounts@dohc.test",
    });

    await send({ to: "person@example.com", subject: "Hi", text: "Body" });

    const auth = server.transcript.find((line) => line.startsWith("AUTH"));
    expect(auth).toBe(`AUTH PLAIN ${Buffer.from("\0postmaster\0secret").toString("base64")}`);
  });

  it("falls back to LOGIN when the server offers no PLAIN", async () => {
    const server = await fakeSmtp({ capabilities: ["AUTH LOGIN"] });
    const send = createSmtpSender({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      user: "postmaster",
      password: "secret",
      from: "accounts@dohc.test",
    });

    await send({ to: "person@example.com", subject: "Hi", text: "Body" });

    expect(server.transcript).toContain("AUTH LOGIN");
    expect(server.transcript).toContain(Buffer.from("postmaster").toString("base64"));
    expect(server.transcript).toContain(Buffer.from("secret").toString("base64"));
  });

  it("allows plaintext authentication only on loopback", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
    expect(isLoopback("smtp.example.com")).toBe(false);
    expect(isLoopback("10.0.0.4")).toBe(false);
  });

  it("rejects when the server refuses the recipient", async () => {
    const server = await fakeSmtp({ refuse: { command: "RCPT", reply: "550 5.1.1 no such user" } });
    const send = createSmtpSender({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      from: "accounts@dohc.test",
    });

    await expect(send({ to: "person@example.com", subject: "Hi", text: "Body" })).rejects.toThrow(
      /could not be delivered/,
    );
  });

  it("rejects an unreachable server rather than reporting a send", async () => {
    const server = await fakeSmtp();
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const send = createSmtpSender(
      { host: "127.0.0.1", port: server.port, secure: false, from: "accounts@dohc.test" },
      { timeoutMs: 2000 },
    );

    await expect(send({ to: "person@example.com", subject: "Hi", text: "Body" })).rejects.toBeInstanceOf(
      SmtpDeliveryError,
    );
  });

  it("rejects an address that is not an email address", async () => {
    const send = createSmtpSender({
      host: "127.0.0.1",
      port: 1,
      secure: false,
      from: "accounts@dohc.test",
    });
    await expect(send({ to: "not-an-address", subject: "Hi", text: "Body" })).rejects.toThrow(
      /is not an email address/,
    );
  });
});
