import nodemailer from "nodemailer";
import { isIP } from "node:net";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export type SendEmail = (message: EmailMessage) => Promise<void>;

/**
 * The transport for a process that validates sessions but must never send
 * account email. It refuses loudly rather than dropping the message.
 */
export const refuseEmail: SendEmail = async () => {
  throw new SmtpDeliveryError("Account email delivery is not configured.");
};

export interface SmtpSettings {
  host: string;
  port: number;
  /** Implicit TLS from the first byte (submission port 465). */
  secure: boolean;
  user?: string;
  password?: string;
  /** `name@example.com` or `Name <name@example.com>`. */
  from: string;
}

/** An operator's SMTP configuration is unusable; the server must not start. */
export class SmtpConfigError extends Error {}

/** One message could not be delivered. */
export class SmtpDeliveryError extends Error {}

const ADDRESS = /^[^\s<>@,;:"\\]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const SMTP_ENV_KEYS = [
  "DOHC_SMTP_HOST",
  "DOHC_SMTP_PORT",
  "DOHC_SMTP_SECURE",
  "DOHC_SMTP_USER",
  "DOHC_SMTP_PASSWORD",
  "DOHC_SMTP_FROM",
] as const;

type SmtpEnv = Partial<Record<(typeof SMTP_ENV_KEYS)[number], string>>;

/**
 * Reads the SMTP settings an operator configured, or null when they
 * configured none. A partial or malformed configuration throws: a typo in one
 * variable must stop the server, not silently disable account email.
 */
export function smtpSettingsFromEnv(env: SmtpEnv): SmtpSettings | null {
  const value = (key: (typeof SMTP_ENV_KEYS)[number]): string | undefined => {
    const raw = key === "DOHC_SMTP_PASSWORD" ? env[key] : env[key]?.trim();
    return raw === undefined || raw.length === 0 ? undefined : raw;
  };
  if (!SMTP_ENV_KEYS.some((key) => value(key) !== undefined)) return null;

  const host = value("DOHC_SMTP_HOST");
  const port = value("DOHC_SMTP_PORT");
  const secure = value("DOHC_SMTP_SECURE");
  const from = value("DOHC_SMTP_FROM");
  const missing = (
    [
      ["DOHC_SMTP_HOST", host],
      ["DOHC_SMTP_PORT", port],
      ["DOHC_SMTP_SECURE", secure],
      ["DOHC_SMTP_FROM", from],
    ] as const
  )
    .filter(([, set]) => set === undefined)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new SmtpConfigError(`SMTP is partly configured. Set ${missing.join(", ")}.`);
  }

  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw new SmtpConfigError(`DOHC_SMTP_PORT must be a port number from 1 to 65535, got "${port}".`);
  }
  const flag = secure!.toLowerCase();
  if (!["true", "false"].includes(flag)) {
    throw new SmtpConfigError(`DOHC_SMTP_SECURE must be true or false, got "${secure}".`);
  }
  const user = value("DOHC_SMTP_USER");
  const password = value("DOHC_SMTP_PASSWORD");
  if ((user === undefined) !== (password === undefined)) {
    throw new SmtpConfigError("Set both DOHC_SMTP_USER and DOHC_SMTP_PASSWORD, or neither.");
  }
  if (!ADDRESS.test(mailbox(from!))) {
    throw new SmtpConfigError(
      `DOHC_SMTP_FROM must be an email address or "Name <name@example.com>", got "${from}".`,
    );
  }
  if (/[\r\n]/.test(from!)) throw new SmtpConfigError("DOHC_SMTP_FROM must be one line.");

  return {
    host: host!,
    port: portNumber,
    secure: flag === "true",
    from: from!,
    ...(user !== undefined ? { user, password: password! } : {}),
  };
}

export function createSmtpSender(settings: SmtpSettings, options: { timeoutMs?: number } = {}): SendEmail {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    requireTLS: !settings.secure && !isLoopback(settings.host),
    ...(settings.user !== undefined ? { auth: { user: settings.user, pass: settings.password! } } : {}),
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return async (message) => {
    if (!ADDRESS.test(mailbox(message.to)) || /[\r\n]/.test(message.to)) {
      throw new SmtpDeliveryError("The recipient is not an email address.");
    }
    try {
      await transport.sendMail({ from: settings.from, ...message });
    } catch {
      throw new SmtpDeliveryError("Account email could not be delivered. Check the SMTP connection, TLS, and credentials.");
    }
  };
}

export function isLoopback(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "::1" || (isIP(name) === 4 && name.startsWith("127."));
}

function mailbox(address: string): string {
  const angled = /<([^>]*)>\s*$/.exec(address.trim());
  return (angled ? angled[1]! : address).trim();
}
