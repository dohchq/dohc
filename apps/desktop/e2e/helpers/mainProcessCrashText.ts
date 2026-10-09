import { stripVTControlCharacters } from "node:util";

export function mainProcessLogLines(record: (line: string) => void) {
  let remainder = "";
  return {
    chunk(text: string) {
      const lines = (remainder + text).split("\n");
      remainder = lines.pop()!;
      for (const line of lines) record(line.replace(/\r$/, ""));
    },
    end() {
      if (remainder) record(remainder);
      remainder = "";
    },
  };
}

export function mainProcessCrashText(
  logs: ReadonlyArray<{ source: string; level: string; text: string }>,
): string[] {
  const lines = logs
    .filter((entry) => entry.source === "main")
    .flatMap((entry) => entry.text.split(/\r?\n/).map(text => ({text, level: entry.level})));
  const caughtLines = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const head = stripVTControlCharacters(lines[i]!.text);
    if (!head.startsWith("[desktop] workspace engine capture ydoc settle of ") || !head.includes("[EngineClientError]")) continue;
    const transportCode = /\bcode:\s*['"]transport-error['"]/;
    if (transportCode.test(head)) {caughtLines.add(i); continue;}
    let end = i + 1;
    while (end < lines.length && lines[end]!.level === lines[i]!.level) {
      const line = stripVTControlCharacters(lines[end]!.text);
      if (!/^(\s|\}|$)/.test(line)) break;
      end++;
      if (line === "}") break;
    }
    if (transportCode.test(stripVTControlCharacters(lines.slice(i, end).map(line => line.text).join("\n")))) {
      for (let line = i; line < end; line++) caughtLines.add(line);
    }
  }
  return lines.filter(({text}, index) => {
      const plain = stripVTControlCharacters(text);
      if (/Uncaught Exception/i.test(plain) || /A JavaScript error occurred in the main process/i.test(plain)) return true;
      return /EPIPE/.test(plain) && !caughtLines.has(index);
    }).map(line => line.text);
}
