export class DohcCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DohcCliError";
  }
}

function cliErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.trim();
    const host = /\r?\nSession host: ([^\r\n]+)$/.exec(message);
    const words = (host ? message.slice(0, host.index) : message).replace(/[\r\n]+/g, " ").trim();
    return `${words}${host ? `\nSession host: ${host[1]}` : ""}`;
  }
  return "unexpected CLI failure";
}

export function cliErrorLine(error: unknown): string {
  const message = cliErrorMessage(error);
  return `${message.startsWith("dohc:") ? message : `dohc: ${message}`}\n`;
}
