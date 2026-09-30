// Expected [start, end) selection offsets for a 1-based line.
// The end excludes the newline. Lines past the end clamp to the last line.
export function lineSpanInText(
  text: string,
  line: number,
): { start: number; end: number } {
  let start = 0;
  let current = 1;
  while (current < line) {
    const nextBreak = text.indexOf("\n", start);
    if (nextBreak === -1) break;
    start = nextBreak + 1;
    current += 1;
  }
  const lineEnd = text.indexOf("\n", start);
  return { start, end: lineEnd === -1 ? text.length : lineEnd };
}
