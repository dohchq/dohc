// What a site's own dev and build commands are, and what they may not do.

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const HOST_BIND_FLAGS = new Set(["--host", "--hostname", "-H"]);

// Dev tools colorize the "Local: http://..." line whenever FORCE_COLOR reaches
// them. Vite bolds the port — "http://127.0.0.1:\x1b[1m5173\x1b[22m/" — which
// splits the URL at the escape and drops the port, loading a dead preview.
// eslint-disable-next-line no-control-regex
const ANSI_SGR_RE = /\u001B\[[0-9;]*m/g;
const DEV_URL_RE = /(http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?)/i;

export interface SiteCommand {
  command: string;
  args: string[];
}

/** The command a package manager runs one of its own scripts with. */
export function packageManagerCommand(manager: PackageManager, script: string): SiteCommand {
  if (manager === "npm") return { command: "npm", args: ["run", script] };
  if (manager === "yarn") return { command: "yarn", args: [script] };
  if (manager === "bun") return { command: "bun", args: ["run", script] };
  return { command: "pnpm", args: [script] };
}

/**
 * Splits a command line a site's `dohc.json` configured.
 *
 * dohc runs a file and passes argv entries; there is no shell. This is what
 * turns the one string an author wrote into that shape.
 */
export function splitCommandLine(commandLine: string): SiteCommand {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  // Backslash escapes on POSIX. On Windows it is the path separator, so
  // `node "C:\site\build.mjs"` has to keep its backslashes literal.
  const backslashEscapes = process.platform !== "win32";

  for (const char of commandLine.trim()) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (backslashEscapes && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }

  if (escaped) token += "\\";
  if (quote) throw new Error("Command contains an unterminated quote.");
  if (token) tokens.push(token);
  const [command, ...args] = tokens;
  if (!command) throw new Error("Command cannot be empty.");
  return { command, args };
}

function explicitHostBind(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const inlineHost = /^(?:--host|--hostname|-H)=(.+)$/i.exec(arg)?.[1];
    if (inlineHost !== undefined) return inlineHost;
    if (HOST_BIND_FLAGS.has(arg)) {
      const next = args[index + 1];
      return next && !next.startsWith("-") ? next : "";
    }
  }
  return null;
}

/**
 * Refuses a dev command that publishes the site past this machine.
 *
 * A preview is for the person who opened it. A `--host 0.0.0.0` in a site's
 * own scripts would put a workspace's contents on every network the machine
 * is on, so dohc does not start it.
 */
export function assertLoopbackOnlyCommand(command: string, args: readonly string[]): void {
  const host = explicitHostBind(args);
  if (host === null) return;
  if (host !== "" && isLoopbackHostname(host)) return;
  const displayHost = host === "" ? "all interfaces" : host;
  throw new Error(
    `A site dev server must bind to a loopback host, not ${displayHost}: ${[command, ...args].join(" ")}`,
  );
}

/** The first loopback URL a dev server prints, with ANSI colouring removed. */
export function detectDevUrl(text: string): string | null {
  const plain = text.replace(ANSI_SGR_RE, "");
  return DEV_URL_RE.exec(plain)?.[1]?.replace("[::1]", "127.0.0.1") ?? null;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = (
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
  ).toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    isIpv4Loopback(normalized) ||
    (normalized.startsWith("::ffff:") &&
      isIpv4MappedLoopback(normalized.slice("::ffff:".length)))
  );
}

function isIpv4MappedLoopback(suffix: string): boolean {
  if (isIpv4Loopback(suffix)) return true;
  const hextets = suffix.split(":");
  if (hextets.length !== 2 || !hextets.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) {
    return false;
  }
  const high = Number.parseInt(hextets[0]!, 16);
  const low = Number.parseInt(hextets[1]!, 16);
  return isIpv4Loopback([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
}

function isIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4 || octets[0] !== "127") return false;
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}
