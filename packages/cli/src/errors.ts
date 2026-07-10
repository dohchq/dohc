export class DohcCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DohcCliError";
  }
}

export function cliErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/[\r\n]+/g, " ").trim();
  }
  return "unexpected CLI failure";
}

export function cliErrorLine(error: unknown): string {
  const message = cliErrorMessage(error);
  return `${message.startsWith("dohc:") ? message : `dohc: ${message}`}\n`;
}
