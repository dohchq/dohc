export class DohcCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DohcCliError";
  }
}

function cliErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.trim();
    const host = /\r?\nServer: ([^\r\n]+)$/.exec(message);
    const words = (host ? message.slice(0, host.index) : message).replace(/[\r\n]+/g, " ").trim();
    return `${words}${host ? `\nServer: ${host[1]}` : ""}`;
  }
  return "unexpected CLI failure";
}

export function cliErrorLine(error: unknown): string {
  const message = cliErrorMessage(error);
  // A line that already starts with dohc, as "dohc: …" or a sentence such as "dohc could not…", names it once.
  return `${/^dohc[: ]/u.test(message) ? message : `dohc: ${message}`}\n`;
}
