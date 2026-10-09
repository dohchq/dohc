import { stripVTControlCharacters } from "node:util";

export function mainProcessCrashText(
  logs: ReadonlyArray<{ source: string; level: string; text: string }>,
): string[] {
  return logs
    .filter((entry) => entry.source === "main")
    .map((entry) => entry.text)
    .filter((text) => {
      const plain = stripVTControlCharacters(text);
      if (/Uncaught Exception/i.test(plain) || /A JavaScript error occurred in the main process/i.test(plain)) return true;
      const caughtTransport = plain.startsWith("[desktop] workspace engine capture ydoc settle of ")
        && plain.includes("[EngineClientError]") && /\bcode:\s*['"]transport-error['"]/.test(plain);
      return /EPIPE/.test(plain) && !caughtTransport;
    });
}
